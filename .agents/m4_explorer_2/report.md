# Milestone 4 Investigation & Architecture Report: TelegramPublisher Abstraction & Error Categorization

**Agent**: `m4_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Project**: Telegram Content Publisher Bot MVP  
**Target Milestone**: Milestone 4 — Publishing Engine & BullMQ Worker  
**Authoritative References**: `AGENTS.md` (§16, §17, §18, §20, §21, §22, §23, §25, §48, §49, §50, §65), `PROJECT.md` (§ Interface Contracts, § Feature Inventory F-30..F-36), `tasks.md` (§16, §18, §19, §20, §21, §22, §23), `tests/mocks/mock-telegram-publisher.ts`, `tests/harness/test-harness.ts`

---

## 1. Executive Summary

Milestone 4 introduces the background publishing pipeline powered by BullMQ, Redis, and PostgreSQL. A core architectural tenet (AGENTS.md §48) is **External API Isolation**: Telegram Bot API calls must never be scattered throughout business services, controllers, or handlers. Instead, all Telegram interactions are mediated by a unified abstraction: `ITelegramPublisher`.

This report provides the complete specification and structural designs for:
1. **`ITelegramPublisher` Interface**: A strongly typed transport interface supporting text, photos, videos, documents, animations, and media groups with polymorphic `chatId: string | bigint`.
2. **`TelegramPublisherService`**: Concrete implementation wrapping grammY's Bot API (`bot.api` or `new Api(token)`), seamlessly consuming canonical `TelegramPayload` from `TelegramRenderer`.
3. **Tri-Tier Error Categorization & Backoff Strategy**:
   - **Rate Limited (429)**: Extracts `retry_after` and signals BullMQ to schedule precise delayed retry.
   - **Retryable (5xx, Network)**: Transient gateway and network disconnects retried with exponential backoff.
   - **Permanent (400, 403)**: Client errors (chat not found, malformed entities, bot kicked) fail immediately via BullMQ `UnrecoverableError` without burning retries, directly transitioning the post to `PUBLISH_FAILED`.
4. **Testing Abstraction & Mock Double**: A stateful, hermetic double `MockTelegramPublisher` that is 100% backward compatible with the existing 34/34 passing E2E tests in `tests/e2e/` while offering full multi-media validation and failure simulation.
5. **Worker Architecture & Step-by-Step Implementation Roadmap**: Partial publication resumption (AGENTS.md §23), preflight verification, and database-level idempotency enforcement (`publish:{postId}:{postVersion}`).

---

## 2. Architecture & Dependency Boundary Analysis

### 2.1 Transport Separation & Worker Independence
According to `AGENTS.md` §65 and `PROJECT.md`:
```text
App Process (NestJS HTTP / Webhook / Polling)
   │
   ├─ PostWorkflowService (APPROVED)
   └─ PublishingService.enqueuePublish()
         │ creates DB job (publish:{postId}:{version})
         ▼
      BullMQ Queue ("publication")
         │
         ▼
Worker Process (src/worker.main.ts)
   │
   ├─ PublishingWorker (BullMQ Processor)
   ├─ Preflight Validation (Channel active, post status, chat_id)
   ├─ TelegramRenderer.render() -> TelegramPayload
   ├─ ITelegramPublisher (TelegramPublisherService)
   │     └─ grammY Api -> Telegram Bot API
   ├─ Partial Publication Persistence (telegram_message_ids in DB)
   ├─ Error Classifier -> BullMQ Delay / Backoff / UnrecoverableError
   └─ PostWorkflowService.transition(MARK_PUBLISHED | MARK_PUBLISH_FAILED)
```

**Key Architectural Invariant**: The publishing worker is a distinct process (`src/worker.main.ts`). It does NOT run a grammY Bot polling runner or webhook receiver. It exclusively consumes BullMQ jobs and interacts with Telegram Bot API via `Api` client instance.

---

## 3. ITelegramPublisher Interface Specification

The interface is placed in `src/infrastructure/telegram-api/interfaces/telegram-publisher.interface.ts`.

### 3.1 Design Principles
1. **Domain Identification**: `chatId: string | bigint`.
   - Channels in database store `telegramChatId: String` (e.g. `"-1001234567890"` or `"@channel_username"`).
   - Users store `telegramId: BigInt` (e.g. `123456789n`).
   - Both are accepted without casting hacks.
2. **Granular and Compositional**: Covers atomic methods (`sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, `sendMediaGroup`) AND higher-level dispatch method `publishOutgoingMessage` for executing canonical messages rendered by `TelegramRenderer`.
3. **Return Signatures**:
   - Single message methods return `Promise<number>` (Telegram `message_id`).
   - Media group method returns `Promise<number[]>` (array of Telegram `message_id`s in the album).
   - `publishOutgoingMessage` returns `Promise<number[]>`.
4. **Limits Adherence**: Inputs are strictly checked against `TELEGRAM_LIMITS` (caption $\le 1024$, message text $\le 4096$, media group 2..10 items).

### 3.2 TypeScript Definition

```ts
/**
 * src/infrastructure/telegram-api/interfaces/telegram-publisher.interface.ts
 * Authoritative reference: AGENTS.md § 16, § 17, § 18, § 48; tasks.md § 16, § 18
 */

import { TelegramOutgoingMessage } from '../../../modules/rendering/interfaces/telegram-payload.interface';

export const TELEGRAM_PUBLISHER = Symbol('ITelegramPublisher');

export interface SendTextOptions {
  parseMode?: 'HTML';
  disableWebPagePreview?: boolean;
}

export interface SendMediaOptions {
  caption?: string;
  parseMode?: 'HTML';
}

export interface SendDocumentOptions extends SendMediaOptions {
  fileName?: string;
  mimeType?: string;
}

export interface OutgoingMediaGroupItem {
  type: 'photo' | 'video' | 'document';
  fileId: string;
  caption?: string;
}

export enum TelegramErrorCategory {
  RATE_LIMITED = 'RATE_LIMITED', // 429 Too Many Requests -> delay retry
  RETRYABLE = 'RETRYABLE',       // 5xx, network timeouts -> exponential backoff
  PERMANENT = 'PERMANENT',       // 400, 403 -> fail fast, abort retries
}

export interface ITelegramPublisher {
  /**
   * Sends a standard HTML text message.
   * Text length must be <= 4096 characters.
   */
  sendMessage(
    chatId: string | bigint,
    text: string,
    options?: SendTextOptions,
  ): Promise<number>;

  /**
   * Sends a photo by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendPhoto(
    chatId: string | bigint,
    photoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends a video by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendVideo(
    chatId: string | bigint,
    videoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends an uncompressed document by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendDocument(
    chatId: string | bigint,
    documentFileId: string,
    options?: SendDocumentOptions,
  ): Promise<number>;

  /**
   * Sends an animation (GIF / H.264 without sound) by Telegram file_id.
   * Caption length must be <= 1024 characters.
   */
  sendAnimation(
    chatId: string | bigint,
    animationFileId: string,
    options?: SendMediaOptions,
  ): Promise<number>;

  /**
   * Sends a media group (album) containing 2 to 10 items.
   * Captions must be <= 1024 characters.
   * Returns array of message IDs for each item in the album.
   */
  sendMediaGroup(
    chatId: string | bigint,
    media: OutgoingMediaGroupItem[],
  ): Promise<number[]>;

  /**
   * Dispatches a single canonical TelegramOutgoingMessage part produced by TelegramRenderer.
   * Enables clean iteration and partial publishing resumption in the worker.
   */
  publishOutgoingMessage(
    chatId: string | bigint,
    message: TelegramOutgoingMessage,
  ): Promise<number[]>;

  /**
   * Classifies any error into RATE_LIMITED, RETRYABLE, or PERMANENT.
   */
  categorizeError(error: unknown): TelegramErrorCategory;

  /**
   * Returns true if error is retryable (429, 5xx, network timeout).
   */
  isRetryable(error: unknown): boolean;

  /**
   * Returns retry-after delay in seconds if error is 429 rate limit, else null.
   */
  getRetryDelay(error: unknown): number | null;
}
```

---

## 4. Error Categorization & Rate Limit Handling

### 4.1 Telegram Bot API Failure Taxonomy

| Category | HTTP Code | Typical Telegram Description / Cause | Action in BullMQ Worker |
|---|---|---|---|
| **RATE_LIMITED** | `429` | `Too Many Requests: retry after X`<br>`Flood control exceeded` | Extract `retry_after` seconds.<br>Delay BullMQ job by `retry_after * 1000` ms.<br>Job remains `PENDING`. |
| **RETRYABLE** | `500`<br>`502`<br>`503`<br>`504`<br>`0` (Network) | `Internal Server Error`<br>`Bad Gateway`<br>`Service Unavailable`<br>`Gateway Timeout`<br>`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED` | Standard BullMQ exponential backoff ($2s, 4s, 8s$).<br>If attempts < maxAttempts: retry.<br>If attempts exhausted: `PUBLISH_FAILED`. |
| **PERMANENT** | `400`<br>`401`<br>`403`<br>`404` | `chat not found`<br>`message is too long`<br>`can't parse entities: ...`<br>`wrong file identifier`<br>`need at least 2 items`<br>`bot was kicked from channel`<br>`bot is not administrator`<br>`not enough rights to send messages`<br>`Unauthorized` | **FAIL FAST** immediately.<br>Throw BullMQ `UnrecoverableError` (aborts all retries).<br>Transition post to `PUBLISH_FAILED`.<br>Record audit log.<br>Notify editor. |

### 4.2 Domain Exception Classes

Located in `src/infrastructure/telegram-api/errors/telegram-api.exceptions.ts`:

```ts
import { TelegramErrorCategory } from '../interfaces/telegram-publisher.interface';

export abstract class TelegramApiException extends Error {
  public abstract readonly category: TelegramErrorCategory;
  public readonly statusCode?: number;
  public readonly originalError?: unknown;

  constructor(message: string, statusCode?: number, originalError?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}

export class TelegramRateLimitException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.RATE_LIMITED;
  public readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, originalError?: unknown) {
    super(message, 429, originalError);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramRetryableException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.RETRYABLE;

  constructor(message: string, statusCode: number = 500, originalError?: unknown) {
    super(message, statusCode, originalError);
  }
}

export class TelegramPermanentException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.PERMANENT;

  constructor(message: string, statusCode: number = 400, originalError?: unknown) {
    super(message, statusCode, originalError);
  }
}
```

### 4.3 Robust Multi-Source Error Classifier

The classifier must handle errors originating from:
1. `grammy` (`GrammyError`, `HttpError`)
2. `TelegramApiError` (from existing test harness `tests/mocks/mock-telegram-publisher.ts`)
3. Standard Node.js network errors (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`)
4. Any arbitrary thrown exception

Located in `src/infrastructure/telegram-api/errors/telegram-error.classifier.ts`:

```ts
import { GrammyError, HttpError } from 'grammy';
import { TelegramErrorCategory } from '../interfaces/telegram-publisher.interface';
import {
  TelegramApiException,
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from './telegram-api.exceptions';

export interface ClassifiedTelegramError {
  category: TelegramErrorCategory;
  statusCode?: number;
  retryAfterSeconds: number | null;
  isPermanent: boolean;
  isRetryable: boolean;
  sanitizedMessage: string;
}

export class TelegramErrorClassifier {
  /**
   * Classifies any error into a structured classification result.
   */
  public static classify(error: unknown): ClassifiedTelegramError {
    // 1. Already a typed domain exception
    if (error instanceof TelegramRateLimitException) {
      return {
        category: TelegramErrorCategory.RATE_LIMITED,
        statusCode: 429,
        retryAfterSeconds: error.retryAfterSeconds,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: error.message,
      };
    }

    if (error instanceof TelegramRetryableException) {
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: error.statusCode,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: error.message,
      };
    }

    if (error instanceof TelegramPermanentException) {
      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: error.statusCode,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: error.message,
      };
    }

    // 2. grammY GrammyError (Telegram API response error)
    if (error instanceof GrammyError || (typeof error === 'object' && error !== null && 'error_code' in error)) {
      const gErr = error as { error_code: number; description?: string; parameters?: { retry_after?: number } };
      const code = gErr.error_code;
      const desc = gErr.description || 'Telegram API Error';

      if (code === 429) {
        const retryAfter = gErr.parameters?.retry_after ?? this.extractRetryAfterRegex(desc) ?? 5;
        return {
          category: TelegramErrorCategory.RATE_LIMITED,
          statusCode: 429,
          retryAfterSeconds: retryAfter,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: desc,
        };
      }

      if (code >= 500 && code < 600) {
        return {
          category: TelegramErrorCategory.RETRYABLE,
          statusCode: code,
          retryAfterSeconds: null,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: desc,
        };
      }

      // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found
      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: code,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: desc,
      };
    }

    // 3. grammY HttpError or Node.js Network / Socket Errors
    if (error instanceof HttpError || this.isNetworkError(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: 504,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: `Network Failure: ${msg}`,
      };
    }

    // 4. Test harness double TelegramApiError compatibility (duck-typing)
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const tErr = error as { statusCode: number; retryAfter?: number; isPermanent?: boolean; message?: string };
      const msg = tErr.message || 'Telegram Test Double Error';

      if (tErr.isPermanent) {
        return {
          category: TelegramErrorCategory.PERMANENT,
          statusCode: tErr.statusCode,
          retryAfterSeconds: null,
          isPermanent: true,
          isRetryable: false,
          sanitizedMessage: msg,
        };
      }

      if (tErr.statusCode === 429) {
        return {
          category: TelegramErrorCategory.RATE_LIMITED,
          statusCode: 429,
          retryAfterSeconds: tErr.retryAfter ?? 5,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: msg,
        };
      }

      if (tErr.statusCode >= 500 && tErr.statusCode < 600) {
        return {
          category: TelegramErrorCategory.RETRYABLE,
          statusCode: tErr.statusCode,
          retryAfterSeconds: null,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: msg,
        };
      }

      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: tErr.statusCode,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: msg,
      };
    }

    // 5. String inspection fallback
    const rawMsg = error instanceof Error ? error.message : String(error);
    if (/429|too many requests|retry after/i.test(rawMsg)) {
      const delay = this.extractRetryAfterRegex(rawMsg) ?? 5;
      return {
        category: TelegramErrorCategory.RATE_LIMITED,
        statusCode: 429,
        retryAfterSeconds: delay,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: rawMsg,
      };
    }

    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(rawMsg)) {
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: 504,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: rawMsg,
      };
    }

    // Default fallback: treat unclassified errors as PERMANENT to prevent indefinite retry loops (AGENTS.md §49)
    return {
      category: TelegramErrorCategory.PERMANENT,
      statusCode: 400,
      retryAfterSeconds: null,
      isPermanent: true,
      isRetryable: false,
      sanitizedMessage: rawMsg,
    };
  }

  private static isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: string }).code;
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
      return true;
    }
    return /connect timeout|network timeout|fetch failed|socket hang up/i.test(error.message);
  }

  private static extractRetryAfterRegex(message: string): number | null {
    const match = message.match(/retry after (\d+)/i);
    if (match && match[1]) {
      const sec = parseInt(match[1], 10);
      return Number.isNaN(sec) ? null : sec;
    }
    return null;
  }
}
```

---

## 5. Concrete TelegramPublisherService Implementation Design

Located in `src/infrastructure/telegram-api/telegram-publisher.service.ts`:

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Api } from 'grammy';
import { EnvironmentConfigService } from '../config/environment-config.service';
import { StructuredLoggerService } from '../logger/structured-logger.service';
import { TELEGRAM_LIMITS } from '../../common/constants/telegram-limits';
import {
  ITelegramPublisher,
  SendTextOptions,
  SendMediaOptions,
  SendDocumentOptions,
  OutgoingMediaGroupItem,
  TelegramErrorCategory,
} from './interfaces/telegram-publisher.interface';
import { TelegramOutgoingMessage } from '../../modules/rendering/interfaces/telegram-payload.interface';
import { TelegramErrorClassifier } from './errors/telegram-error.classifier';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from './errors/telegram-api.exceptions';

@Injectable()
export class TelegramPublisherService implements ITelegramPublisher, OnModuleInit {
  private api!: Api;

  constructor(
    private readonly config: EnvironmentConfigService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    const token = this.config.botToken;
    if (!token) {
      throw new Error('TelegramPublisherService requires BOT_TOKEN in EnvironmentConfigService');
    }
    this.api = new Api(token);
    this.logger.log({
      event: 'telegram_publisher_initialized',
      module: 'telegram-api',
    });
  }

  /**
   * Helper allowing unit tests or harnesses to inject a mock Api instance.
   */
  public setApi(api: Api): void {
    this.api = api;
  }

  private normalizeChatId(chatId: string | bigint): string | number {
    if (typeof chatId === 'bigint') {
      return chatId.toString();
    }
    const trimmed = chatId.trim();
    if (!trimmed) {
      throw new TelegramPermanentException('Chat ID cannot be empty', 400);
    }
    // If it is numeric string (e.g. "-1001234567890"), pass as string or number
    return trimmed;
  }

  async sendMessage(
    chatId: string | bigint,
    text: string,
    options?: SendTextOptions,
  ): Promise<number> {
    const targetChatId = this.normalizeChatId(chatId);
    if (!text || text.trim().length === 0) {
      throw new TelegramPermanentException('Message text cannot be empty', 400);
    }
    if (text.length > TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH) {
      throw new TelegramPermanentException(
        `Message text exceeds Telegram limit of ${TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH} characters (got ${text.length})`,
        400,
      );
    }

    try {
      const res = await this.api.sendMessage(targetChatId, text, {
        parse_mode: options?.parseMode || 'HTML',
        link_preview_options: options?.disableWebPagePreview ? { is_disabled: true } : undefined,
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendMessage', { chatId: targetChatId });
    }
  }

  async sendPhoto(
    chatId: string | bigint,
    photoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    const targetChatId = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    try {
      const res = await this.api.sendPhoto(targetChatId, photoFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendPhoto', { chatId: targetChatId, photoFileId });
    }
  }

  async sendVideo(
    chatId: string | bigint,
    videoFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    const targetChatId = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    try {
      const res = await this.api.sendVideo(targetChatId, videoFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendVideo', { chatId: targetChatId, videoFileId });
    }
  }

  async sendDocument(
    chatId: string | bigint,
    documentFileId: string,
    options?: SendDocumentOptions,
  ): Promise<number> {
    const targetChatId = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    try {
      const res = await this.api.sendDocument(targetChatId, documentFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendDocument', { chatId: targetChatId, documentFileId });
    }
  }

  async sendAnimation(
    chatId: string | bigint,
    animationFileId: string,
    options?: SendMediaOptions,
  ): Promise<number> {
    const targetChatId = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    try {
      const res = await this.api.sendAnimation(targetChatId, animationFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendAnimation', { chatId: targetChatId, animationFileId });
    }
  }

  async sendMediaGroup(
    chatId: string | bigint,
    media: OutgoingMediaGroupItem[],
  ): Promise<number[]> {
    const targetChatId = this.normalizeChatId(chatId);

    if (!Array.isArray(media) || media.length < TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE || media.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
      throw new TelegramPermanentException(
        `Media group must contain between ${TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE} and ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE} items (got ${media?.length})`,
        400,
      );
    }

    for (const item of media) {
      this.validateCaption(item.caption);
    }

    const inputMediaGroup = media.map((item) => ({
      type: item.type,
      media: item.fileId,
      caption: item.caption,
      parse_mode: 'HTML' as const,
    }));

    try {
      const res = await this.api.sendMediaGroup(targetChatId, inputMediaGroup);
      return res.map((m) => m.message_id);
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendMediaGroup', { chatId: targetChatId, count: media.length });
    }
  }

  async publishOutgoingMessage(
    chatId: string | bigint,
    message: TelegramOutgoingMessage,
  ): Promise<number[]> {
    switch (message.type) {
      case 'text': {
        const textContent = message.html || message.text || '';
        const id = await this.sendMessage(chatId, textContent, {
          parseMode: 'HTML',
          disableWebPagePreview: message.disableWebPagePreview,
        });
        return [id];
      }
      case 'photo': {
        const id = await this.sendPhoto(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'video': {
        const id = await this.sendVideo(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'document': {
        const id = await this.sendDocument(chatId, message.fileId!, {
          caption: message.caption,
          fileName: message.fileName,
          mimeType: message.mimeType,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'animation': {
        const id = await this.sendAnimation(chatId, message.fileId!, {
          caption: message.caption,
          parseMode: 'HTML',
        });
        return [id];
      }
      case 'media_group': {
        const items = message.items || [];
        return this.sendMediaGroup(chatId, items);
      }
      default:
        throw new TelegramPermanentException(`Unsupported outgoing message type: ${(message as { type: string }).type}`, 400);
    }
  }

  categorizeError(error: unknown): TelegramErrorCategory {
    return TelegramErrorClassifier.classify(error).category;
  }

  isRetryable(error: unknown): boolean {
    return TelegramErrorClassifier.classify(error).isRetryable;
  }

  getRetryDelay(error: unknown): number | null {
    return TelegramErrorClassifier.classify(error).retryAfterSeconds;
  }

  private validateCaption(caption?: string): void {
    if (caption && caption.length > TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
      throw new TelegramPermanentException(
        `Media caption exceeds Telegram limit of ${TELEGRAM_LIMITS.MAX_CAPTION_LENGTH} characters (got ${caption.length})`,
        400,
      );
    }
  }

  private wrapAndThrow(err: unknown, operation: string, meta: Record<string, unknown>): never {
    const classification = TelegramErrorClassifier.classify(err);
    this.logger.warn({
      event: 'telegram_api_call_failed',
      operation,
      category: classification.category,
      statusCode: classification.statusCode,
      retryAfter: classification.retryAfterSeconds,
      error: classification.sanitizedMessage,
      meta,
    });

    if (classification.category === TelegramErrorCategory.RATE_LIMITED) {
      throw new TelegramRateLimitException(
        classification.sanitizedMessage,
        classification.retryAfterSeconds ?? 5,
        err,
      );
    }

    if (classification.category === TelegramErrorCategory.RETRYABLE) {
      throw new TelegramRetryableException(
        classification.sanitizedMessage,
        classification.statusCode ?? 500,
        err,
      );
    }

    throw new TelegramPermanentException(
      classification.sanitizedMessage,
      classification.statusCode ?? 400,
      err,
    );
  }
}
```

---

## 6. Testing Abstraction & Mock Double Design

### 6.1 Compatibility with Existing Test Harness
The repository currently contains `tests/mocks/mock-telegram-publisher.ts` used by `tests/harness/test-harness.ts` and verified by 34 E2E tests across 4 tiers.

To maintain **100% backward compatibility** while implementing the full `ITelegramPublisher` interface:
1. `MockTelegramPublisher` accepts `chatId: string | bigint`.
2. Existing methods `sendMediaGroup` and `sendMessage` keep identical signatures and return values.
3. Added methods:
   - `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`
   - `publishOutgoingMessage`
   - `categorizeError`
4. Failure simulation helpers (`simulateTransientFailures`, `simulateRateLimit`, `simulatePermanentFailure`, `resetFailures`) continue to work seamlessly.

### 6.2 Upgraded Mock Implementation

```ts
/**
 * tests/mocks/mock-telegram-publisher.ts
 * Implements ITelegramPublisher for hermetic CI/CD and unit testing without real Telegram tokens.
 */

import {
  ITelegramPublisher,
  SendTextOptions,
  SendMediaOptions,
  SendDocumentOptions,
  OutgoingMediaGroupItem,
  TelegramErrorCategory,
} from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import { TelegramOutgoingMessage } from '../../src/modules/rendering/interfaces/telegram-payload.interface';
import { TelegramErrorClassifier } from '../../src/infrastructure/telegram-api/errors/telegram-error.classifier';
import { TELEGRAM_LIMITS } from '../../src/common/constants/telegram-limits';

export interface RecordedTelegramMessage {
  messageId: number;
  chatId: string;
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;
  fileId?: string;
  caption?: string;
  media?: OutgoingMediaGroupItem[];
  options?: SendTextOptions | SendMediaOptions;
  sentAt: Date;
}

export class TelegramApiError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter?: number;
  public readonly isPermanent: boolean;

  constructor(message: string, statusCode: number, retryAfter?: number, isPermanent: boolean = false) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.isPermanent = isPermanent;
  }
}

export class MockTelegramPublisher implements ITelegramPublisher {
  private currentMessageId = 1000;
  private sentMessages: RecordedTelegramMessage[] = [];

  private transientFailuresRemaining = 0;
  private transientFailureError: Error | null = null;
  private rateLimitRemaining = 0;
  private rateLimitRetryAfter = 5;
  private permanentFailure: Error | null = null;

  private normalizeChatId(chatId: string | bigint): string {
    const s = typeof chatId === 'bigint' ? chatId.toString() : String(chatId).trim();
    if (!s) {
      throw new TelegramApiError('Bad Request: chat_id is empty', 400, undefined, true);
    }
    return s;
  }

  async sendMessage(chatId: string | bigint, text: string, options?: SendTextOptions): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);

    if (!text || text.trim() === '') {
      throw new TelegramApiError('Bad Request: message text is empty', 400, undefined, true);
    }
    if (text.length > TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH) {
      throw new TelegramApiError(`Bad Request: message text exceeds ${TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH} characters`, 400, undefined, true);
    }

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'text',
      text,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendPhoto(chatId: string | bigint, photoFileId: string, options?: SendMediaOptions): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'photo',
      fileId: photoFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendVideo(chatId: string | bigint, videoFileId: string, options?: SendMediaOptions): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'video',
      fileId: videoFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendDocument(chatId: string | bigint, documentFileId: string, options?: SendDocumentOptions): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'document',
      fileId: documentFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendAnimation(chatId: string | bigint, animationFileId: string, options?: SendMediaOptions): Promise<number> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);
    this.validateCaption(options?.caption);

    this.currentMessageId += 1;
    const msgId = this.currentMessageId;

    this.sentMessages.push({
      messageId: msgId,
      chatId: targetChat,
      type: 'animation',
      fileId: animationFileId,
      caption: options?.caption,
      options,
      sentAt: new Date(),
    });

    return msgId;
  }

  async sendMediaGroup(chatId: string | bigint, media: OutgoingMediaGroupItem[]): Promise<number[]> {
    this.checkSimulatedFailures();
    const targetChat = this.normalizeChatId(chatId);

    if (!Array.isArray(media) || media.length < TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE || media.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
      throw new TelegramApiError(
        `Bad Request: media group must contain between ${TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE} and ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE} items (got ${media?.length})`,
        400,
        undefined,
        true,
      );
    }

    for (const item of media) {
      this.validateCaption(item.caption);
    }

    const assignedIds: number[] = [];
    for (let i = 0; i < media.length; i++) {
      this.currentMessageId += 1;
      assignedIds.push(this.currentMessageId);
    }

    this.sentMessages.push({
      messageId: assignedIds[0],
      chatId: targetChat,
      type: 'media_group',
      media,
      sentAt: new Date(),
    });

    return assignedIds;
  }

  async publishOutgoingMessage(chatId: string | bigint, message: TelegramOutgoingMessage): Promise<number[]> {
    switch (message.type) {
      case 'text':
        return [await this.sendMessage(chatId, message.html || message.text || '', { parseMode: 'HTML' })];
      case 'photo':
        return [await this.sendPhoto(chatId, message.fileId!, { caption: message.caption, parseMode: 'HTML' })];
      case 'video':
        return [await this.sendVideo(chatId, message.fileId!, { caption: message.caption, parseMode: 'HTML' })];
      case 'document':
        return [await this.sendDocument(chatId, message.fileId!, { caption: message.caption, parseMode: 'HTML' })];
      case 'animation':
        return [await this.sendAnimation(chatId, message.fileId!, { caption: message.caption, parseMode: 'HTML' })];
      case 'media_group':
        return this.sendMediaGroup(chatId, message.items || []);
      default:
        throw new TelegramApiError(`Unsupported message type: ${(message as { type: string }).type}`, 400, undefined, true);
    }
  }

  categorizeError(error: unknown): TelegramErrorCategory {
    return TelegramErrorClassifier.classify(error).category;
  }

  isRetryable(error: unknown): boolean {
    return TelegramErrorClassifier.classify(error).isRetryable;
  }

  getRetryDelay(error: unknown): number | null {
    return TelegramErrorClassifier.classify(error).retryAfterSeconds;
  }

  // --- Simulation Helpers ---
  simulateTransientFailures(count: number, error?: Error): void {
    this.transientFailuresRemaining = count;
    this.transientFailureError = error || new TelegramApiError('Internal Server Error (Simulated 500)', 500);
  }

  simulateRateLimit(count: number, retryAfterSeconds: number = 2): void {
    this.rateLimitRemaining = count;
    this.rateLimitRetryAfter = retryAfterSeconds;
  }

  simulatePermanentFailure(error: Error): void {
    this.permanentFailure = error;
  }

  resetFailures(): void {
    this.transientFailuresRemaining = 0;
    this.transientFailureError = null;
    this.rateLimitRemaining = 0;
    this.permanentFailure = null;
  }

  getSentMessages(chatId?: string): RecordedTelegramMessage[] {
    if (chatId) return this.sentMessages.filter((m) => m.chatId === chatId);
    return [...this.sentMessages];
  }

  getLastMessage(): RecordedTelegramMessage | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  clear(): void {
    this.sentMessages = [];
    this.resetFailures();
  }

  private validateCaption(caption?: string): void {
    if (caption && caption.length > TELEGRAM_LIMITS.MAX_CAPTION_LENGTH) {
      throw new TelegramApiError(`Bad Request: media caption exceeds ${TELEGRAM_LIMITS.MAX_CAPTION_LENGTH} characters`, 400, undefined, true);
    }
  }

  private checkSimulatedFailures(): void {
    if (this.permanentFailure) throw this.permanentFailure;
    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining -= 1;
      throw new TelegramApiError(`Too Many Requests: retry after ${this.rateLimitRetryAfter}`, 429, this.rateLimitRetryAfter);
    }
    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      throw this.transientFailureError || new TelegramApiError('Simulated Gateway Timeout', 504);
    }
  }
}
```

---

## 7. Publishing Worker & BullMQ Integration Architecture

### 7.1 Job Payload Data Contract
```ts
export interface PublishJobData {
  jobId: string;       // DB publication_jobs.id (UUID)
  postId: string;      // DB posts.id (UUID)
  version: number;     // Post OCC version when queued
  channelId: string;   // DB channels.id (UUID)
  actorId: string;     // Actor who enqueued
}
```

### 7.2 Idempotency Key Invariant
Database enforces uniqueness on `publication_jobs.idempotency_key` via `@unique`:
`idempotencyKey = "publish:" + postId + ":" + postVersion`
BullMQ also sets `jobId: idempotencyKey`. If a user spams "Publish", BullMQ deduplicates in Redis, and `PublishingService` queries PostgreSQL first, ensuring exactly one job row is created.

### 7.3 Partial Publication Resumption Algorithm (AGENTS.md §23, tasks.md §23)

When a post requires multiple Telegram API calls (e.g. `sendMediaGroup` followed by `sendMessage` for text >1024 chars):
1. Load `existingMessageIds = (job.telegramMessageIds as number[]) || []`.
2. Compute rendered `payload = await this.renderer.render(post, template, media)`.
3. Iterate through `payload.messages`:
   - Calculate how many message IDs were expected by preceding parts.
   - If `existingMessageIds.length > precedingIds`: **SKIP** this part! It was already sent successfully in an earlier attempt.
   - If not yet sent:
     - Invoke `const newIds = await this.telegramPublisher.publishOutgoingMessage(channel.telegramChatId, message)`.
     - Atomically append `newIds` to `job.telegramMessageIds` in PostgreSQL via Prisma:
       ```ts
       existingMessageIds.push(...newIds);
       await this.prisma.publicationJob.update({
         where: { id: job.id },
         data: { telegramMessageIds: existingMessageIds },
       });
       ```
     - If this call throws, the already-sent IDs are **safely preserved in PostgreSQL**.
4. When all parts succeed, transition post to `PUBLISHED` and complete the job.

### 7.4 BullMQ Processor Error Handling Workflow

```text
Worker processes publish job
    │
    ├─ Preflight Check fails (post deleted, channel deactivated, invalid chat)
    │     │
    │     ▼
    │   Fail Fast:
    │   - Update DB job -> FAILED
    │   - PostWorkflowService.transition -> PUBLISH_FAILED
    │   - throw new UnrecoverableError() (halts BullMQ retries)
    │
    ├─ Telegram API Error thrown
    │     │
    │     ▼
    │   TelegramErrorClassifier.classify(error)
    │     │
    │     ├─ category === PERMANENT (400, 403)
    │     │     ▼
    │     │   Fail Fast:
    │     │   - Update DB job -> FAILED
    │     │   - PostWorkflowService.transition -> PUBLISH_FAILED
    │     │   - throw new UnrecoverableError()
    │     │
    │     ├─ category === RATE_LIMITED (429)
    │     │     ▼
    │     │   Delay Retry:
    │     │   - Update DB job -> PENDING, attempts++, errorMessage
    │     │   - Delay next BullMQ attempt by (retryAfterSeconds * 1000) ms
    │     │     via custom backoff strategy or job.moveToDelayed()
    │     │
    │     └─ category === RETRYABLE (5xx, Network)
    │           ▼
    │         Check attemptCount vs maxAttempts (3):
    │           ├─ attempts < maxAttempts:
    │           │     - Update DB job -> PENDING, attempts++, errorMessage
    │           │     - Re-throw error -> BullMQ applies exponential backoff
    │           └─ attempts >= maxAttempts:
    │                 - Exhausted!
    │                 - Update DB job -> FAILED
    │                 - PostWorkflowService.transition -> PUBLISH_FAILED
    │                 - Audit log: publication_failed
    │                 - Notify Editor
```

---

## 8. Step-by-Step Implementation Roadmap for Milestone 4

The implementer/builder agents should execute Milestone 4 in the following sequential order:

### Step 1: Create `src/infrastructure/telegram-api/` Module
1. Create `interfaces/telegram-publisher.interface.ts`:
   - Define `ITelegramPublisher`, `TELEGRAM_PUBLISHER`, `TelegramErrorCategory`, and options interfaces.
2. Create `errors/telegram-api.exceptions.ts`:
   - Implement `TelegramApiException`, `TelegramRateLimitException`, `TelegramRetryableException`, `TelegramPermanentException`.
3. Create `errors/telegram-error.classifier.ts`:
   - Implement `TelegramErrorClassifier.classify(error)` with full type guards and duck-typing support.
4. Create `telegram-publisher.service.ts`:
   - Implement `TelegramPublisherService` using grammY `Api`.
5. Create `telegram-api.module.ts`:
   - Register `TelegramPublisherService` and export token `TELEGRAM_PUBLISHER`.
6. Create `index.ts` to export all public components.

### Step 2: Update `tests/mocks/mock-telegram-publisher.ts`
1. Implement `ITelegramPublisher` on `MockTelegramPublisher`.
2. Add `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, `publishOutgoingMessage`, and error categorization methods.
3. Run `node --test --experimental-strip-types tests/e2e/*.spec.ts` to verify 100% regression safety (34/34 passing).

### Step 3: Create `src/modules/publishing/` Module
1. Create `dto/enqueue-publish.dto.ts` and `interfaces/publishing.interfaces.ts`.
2. Create `publishing.service.ts`:
   - `enqueuePublish(postId: string, actorId: string)`:
     - Check permissions (`canPublish` or `SUPER_ADMIN`).
     - Check post status (`APPROVED` or `PUBLISH_FAILED` for manual retry).
     - Construct idempotency key `publish:{postId}:{version}`.
     - Create or get existing `PublicationJob` in DB (`status = PENDING`).
     - Enqueue into BullMQ with `jobId: idempotencyKey`.
     - Return `PublicationJob`.
3. Create `publishing.worker.ts` (`@Processor(PUBLICATION_QUEUE_NAME)`):
   - `@Process(JOB_NAMES.PUBLISH_POST)`
   - Preflight validation.
   - OCC status update: `PostStatus.PUBLISHING`.
   - Canonical rendering via `TelegramRenderer.render(post, template, media)`.
   - Partial publishing loop with atomic DB updates to `telegramMessageIds`.
   - On completion: `PostAction.MARK_PUBLISHED`.
   - On error: `TelegramErrorClassifier`, `UnrecoverableError` for permanent errors, exponential backoff for retryable errors, and delay for rate limits.
4. Create `publishing.module.ts` and wire into `src/app.module.ts` and `src/worker.module.ts`.

### Step 4: Add Unit & Integration Tests
1. Unit tests for `TelegramErrorClassifier`:
   - Test 429 extraction, 5xx retryable, 400/403 permanent, network timeouts.
2. Unit tests for `TelegramPublisherService`:
   - Mock grammY `Api`, verify call translation, limits validation, and exception re-wrapping.
3. Integration tests for `PublishingService` & `PublishingWorker`:
   - Verify idempotency, partial publishing resume, rate limiting backoff, and retry exhaustion.

---

## 9. Conclusion
This design provides a clean, robust, and spec-compliant architecture for Milestone 4. It strictly enforces separation between transport and business logic, guarantees safe partial publishing resumption, honors Telegram rate limits, fails fast on permanent configuration or permission errors, and seamlessly preserves compatibility with the existing test infrastructure.
