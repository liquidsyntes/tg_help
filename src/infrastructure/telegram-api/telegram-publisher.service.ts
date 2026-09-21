/**
 * TelegramPublisherService
 * Concrete production implementation of ITelegramPublisher wrapping grammY's Bot Api.
 * Authoritative reference: AGENTS.md § 16, § 17, § 18, § 48, § 49, § 50; tasks.md § 16, § 18
 */

import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { Api, InputMediaBuilder } from 'grammy';
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
  private api?: Api;

  constructor(
    @Optional() private readonly config?: EnvironmentConfigService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    const token = this.config?.botToken;
    if (token) {
      this.api = new Api(token);
      this.logger?.log({
        event: 'telegram_publisher_initialized',
        module: 'telegram-api',
      });
    }
  }

  /**
   * Helper allowing unit tests or harnesses to inject a mock/custom Api instance.
   */
  public setApi(api: Api): void {
    this.api = api;
  }

  private getApi(): Api {
    if (!this.api) {
      const token = this.config?.botToken;
      if (token) {
        this.api = new Api(token);
      } else {
        throw new TelegramPermanentException(
          'TelegramPublisherService: BOT_TOKEN is not configured and no Api instance was provided.',
          400,
        );
      }
    }
    return this.api;
  }

  private normalizeChatId(chatId: string | bigint): string | number {
    if (typeof chatId === 'bigint') {
      return chatId.toString();
    }
    const trimmed = String(chatId).trim();
    if (!trimmed) {
      throw new TelegramPermanentException('Chat ID cannot be empty', 400);
    }
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
      const res = await this.getApi().sendMessage(targetChatId, text, {
        parse_mode: options?.parseMode || 'HTML',
        link_preview_options: options?.disableWebPagePreview ? { is_disabled: true } : undefined,
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendMessage', { chatId: String(targetChatId) });
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
      const res = await this.getApi().sendPhoto(targetChatId, photoFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendPhoto', { chatId: String(targetChatId), photoFileId });
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
      const res = await this.getApi().sendVideo(targetChatId, videoFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendVideo', { chatId: String(targetChatId), videoFileId });
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
      const res = await this.getApi().sendDocument(targetChatId, documentFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendDocument', { chatId: String(targetChatId), documentFileId });
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
      const res = await this.getApi().sendAnimation(targetChatId, animationFileId, {
        caption: options?.caption,
        parse_mode: options?.parseMode || 'HTML',
      });
      return res.message_id;
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendAnimation', { chatId: String(targetChatId), animationFileId });
    }
  }

  async sendMediaGroup(
    chatId: string | bigint,
    media: OutgoingMediaGroupItem[],
  ): Promise<number[]> {
    const targetChatId = this.normalizeChatId(chatId);

    if (
      !Array.isArray(media) ||
      media.length < TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE ||
      media.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE
    ) {
      throw new TelegramPermanentException(
        `Media group must contain between ${TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE} and ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE} items (got ${media?.length})`,
        400,
      );
    }

    for (const item of media) {
      this.validateCaption(item.caption);
    }

    const hasDocument = media.some((m) => m.type === 'document');
    try {
      if (hasDocument) {
        const docGroup = media.map((item) =>
          InputMediaBuilder.document(item.fileId, {
            caption: item.caption,
            parse_mode: 'HTML',
          }),
        );
        const res = await this.getApi().sendMediaGroup(targetChatId, docGroup);
        return res.map((m) => m.message_id);
      } else {
        const visualGroup = media.map((item) => {
          if (item.type === 'video') {
            return InputMediaBuilder.video(item.fileId, {
              caption: item.caption,
              parse_mode: 'HTML',
            });
          }
          return InputMediaBuilder.photo(item.fileId, {
            caption: item.caption,
            parse_mode: 'HTML',
          });
        });
        const res = await this.getApi().sendMediaGroup(targetChatId, visualGroup);
        return res.map((m) => m.message_id);
      }
    } catch (err) {
      throw this.wrapAndThrow(err, 'sendMediaGroup', { chatId: String(targetChatId), count: media.length });
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
        const items = (message.items || []).map((i) => ({
          type: i.type,
          fileId: i.fileId,
          caption: i.caption,
        }));
        return this.sendMediaGroup(chatId, items);
      }
      default:
        throw new TelegramPermanentException(
          `Unsupported outgoing message type: ${(message as { type: string }).type}`,
          400,
        );
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
    this.logger?.warn({
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
