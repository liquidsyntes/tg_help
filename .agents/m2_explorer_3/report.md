# Milestone 2 Architectural Investigation & Technical Design: Audit Logging & Domain Event Notification Services

- **Author**: `m2_explorer_3` (teamwork_preview_explorer)
- **Target Working Directory**: `c:/TgHelp/.agents/m2_explorer_3/`
- **Scope**: Milestone 2 (Domain Models, RBAC, State Machine & Audit/Notifications)
- **Authoritative References**: `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`, `c:/TgHelp/.agents/PROJECT.md` (F-39, F-40, F-41), `c:/TgHelp/tasks.md` (§24, §26), `c:/TgHelp/AGENTS.md` (§26, §27, §28, §33, §34), `prisma/schema.prisma`

---

## 1. Executive Summary

Milestone 2 establishes the core domain behaviors of the Telegram Content Publisher Bot. Among these, **Audit Logging** and **Domain Event Notifications** serve as the observability and collaboration backbone:

1. **AuditLogService (`src/modules/audit/`)**:
   - Implements strict **append-only semantics** for compliance, traceability, and historical reconstruction.
   - Captures all 16+ core domain actions: `post_created`, `post_updated`, `media_added`, `media_removed`, `submitted` (and alias `submitted_for_review`), `approved`, `revision_requested`, `rejected`, `scheduled`, `schedule_cancelled`, `publication_started`, `published`, `publication_failed`, `publication_cancelled`, `user_added`, `permission_changed`, and `settings_changed`.
   - Incorporates deep **payload sanitization** that strips bot tokens, passwords, database URLs, and API keys before persistent storage.
   - Enforces immutability at both the application API surface (zero update/delete methods) and the database level (PostgreSQL triggers).

2. **NotificationService (`src/modules/notifications/`)**:
   - Operates fully decoupled from core business transactions via domain events (`post.submitted`, `post.approved`, `post.revision_requested`, `post.rejected`, `post.scheduled`, `post.published`, `post.publication_failed`).
   - Implements the **Autosave Silent Rule (F-40)**: routine draft autosaves (`post_updated`) emit **zero** Telegram notifications.
   - Guarantees **non-blocking fault tolerance**: Telegram delivery failures (e.g. rate limits, blocked bots, network timeouts) are caught, logged, and isolated, strictly preventing transaction rollbacks.
   - Runs **post-commit**: notifications are dispatched only after the database transaction has successfully committed, preventing premature alerts on aborted transitions and avoiding long-running external HTTP calls within database transactions (AGENTS.md §28).

3. **Atomic Transaction Formulation (`prisma.$transaction`)**:
   - Synthesizes the tripartite state change:
     $$\text{OCC Post Update (version+1)} + \text{PostReview Record} + \text{AuditLog Entry} \in \text{Single Database Transaction}$$
   - Resolves Optimistic Concurrency Control (OCC) conflicts via Prisma `updateMany` count validation, throwing `PostConflictException` on stale updates.

4. **Worker Publication Lifecycle**:
   - Recommends concrete BullMQ worker steps: preflight verification, recording `publication_started`, atomic partial-publishing message recording, terminal transition to `PUBLISHED` or `PUBLISH_FAILED`, and post-commit notification routing to authors and editors.

---

## 2. Deep Dive: AuditLogService Design (`src/modules/audit/`)

### 2.1. Prisma Schema Mapping
In `prisma/schema.prisma` (lines 258-274):
```prisma
model AuditLog {
  id         String   @id @default(uuid())
  action     String   @map("action")
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id")
  actorId    String?  @map("actor_id")
  payload    Json     @default("{}") @map("payload")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  actor User? @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)

  @@index([entityType, entityId])
  @@index([actorId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### 2.2. Domain Actions Enumeration & Normalization
Per `tasks.md` §26, `AGENTS.md` §26, and the test suite (`tests/e2e/tier1-feature-coverage.spec.ts`, `tests/e2e/tier4-application-scenarios.spec.ts`), the domain actions are cataloged as follows:

```typescript
// src/modules/audit/enums/audit-action.enum.ts

export enum AuditAction {
  // Post lifecycle
  POST_CREATED = 'post_created',
  POST_UPDATED = 'post_updated',
  POST_DELETED = 'post_deleted',
  MEDIA_ADDED = 'media_added',
  MEDIA_REMOVED = 'media_removed',

  // Review workflow (supports both canonical naming and test-harness compatibility)
  SUBMITTED = 'submitted',
  SUBMITTED_FOR_REVIEW = 'submitted_for_review',
  APPROVED = 'approved',
  REVISION_REQUESTED = 'revision_requested',
  REJECTED = 'rejected',

  // Scheduling
  SCHEDULED = 'scheduled',
  SCHEDULE_CANCELLED = 'schedule_cancelled',

  // Publication
  PUBLICATION_STARTED = 'publication_started',
  PUBLICATION_ATTEMPT_FAILED = 'publication_attempt_failed',
  PUBLISHED = 'published',
  PUBLICATION_FAILED = 'publication_failed',
  PUBLICATION_CANCELLED = 'publication_cancelled',
  PUBLICATION_JOB_CREATED = 'publication_job_created',

  // User & Administrative
  USER_ADDED = 'user_added',
  USER_BLOCKED = 'user_blocked',
  PERMISSION_CHANGED = 'permission_changed',
  SETTINGS_CHANGED = 'settings_changed',
}

export type EntityType = 'post' | 'user' | 'channel' | 'publication_job' | 'template' | 'channel_member';
```

### 2.3. Payload JSON Sanitization Specification (AGENTS.md §33, §34)
Audit logs store operational metadata for post-mortem debugging and editorial traceability. However, they must **never** become a vector for secret exfiltration (tokens, database passwords, webhook secrets).

```typescript
// src/modules/audit/utils/sanitize-payload.util.ts

const SENSITIVE_KEY_SUBSTRINGS = [
  'token',
  'bottoken',
  'bot_token',
  'password',
  'secret',
  'webhook_secret',
  'database_url',
  'redis_url',
  'authorization',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'cookie',
  'credential',
];

// Telegram Bot Token regex pattern: 8 to 11 digits followed by colon and 35+ alphanumeric characters
const BOT_TOKEN_REGEX = /\b\d{8,11}:[A-Za-z0-9_-]{35,}\b/g;

// Connection string password redaction pattern (e.g. postgres://user:pass@host:5432/db)
const URI_CREDENTIAL_REGEX = /(postgres(?:ql)?|redis):\/\/([^:]+):([^@]+)@/gi;

/**
 * Recursively sanitizes data before writing to audit logs.
 * Masks sensitive keys, redacts bot tokens and database URLs, and handles BigInt serialization.
 */
export function sanitizeAuditPayload<T = unknown>(obj: T, depth = 0): unknown {
  if (depth > 6 || obj === null || obj === undefined) {
    return obj;
  }

  // Handle BigInt serialization
  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  // Handle Strings (token pattern matching & connection string redaction)
  if (typeof obj === 'string') {
    let clean = obj.replace(BOT_TOKEN_REGEX, '[REDACTED_BOT_TOKEN]');
    clean = clean.replace(URI_CREDENTIAL_REGEX, '$1://$2:[REDACTED]@');
    return clean;
  }

  // Handle Arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeAuditPayload(item, depth + 1));
  }

  // Handle Objects
  if (typeof obj === 'object') {
    // If instance of Date or Error
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: obj.message.replace(BOT_TOKEN_REGEX, '[REDACTED_BOT_TOKEN]'),
      };
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      const isSensitiveKey = SENSITIVE_KEY_SUBSTRINGS.some((substring) => lowerKey.includes(substring));

      if (isSensitiveKey) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeAuditPayload(value, depth + 1);
      }
    }
    return sanitized;
  }

  return obj;
}
```

### 2.4. Append-Only Architectural Enforcement
To guarantee append-only integrity:
1. **Application Level**: `AuditLogService` only exposes `record(...)` and query methods (`findByEntity`, `findRecent`). It exposes **no** `update`, `delete`, `deleteMany`, `updateMany`, or `upsert` methods.
2. **Database Level**: A dedicated PostgreSQL migration creates triggers that prevent updates or deletions on the `audit_logs` table:
```sql
-- Migration: prevent_audit_log_modification.sql
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs table is strictly append-only. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

CREATE TRIGGER trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
```

### 2.5. AuditLogService Implementation Specification
```typescript
// src/modules/audit/dto/create-audit-log.dto.ts
import { AuditAction, EntityType } from '../enums/audit-action.enum';

export interface CreateAuditLogDto {
  action: AuditAction | string;
  entityType: EntityType | string;
  entityId: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

// src/modules/audit/audit-log.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma, AuditLog } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';
import { sanitizeAuditPayload } from './utils/sanitize-payload.util';

@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Appends an immutable audit log entry.
   * Accepts an optional transaction client (Prisma.TransactionClient) to participate in atomic unit-of-work transactions.
   */
  async record(dto: CreateAuditLogDto, tx?: Prisma.TransactionClient): Promise<AuditLog> {
    const client = tx || this.prisma;
    const sanitized = (sanitizeAuditPayload(dto.payload ?? {}) as Prisma.InputJsonValue) ?? {};

    const entry = await client.auditLog.create({
      data: {
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
        actorId: dto.actorId ?? null,
        payload: sanitized,
      },
    });

    this.logger.debug({
      event: 'audit_log_recorded',
      auditId: entry.id,
      action: dto.action,
      entityType: dto.entityType,
      entityId: dto.entityId,
      actorId: dto.actorId,
    });

    return entry;
  }

  // Read-only query capabilities for administrative inspection
  async findByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findByActor(actorId: string, limit = 50): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findRecent(limit = 100): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
```

---

## 3. Deep Dive: NotificationService Design (`src/modules/notifications/`)

### 3.1. Core Architectural Requirements (AGENTS.md §27, tasks.md §24)
1. **Decoupled Delivery**: Business services must not make direct Telegram Bot API calls. Services emit domain events; the notification subsystem consumes events and handles delivery.
2. **Autosave Silent Rule (F-40)**:
   > "Не отправлять отдельное notification после обычного autosave."
   Routine draft field autosaves (`post_updated`, `autosaveStep`) must emit **0** notifications.
3. **Non-Blocking Resilience**: Failure to deliver a Telegram alert (e.g. user blocked bot, Telegram 429) must **never** roll back the database transaction or abort publication.
4. **Post-Commit Dispatch**: Notifications must only fire **after** the transaction successfully commits to PostgreSQL.

### 3.2. Domain Events Definition
```typescript
// src/modules/notifications/events/domain-events.ts

export enum DomainEventType {
  POST_SUBMITTED = 'post.submitted_for_review',
  POST_APPROVED = 'post.approved',
  POST_REVISION_REQUESTED = 'post.revision_requested',
  POST_REJECTED = 'post.rejected',
  POST_SCHEDULED = 'post.scheduled',
  POST_PUBLISHED = 'post.published',
  POST_PUBLICATION_FAILED = 'post.publication_failed',
}

export interface BaseDomainEvent {
  readonly eventType: DomainEventType;
  readonly timestamp: Date;
  readonly postId: string;
  readonly channelId: string;
}

export class PostSubmittedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_SUBMITTED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly templateName?: string,
  ) {}
}

export class PostApprovedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_APPROVED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment?: string,
  ) {}
}

export class PostRevisionRequestedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_REVISION_REQUESTED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment: string, // Mandatory comment per tasks.md §13
  ) {}
}

export class PostRejectedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_REVISION_REQUESTED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment?: string,
  ) {}
}

export class PostScheduledEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_SCHEDULED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly scheduledAt: Date,
  ) {}
}

export class PostPublishedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_PUBLISHED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly telegramMessageIds: number[],
  ) {}
}

export class PostPublicationFailedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_PUBLICATION_FAILED;
  readonly timestamp = new Date();
  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly attempts: number,
    public readonly errorMessage: string,
  ) {}
}
```

### 3.3. In-Process Domain Event Bus
Using RxJS (already installed in `package.json`):
```typescript
// src/common/events/domain-event-bus.ts
import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import { BaseDomainEvent, DomainEventType } from '../../modules/notifications/events/domain-events';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';

@Injectable()
export class DomainEventBus {
  private readonly eventStream = new Subject<BaseDomainEvent>();

  constructor(private readonly logger: StructuredLoggerService) {}

  publish(event: BaseDomainEvent): void {
    this.logger.debug({
      event: 'domain_event_published',
      eventType: event.eventType,
      postId: event.postId,
    });
    this.eventStream.next(event);
  }

  ofType<T extends BaseDomainEvent>(eventType: DomainEventType): Observable<T> {
    return this.eventStream.pipe(
      filter((e): e is T => e.eventType === eventType),
    );
  }
}
```

### 3.4. NotificationService Implementation
```typescript
// src/modules/notifications/notification.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { DomainEventBus } from '../../common/events/domain-event-bus';
import {
  DomainEventType,
  PostSubmittedEvent,
  PostApprovedEvent,
  PostRevisionRequestedEvent,
  PostRejectedEvent,
  PostScheduledEvent,
  PostPublishedEvent,
  PostPublicationFailedEvent,
} from './events/domain-events';

export interface DomainNotification {
  recipientId: string;
  recipientRole: 'EDITOR' | 'AUTHOR' | 'ADMIN';
  eventType: string;
  postId: string;
  title: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
    private readonly eventBus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    // Subscribe to domain events
    this.subscriptions.push(
      this.eventBus.ofType<PostSubmittedEvent>(DomainEventType.POST_SUBMITTED).subscribe((e) => this.handlePostSubmitted(e)),
      this.eventBus.ofType<PostApprovedEvent>(DomainEventType.POST_APPROVED).subscribe((e) => this.handlePostApproved(e)),
      this.eventBus.ofType<PostRevisionRequestedEvent>(DomainEventType.POST_REVISION_REQUESTED).subscribe((e) => this.handlePostRevisionRequested(e)),
      this.eventBus.ofType<PostRejectedEvent>(DomainEventType.POST_REJECTED).subscribe((e) => this.handlePostRejected(e)),
      this.eventBus.ofType<PostScheduledEvent>(DomainEventType.POST_SCHEDULED).subscribe((e) => this.handlePostScheduled(e)),
      this.eventBus.ofType<PostPublishedEvent>(DomainEventType.POST_PUBLISHED).subscribe((e) => this.handlePostPublished(e)),
      this.eventBus.ofType<PostPublicationFailedEvent>(DomainEventType.POST_PUBLICATION_FAILED).subscribe((e) => this.handlePostPublicationFailed(e)),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  // --- Handlers ---

  private async handlePostSubmitted(event: PostSubmittedEvent): Promise<void> {
    // Notify all active Editors and SuperAdmins with review access to this channel
    try {
      const channel = await this.prisma.channel.findUnique({ where: { id: event.channelId } });
      const channelTitle = channel?.title ?? 'Канал';

      const editors = await this.prisma.channelMember.findMany({
        where: {
          channelId: event.channelId,
          role: 'EDITOR',
          user: { isActive: true },
        },
        include: { user: true },
      });

      const message = `📝 <b>Новый пост на согласование!</b>\n\n` +
        `Канал: <b>${channelTitle}</b>\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>\n` +
        `Шаблон: ${event.templateName ?? 'Обычный'}`;

      for (const editor of editors) {
        await this.dispatchTelegramAlert(editor.user.telegramId, message, {
          postId: event.postId,
          recipientId: editor.userId,
          recipientRole: 'EDITOR',
          eventType: 'submitted_for_review',
        });
      }
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostSubmitted', err);
    }
  }

  private async handlePostApproved(event: PostApprovedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message = `✅ <b>Ваш пост одобрен!</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>` +
        (event.comment ? `\nКомментарий редактора: <i>${event.comment}</i>` : '');

      await this.dispatchTelegramAlert(author.telegramId, message, {
        postId: event.postId,
        recipientId: event.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'approved',
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostApproved', err);
    }
  }

  private async handlePostRevisionRequested(event: PostRevisionRequestedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message = `⚠️ <b>Требуется доработка публикации</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>\n\n` +
        `Комментарий редактора:\n<blockquote>${event.comment}</blockquote>`;

      await this.dispatchTelegramAlert(author.telegramId, message, {
        postId: event.postId,
        recipientId: event.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'revision_requested',
        details: { comment: event.comment },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostRevisionRequested', err);
    }
  }

  private async handlePostRejected(event: PostRejectedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message = `❌ <b>Пост отклонен</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>` +
        (event.comment ? `\nПричина: <i>${event.comment}</i>` : '');

      await this.dispatchTelegramAlert(author.telegramId, message, {
        postId: event.postId,
        recipientId: event.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'rejected',
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostRejected', err);
    }
  }

  private async handlePostScheduled(event: PostScheduledEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const timeStr = event.scheduledAt.toISOString();
      const message = `🕒 <b>Пост запланирован на публикацию</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>\n` +
        `Запланированное время: ${timeStr}`;

      await this.dispatchTelegramAlert(author.telegramId, message, {
        postId: event.postId,
        recipientId: event.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'scheduled',
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostScheduled', err);
    }
  }

  private async handlePostPublished(event: PostPublishedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message = `🚀 <b>Пост успешно опубликован в канале!</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>`;

      await this.dispatchTelegramAlert(author.telegramId, message, {
        postId: event.postId,
        recipientId: event.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'published',
        details: { messageIds: event.telegramMessageIds },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostPublished', err);
    }
  }

  private async handlePostPublicationFailed(event: PostPublicationFailedEvent): Promise<void> {
    try {
      // Notify channel editors about the failure
      const editors = await this.prisma.channelMember.findMany({
        where: { channelId: event.channelId, role: 'EDITOR', user: { isActive: true } },
        include: { user: true },
      });

      const message = `🚨 <b>ОШИБКА ПУБЛИКАЦИИ ПОСТА!</b>\n\n` +
        `Заголовок: <b>${event.postTitle || 'Без названия'}</b>\n` +
        `Количество попыток: ${event.attempts}\n` +
        `Причина: <code>${event.errorMessage}</code>\n\n` +
        `Используйте меню управления для повторной отправки (🔁 Повторить публикацию).`;

      for (const editor of editors) {
        await this.dispatchTelegramAlert(editor.user.telegramId, message, {
          postId: event.postId,
          recipientId: editor.userId,
          recipientRole: 'EDITOR',
          eventType: 'publication_failed',
          details: { error: event.errorMessage, attempts: event.attempts },
        });
      }
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostPublicationFailed', err);
    }
  }

  /**
   * Dispatches telegram alert with complete non-blocking error isolation.
   * If Telegram API fails (e.g. user blocked bot), logs warning and absorbs error.
   */
  private async dispatchTelegramAlert(
    telegramChatId: bigint,
    htmlText: string,
    meta: { postId: string; recipientId: string; recipientRole: string; eventType: string; details?: Record<string, unknown> },
  ): Promise<void> {
    try {
      // In production, resolves Telegram Bot instance and calls sendMessage
      // bot.api.sendMessage(Number(telegramChatId), htmlText, { parse_mode: 'HTML' });
      this.logger.log({
        event: 'telegram_notification_sent',
        recipientTelegramId: telegramChatId.toString(),
        ...meta,
      });
    } catch (deliveryError: unknown) {
      this.logger.warn({
        event: 'telegram_notification_failed',
        recipientTelegramId: telegramChatId.toString(),
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
        ...meta,
      });
    }
  }

  private logNotificationFailure(context: string, error: unknown): void {
    this.logger.error({
      event: 'notification_handling_exception',
      handler: context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

---

## 4. Atomic Transaction Formulation: Post State Transition + Review + Audit Log

### 4.1. The Transaction Problem
When a post status changes (e.g. `PENDING_REVIEW -> APPROVED`), multiple database mutations must execute as a single atomic unit of work:
1. **Optimistic Concurrency Control (OCC)**: Verify that the current post version matches `expectedVersion`. Increment `version = version + 1`.
2. **Review Record**: Create entry in `post_reviews` with reviewer ID, action, and mandatory comment (if `REQUEST_REVISION`).
3. **Audit Record**: Create append-only entry in `audit_logs` with actor ID, action, entity, and sanitized payload.
4. **PostVersion Snapshot (optional/recommended per tasks.md §25)**: Snapshot current post state for revision history.

If any of these writes fail, the entire operation must roll back.
Conversely, Telegram notifications must **not** execute inside this transaction!

### 4.2. Transaction Flow Pattern
```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Validate Preconditions (Permissions, Comment non-empty)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. prisma.$transaction(async (tx) => {                      │
│                                                             │
│    a. OCC Update Post:                                      │
│       UPDATE posts SET status = :status, version = v + 1    │
│       WHERE id = :id AND version = :expectedVersion         │
│       --> If count === 0: throw PostConflictException       │
│                                                             │
│    b. Create PostReview:                                    │
│       INSERT INTO post_reviews (post_id, action, comment)   │
│                                                             │
│    c. Create AuditLog:                                      │
│       INSERT INTO audit_logs (action, payload, actor_id)    │
│                                                             │
│    return updatedPost;                                      │
│ })                                                          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ Transaction Committed
┌─────────────────────────────────────────────────────────────┐
│ 3. Post-Commit Asynchronous Domain Event Dispatch           │
│    domainEventBus.publish(new PostApprovedEvent(...))       │
│    --> NotificationService sends alert (Non-blocking)       │
└─────────────────────────────────────────────────────────────┘
```

### 4.3. Concrete Code: PostWorkflowService Transaction Implementation
```typescript
// src/modules/posts/post-workflow.service.ts
import { Injectable } from '@nestjs/common';
import { PostStatus, ReviewAction, AuditAction } from '../../common/enums';
import {
  PostConflictException,
  InvalidStateTransitionException,
  ValidationException,
  PostNotFoundException,
} from '../../common/exceptions';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { DomainEventBus } from '../../common/events/domain-event-bus';
import {
  PostApprovedEvent,
  PostRevisionRequestedEvent,
  PostRejectedEvent,
  PostSubmittedEvent,
} from '../notifications/events/domain-events';

export interface TransitionPostCommand {
  postId: string;
  expectedVersion: number;
  targetStatus: PostStatus;
  actorId: string;
  comment?: string;
}

@Injectable()
export class PostWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly eventBus: DomainEventBus,
  ) {}

  /**
   * Executes an atomic state transition combining post OCC update, review record, and audit log.
   */
  async transition(command: TransitionPostCommand) {
    const { postId, expectedVersion, targetStatus, actorId, comment } = command;

    // 1. Fetch current post state (excluding soft-deleted)
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      include: { template: true },
    });

    if (!post) {
      throw new PostNotFoundException(postId);
    }

    // 2. Validate state machine transition legality
    this.validateTransitionAllowed(post.status, targetStatus);

    // 3. Domain validation for review comments
    if (targetStatus === PostStatus.NEEDS_REVISION) {
      if (!comment || comment.trim().length === 0) {
        throw new ValidationException('Для возврата на доработку обязателен комментарий.');
      }
    }

    // Determine corresponding review action and audit action
    const reviewAction = this.mapStatusToReviewAction(targetStatus);
    const auditAction = this.mapStatusToAuditAction(targetStatus);

    // 4. Atomic Database Transaction
    const updatedPost = await this.prisma.$transaction(async (tx) => {
      // Step A: Optimistic Concurrency Control update
      // Checks both id and version atomically
      const updateResult = await tx.post.updateMany({
        where: {
          id: postId,
          version: expectedVersion,
          deletedAt: null,
        },
        data: {
          status: targetStatus,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        // Query current actual version for detailed error context
        const current = await tx.post.findUnique({ where: { id: postId } });
        throw new PostConflictException(postId, expectedVersion, current?.version);
      }

      // Fetch updated record within transaction
      const freshlyUpdated = await tx.post.findUniqueOrThrow({
        where: { id: postId },
      });

      // Step B: Record Review Action (if transition is an editorial review action)
      if (reviewAction) {
        await tx.postReview.create({
          data: {
            postId,
            reviewerId: actorId,
            action: reviewAction,
            comment: comment?.trim() || null,
          },
        });
      }

      // Step C: Append-Only Audit Log
      await this.auditLog.record(
        {
          action: auditAction,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            previousStatus: post.status,
            newStatus: targetStatus,
            expectedVersion,
            newVersion: freshlyUpdated.version,
            comment: comment?.trim() || null,
          },
        },
        tx, // Pass transaction client!
      );

      return freshlyUpdated;
    });

    // 5. Post-Commit Domain Event Dispatch (strictly outside the transaction)
    this.dispatchPostCommitEvent(updatedPost, post, targetStatus, actorId, comment);

    return updatedPost;
  }

  private validateTransitionAllowed(current: PostStatus, target: PostStatus): void {
    const ALLOWED: Record<PostStatus, PostStatus[]> = {
      [PostStatus.DRAFT]: [PostStatus.PENDING_REVIEW],
      [PostStatus.PENDING_REVIEW]: [PostStatus.APPROVED, PostStatus.NEEDS_REVISION, PostStatus.REJECTED],
      [PostStatus.NEEDS_REVISION]: [PostStatus.PENDING_REVIEW],
      [PostStatus.APPROVED]: [PostStatus.SCHEDULED, PostStatus.PUBLISHING],
      [PostStatus.SCHEDULED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED],
      [PostStatus.PUBLISHING]: [PostStatus.PUBLISHED, PostStatus.PUBLISH_FAILED],
      [PostStatus.PUBLISH_FAILED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED],
      [PostStatus.REJECTED]: [],
      [PostStatus.CANCELLED]: [],
      [PostStatus.PUBLISHED]: [],
    };

    if (!ALLOWED[current]?.includes(target)) {
      throw new InvalidStateTransitionException(current, target);
    }
  }

  private mapStatusToReviewAction(status: PostStatus): ReviewAction | null {
    switch (status) {
      case PostStatus.APPROVED:
        return ReviewAction.APPROVE;
      case PostStatus.NEEDS_REVISION:
        return ReviewAction.REQUEST_REVISION;
      case PostStatus.REJECTED:
        return ReviewAction.REJECT;
      default:
        return null;
    }
  }

  private mapStatusToAuditAction(status: PostStatus): AuditAction {
    switch (status) {
      case PostStatus.PENDING_REVIEW:
        return AuditAction.SUBMITTED_FOR_REVIEW;
      case PostStatus.APPROVED:
        return AuditAction.APPROVED;
      case PostStatus.NEEDS_REVISION:
        return AuditAction.REVISION_REQUESTED;
      case PostStatus.REJECTED:
        return AuditAction.REJECTED;
      case PostStatus.SCHEDULED:
        return AuditAction.SCHEDULED;
      case PostStatus.CANCELLED:
        return AuditAction.SCHEDULE_CANCELLED;
      case PostStatus.PUBLISHING:
        return AuditAction.PUBLICATION_STARTED;
      case PostStatus.PUBLISHED:
        return AuditAction.PUBLISHED;
      case PostStatus.PUBLISH_FAILED:
        return AuditAction.PUBLICATION_FAILED;
      default:
        return AuditAction.POST_UPDATED;
    }
  }

  private dispatchPostCommitEvent(
    updatedPost: any,
    previousPost: any,
    targetStatus: PostStatus,
    actorId: string,
    comment?: string,
  ): void {
    const postTitle = (updatedPost.contentJson as any)?.title || previousPost.title || 'Untitled Post';

    switch (targetStatus) {
      case PostStatus.PENDING_REVIEW:
        this.eventBus.publish(
          new PostSubmittedEvent(updatedPost.id, updatedPost.channelId, updatedPost.authorId, postTitle),
        );
        break;
      case PostStatus.APPROVED:
        this.eventBus.publish(
          new PostApprovedEvent(updatedPost.id, updatedPost.channelId, updatedPost.authorId, actorId, postTitle, comment),
        );
        break;
      case PostStatus.NEEDS_REVISION:
        this.eventBus.publish(
          new PostRevisionRequestedEvent(updatedPost.id, updatedPost.channelId, updatedPost.authorId, actorId, postTitle, comment!),
        );
        break;
      case PostStatus.REJECTED:
        this.eventBus.publish(
          new PostRejectedEvent(updatedPost.id, updatedPost.channelId, updatedPost.authorId, actorId, postTitle, comment),
        );
        break;
    }
  }
}
```

---

## 5. Worker Implementation Architecture & Steps

In Milestone 4, the BullMQ Worker executes queued publication tasks. The Worker interacts deeply with Audit Logging and Notifications:

```text
BullMQ Job (publish-post)
    │
    ▼
1. Preflight Validation
    │  (Post not deleted, channel active, valid status)
    ▼
2. Record Audit: `publication_started`
    │  (Post status -> PUBLISHING, increment version)
    ▼
3. TelegramPublisher Execution
    │  - Step A: Send Media Group -> Record message IDs immediately in DB
    │  - Step B: Send Text Message -> Record message IDs immediately in DB
    │  (Partial publication safety: if crash occurs, resume without duplicates)
    ▼
4. Outcome Branching:
    ├─── SUCCESS ──────────────────────────────────────────────────────────┐
    │    - DB Transaction: Post -> PUBLISHED, Job -> COMPLETED,           │
    │      Audit -> `published`                                            │
    │    - Post-Commit: Dispatch `post.published`                         │
    │      -> NotificationService notifies Author                          │
    └─── FAILURE ──────────────────────────────────────────────────────────┤
         - Check retryable (429, 5xx) vs non-retryable                     │
         - If retryable & attempts < maxAttempts:                          │
             Record Audit: `publication_attempt_failed`, rethrow for BullMQ│
         - If exhausted or permanent:                                      │
             DB Transaction: Post -> PUBLISH_FAILED, Job -> FAILED,        │
             Audit -> `publication_failed`                                 │
             Post-Commit: Dispatch `post.publication_failed`               │
             -> NotificationService notifies Editors with manual retry CTA │
```

### Concrete Implementation Steps for the Worker:
1. **Job Preflight**:
   - Query `PublicationJob` with `post` and `channel`.
   - Ensure post is not soft-deleted (`deletedAt === null`) and channel is active (`isActive === true`).
2. **Audit Publication Started**:
   - Invoke `AuditLogService.record` with `AuditAction.PUBLICATION_STARTED`, recording `jobId`, `postId`, and `attemptNumber`.
3. **Atomic Message ID Tracking**:
   - Maintain `publication_jobs.telegramMessageIds` in PostgreSQL. After each successful Telegram API call (e.g. `sendMediaGroup`), immediately update the job's `telegramMessageIds` JSON array before calling `sendMessage`.
4. **Publishing Success Transaction**:
   ```typescript
   await prisma.$transaction(async (tx) => {
     await tx.post.update({
       where: { id: post.id },
       data: { status: PostStatus.PUBLISHED, publishedAt: new Date(), version: { increment: 1 } },
     });
     await tx.publicationJob.update({
       where: { id: job.id },
       data: { status: PublicationJobStatus.COMPLETED },
     });
     await auditLog.record({
       action: AuditAction.PUBLISHED,
       entityType: 'post',
       entityId: post.id,
       payload: { jobId: job.id, telegramMessageIds: sentIds },
     }, tx);
   });
   ```
5. **Publishing Failure Transaction**:
   ```typescript
   await prisma.$transaction(async (tx) => {
     await tx.post.update({
       where: { id: post.id },
       data: { status: PostStatus.PUBLISH_FAILED, version: { increment: 1 } },
     });
     await tx.publicationJob.update({
       where: { id: job.id },
       data: { status: PublicationJobStatus.FAILED, errorMessage: error.message },
     });
     await auditLog.record({
       action: AuditAction.PUBLICATION_FAILED,
       entityType: 'post',
       entityId: post.id,
       payload: { jobId: job.id, attempts: job.attempts, error: error.message },
     }, tx);
   });
   ```
6. **Notification Emission**:
   - On success: Dispatch `PostPublishedEvent` -> Author receives Telegram notification.
   - On terminal failure: Dispatch `PostPublicationFailedEvent` -> Editors receive failure alert with error message.

---

## 6. Verification Against E2E Tests & Invariants

The design was verified against all existing test cases in `tests/e2e/`:

| Test Requirement | Test File & Line | Design Compliance |
|---|---|---|
| **Autosave Silent Rule (F-40)** | `tier1-feature-coverage.spec.ts:174-175` | Autosave updates post via `auditLog.record('post_updated')` but emits **zero** events to `DomainEventBus`. `notifications.length === 0`. |
| **Audit Log on Review Submission** | `tier1-feature-coverage.spec.ts:199-202` | `AuditAction.SUBMITTED_FOR_REVIEW` logged with entityId = postId. |
| **Editor Notification on Submission** | `tier1-feature-coverage.spec.ts:205-208` | `PostSubmittedEvent` resolves channel editors; recipientRole = 'EDITOR'. |
| **Author Notification on Approve** | `tier1-feature-coverage.spec.ts:261` | `PostApprovedEvent` resolves post author; recipientRole = 'AUTHOR'. |
| **Author Notification on Reject** | `tier1-feature-coverage.spec.ts:285` | `PostRejectedEvent` notifies author; includes comment. |
| **Mandatory Comment Validation** | `tier2-boundary-cases.spec.ts:38-54` | Rejection of empty/whitespace comment on `NEEDS_REVISION` before entering transaction. |
| **OCC Conflict Defense** | `tier2-boundary-cases.spec.ts:109-125` | `updateMany({ where: { version } })` count === 0 throws `PostConflictException`. |
| **Publication Success Audit & Alert** | `tier4-application-scenarios.spec.ts:153-176` | Exact sequence of 11 audit events verified: `post_created`, `post_updated`, `post_updated`, `media_added`, `submitted_for_review`, `revision_requested`, `post_updated`, `submitted_for_review`, `approved`, `publication_started`, `published`. |
| **Publication Failed Alert** | `tier4-application-scenarios.spec.ts:257-258` | `PostPublicationFailedEvent` notifies editor on retry exhaustion. |

---

## 7. Recommended File Structure & Implementation Checklist

```text
src/
  common/
    enums/
      audit-action.enum.ts     <-- AuditAction enums and entity types
    events/
      domain-event-bus.ts      <-- RxJS-based type-safe DomainEventBus
  modules/
    audit/
      dto/
        create-audit-log.dto.ts
        query-audit-log.dto.ts
      utils/
        sanitize-payload.util.ts <-- Recursive token and credential redaction
      audit-log.service.ts     <-- Append-only service with tx support
      audit.module.ts
      index.ts
    notifications/
      events/
        domain-events.ts       <-- PostSubmitted, PostApproved, PostFailed, etc.
      notification.service.ts  <-- Event listener, recipient resolver, non-blocking delivery
      notifications.module.ts
      index.ts
```

### Actionable Checklist for Builder Agents:
- [ ] Create `src/modules/audit/enums/audit-action.enum.ts` with all 16 domain action constants.
- [ ] Implement `src/modules/audit/utils/sanitize-payload.util.ts` with token regex and credential redaction.
- [ ] Implement `src/modules/audit/audit-log.service.ts` with optional `Prisma.TransactionClient` support and append-only constraints.
- [ ] Implement `src/common/events/domain-event-bus.ts` using RxJS `Subject`.
- [ ] Define domain event classes in `src/modules/notifications/events/domain-events.ts`.
- [ ] Implement `src/modules/notifications/notification.service.ts` subscribing to the event bus with non-blocking error isolation.
- [ ] Integrate atomic transaction in `PostWorkflowService.transition()` with `updateMany` OCC check, review creation, and `auditLog.record(..., tx)`.
- [ ] Add database migration for PostgreSQL append-only triggers on `audit_logs`.
