# Milestone 5 Architecture & Design Report: Telegram Transport, Bot Lifecycle, and Authentication Middleware

**Author**: `m5_explorer_1` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m5_explorer_1`  
**Target Milestone**: Milestone 5 (M5) — Telegram Transport & Interactive Wizard UI  
**Authoritative References**: `AGENTS.md` (§3, §4, §5, §8, §9, §32, §36, §37), `tasks.md` (§4, §5, §7, §8, §28, §29), `PROJECT.md` (F-01, F-02, F-03, F-47, Interface Contracts), `ORIGINAL_REQUEST.md`.

---

## 1. Executive Summary

Milestone 5 establishes the user-facing Telegram transport layer for the Telegram Content Publisher Bot MVP. As dictated by `AGENTS.md` §3 and §5, Telegram is strictly a transport layer: Telegram handlers must NOT contain core business logic, query Prisma directly, or execute direct publishing calls.

This report provides the complete architectural design and implementation specification for:
1. **grammY Bot Setup & Dual Transport Lifecycle**: Encapsulating grammY within NestJS via `TelegramBotService`, supporting both production Webhook mode (`POST /telegram/webhook` with `X-Telegram-Bot-Api-Secret-Token` validation) and local development Polling mode (via `@grammyjs/runner` with clean graceful shutdown).
2. **Authentication & Authorization Middleware**: Intercepting every incoming update, extracting Telegram ID as `bigint`, resolving the actor via `AuthService.resolveUser`, rejecting unregistered and deactivated users immediately per acceptance criteria, and attaching typed user identities and permission checkers to `BotContext`.
3. **Centralized Exception Filter & Error Boundary**: Catching all domain and infrastructure exceptions within grammY, formatting clear, friendly Russian messages per `AGENTS.md` §32, handling both callback query alerts (`show_alert: true`) and reply messages, and emitting structured JSON diagnostic logs while redacting secrets.
4. **Concrete Code Layout, Interfaces, DTOs, and Worker Implementation Roadmap**: Ready for the implementation worker (`m5_worker`).

---

## 2. Codebase Baseline & Integration Points

The codebase currently contains completed Milestones 1–4 (with 401 unit tests and 34 E2E tests passing):
- **Configuration** (`src/infrastructure/config/`): `EnvironmentConfigService` and `EnvironmentVariables` already define and validate `BOT_TOKEN`, `TELEGRAM_MODE` (`polling` | `webhook`), `WEBHOOK_DOMAIN`, `WEBHOOK_PATH` (`/telegram/webhook`), and `WEBHOOK_SECRET_TOKEN`.
- **Domain Exceptions** (`src/common/exceptions/domain.exceptions.ts`): Fully defined exceptions including `UnauthorizedUserException` (401), `UserDeactivatedException` (403), `PermissionDeniedException` (403), `PostConflictException` (409), `ValidationException` (400), `InvalidPostStateTransitionException` (400), and `PostNotFoundException` (404).
- **Authentication & RBAC** (`src/modules/auth/`):
  - `AuthService.resolveUser(telegramId: bigint | number | string): Promise<AuthUser | null>`: Returns `AuthUser` with `id`, `telegramId`, `systemRole`, `channelMemberships`; throws `UserDeactivatedException` if `!user.isActive`; returns `null` if user is unregistered.
  - `PermissionService`: Evaluates granular channel permissions (`canPublish`, `canApprove`, `ChannelPermission`) with automatic `SUPER_ADMIN` system bypass.
- **Process Separation** (`AGENTS.md` §65, `PROJECT.md` F-48):
  - `App` (`src/main.ts`, `AppModule`): HTTP server, Webhook endpoint, Health probes, Telegram Bot handlers.
  - `Worker` (`src/worker.main.ts`, `WorkerModule`): BullMQ processor consuming publication queue. `WorkerModule` does not load Telegram Bot handlers, maintaining strict decoupling.

---

## 3. Pillar 1: Bot Setup & Dual Transport Lifecycle (`src/modules/telegram/`)

### 3.1 Architectural Principles
- The Telegram bot operates as a NestJS service (`TelegramBotService`) managed by the NestJS IoC container.
- Lifecycle hooks `OnModuleInit` and `OnApplicationShutdown` manage transport initialization and teardown.
- Transport mode is strictly decoupled from message handling logic (`AGENTS.md` §36).

### 3.2 Dual Transport Modes

#### Mode A: Webhook Transport (Production Standard)
1. **Endpoint**: `POST /telegram/webhook` hosted by `TelegramWebhookController`.
2. **Secret Validation (`TelegramWebhookGuard`)**:
   - Telegram sends the custom header: `X-Telegram-Bot-Api-Secret-Token`.
   - The guard compares this header against `EnvironmentConfigService.webhookSecretToken`.
   - Security requirement: Constant-time buffer comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
   - If missing or invalid, throws HTTP 401/403.
3. **Update Dispatching**:
   - `TelegramWebhookController.handleWebhook(@Body() update: Update)` forwards the update directly to `await this.telegramBotService.handleUpdate(update)`.
   - Responds immediately with HTTP 200 `{ ok: true }`.
4. **Registration during `onModuleInit`**:
   - If `config.telegramMode === TelegramMode.WEBHOOK` and `config.webhookDomain` is present:
     - Builds URL: `${config.webhookDomain.replace(/\/$/, '')}${config.webhookPath}`.
     - Calls `await this.bot.api.setWebhook(webhookUrl, { secret_token: config.webhookSecretToken, allowed_updates: ['message', 'callback_query'] })`.
     - Logs `{ event: 'telegram_webhook_configured', url: webhookUrl }`.

#### Mode B: Polling Transport (Local Development & Staging)
1. **Runner**: Uses `@grammyjs/runner` (`run(this.bot)`), which is already installed in `package.json`.
2. **Webhook Cleanup**:
   - Before starting polling, Telegram requires that any active webhook is deleted.
   - Calls `await this.bot.api.deleteWebhook({ drop_pending_updates: false })`.
3. **Execution**:
   - `this.runner = run(this.bot);`
   - In test environment (`config.isTest` or mock mode), auto-polling is suppressed so test suites run hermetically without external network calls.
4. **Shutdown during `onApplicationShutdown`**:
   - `if (this.runner?.isRunning()) { await this.runner.stop(); }`
   - Guarantees in-flight updates are drained before process exit.

### 3.3 TelegramBotService Specification

```ts
import { Injectable, OnModuleInit, OnApplicationShutdown, Optional } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import { run, RunnerHandle } from '@grammyjs/runner';
import { EnvironmentConfigService } from '../../infrastructure/config/environment-config.service';
import { TelegramMode } from '../../infrastructure/config/environment.variables';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { BotContext } from './interfaces/bot-context.interface';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnApplicationShutdown {
  private bot!: Bot<BotContext>;
  private runner?: RunnerHandle;

  constructor(
    private readonly config: EnvironmentConfigService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {
    this.bot = new Bot<BotContext>(this.config.botToken);
  }

  getBotInstance(): Bot<BotContext> {
    return this.bot;
  }

  async onModuleInit(): Promise<void> {
    this.registerMiddlewares();
    this.registerHandlers();
    this.registerCatch();

    if (this.config.isTest) {
      this.logger?.log({ event: 'telegram_bot_test_mode_active', module: 'telegram' });
      return;
    }

    if (this.config.telegramMode === TelegramMode.WEBHOOK) {
      await this.initWebhook();
    } else {
      await this.initPolling();
    }
  }

  private async initWebhook(): Promise<void> {
    const domain = this.config.webhookDomain;
    if (!domain) {
      this.logger?.warn({
        event: 'telegram_webhook_domain_missing',
        message: 'WEBHOOK_DOMAIN not provided; skipping automatic setWebhook call.',
      });
      return;
    }
    const webhookUrl = `${domain.replace(/\/$/, '')}${this.config.webhookPath}`;
    await this.bot.api.setWebhook(webhookUrl, {
      secret_token: this.config.webhookSecretToken,
      allowed_updates: ['message', 'callback_query'],
    });
    this.logger?.log({
      event: 'telegram_bot_started',
      mode: 'webhook',
      webhookUrl,
    });
  }

  private async initPolling(): Promise<void> {
    await this.bot.api.deleteWebhook({ drop_pending_updates: false });
    this.runner = run(this.bot);
    this.logger?.log({
      event: 'telegram_bot_started',
      mode: 'polling',
    });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.runner?.isRunning()) {
      await this.runner.stop();
      this.logger?.log({ event: 'telegram_bot_polling_stopped', signal });
    }
  }

  async handleUpdate(update: any): Promise<void> {
    await this.bot.handleUpdate(update);
  }
}
```

### 3.4 Webhook Controller & Secret Guard

```ts
// src/modules/telegram/guards/telegram-webhook.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { EnvironmentConfigService } from '../../../infrastructure/config/environment-config.service';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly config: EnvironmentConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.webhookSecretToken;
    if (!secret) {
      return true; // Secret validation disabled if not configured
    }

    const request = context.switchToHttp().getRequest<Request>();
    const headerToken = request.headers['x-telegram-bot-api-secret-token'];

    if (!headerToken || typeof headerToken !== 'string') {
      throw new UnauthorizedException('Missing Telegram webhook secret token header');
    }

    const secretBuf = Buffer.from(secret);
    const headerBuf = Buffer.from(headerToken);

    if (secretBuf.length !== headerBuf.length || !crypto.timingSafeEqual(secretBuf, headerBuf)) {
      throw new UnauthorizedException('Invalid Telegram webhook secret token');
    }

    return true;
  }
}
```

```ts
// src/modules/telegram/controllers/telegram-webhook.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, BadRequestException } from '@nestjs/common';
import { TelegramBotService } from '../telegram-bot.service';
import { TelegramWebhookGuard } from '../guards/telegram-webhook.guard';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(private readonly botService: TelegramBotService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TelegramWebhookGuard)
  async processWebhook(@Body() update: unknown): Promise<{ ok: boolean }> {
    if (!update || typeof update !== 'object') {
      throw new BadRequestException('Malformed Telegram update payload');
    }
    await this.botService.handleUpdate(update);
    return { ok: true };
  }
}
```

---

## 4. Pillar 2: Authentication & Authorization Middleware

### 4.1 Strict Telegram Identity Validation
`AGENTS.md` §8 mandates:
1. Primary Telegram identity is the Telegram ID (`BigInt`).
2. Never authorize users by `username`, `first_name`, or display name.
3. Every protected operation must verify existence, verify active status, and evaluate channel permissions.

### 4.2 Context Flavoring (`BotContext`)
```ts
// src/modules/telegram/interfaces/bot-context.interface.ts
import { Context } from 'grammy';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { ChannelPermission, SystemRole } from '../../../common/enums';

export interface BotContextFlavor {
  requestId: string;
  authUser?: AuthUser;
  readonly isSuperAdmin: boolean;
  canChannel: (permission: ChannelPermission, channelId: string) => boolean;
}

export type BotContext = Context & BotContextFlavor;
```

### 4.3 TelegramAuthMiddleware Implementation
The auth middleware runs for all incoming user updates.

```ts
// src/modules/telegram/middlewares/telegram-auth.middleware.ts
import { Injectable, Optional } from '@nestjs/common';
import { MiddlewareFn } from 'grammy';
import { AuthService } from '../../auth/auth.service';
import { UserDeactivatedException } from '../../../common/exceptions/domain.exceptions';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { BotContext } from '../interfaces/bot-context.interface';
import { SystemRole, ChannelPermission } from '../../../common/enums';

@Injectable()
export class TelegramAuthMiddleware {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  create(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      // 1. Identify user from update
      const fromUser = ctx.from;
      if (!fromUser) {
        // Non-user updates (e.g. channel post) are ignored by bot user transport
        return;
      }

      const telegramId = BigInt(fromUser.id);

      try {
        // 2. Resolve user via AuthService
        const authUser = await this.authService.resolveUser(telegramId);

        // 3. Handle unregistered user
        if (!authUser) {
          this.logger?.warn({
            event: 'auth_unregistered_access_attempt',
            telegramId: telegramId.toString(),
            username: fromUser.username,
            requestId: ctx.requestId,
          });

          const message =
            `🚫 <b>Доступ ограничен</b>\n\n` +
            `У вас пока нет доступа к редакции.\n` +
            `Обратитесь к администратору для получения прав.\n\n` +
            `Ваш Telegram ID: <code>${telegramId.toString()}</code>`;

          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
              text: 'У вас пока нет доступа к редакции. Обратитесь к администратору.',
              show_alert: true,
            });
          } else {
            await ctx.reply(message, { parse_mode: 'HTML' });
          }
          return; // Stop middleware propagation
        }

        // 4. Attach resolved user & permission helpers to context
        ctx.authUser = authUser;
        Object.defineProperty(ctx, 'isSuperAdmin', {
          get: () => authUser.systemRole === SystemRole.SUPER_ADMIN,
        });

        ctx.canChannel = (permission: ChannelPermission, channelId: string): boolean => {
          if (authUser.systemRole === SystemRole.SUPER_ADMIN) return true;
          const membership = authUser.channelMemberships.find((m) => m.channelId === channelId);
          if (!membership) return false;
          if (permission === ChannelPermission.PUBLISH_POST) return membership.canPublish;
          if (permission === ChannelPermission.APPROVE_POST) return membership.canApprove;
          return true;
        };

        this.logger?.log({
          event: 'auth_user_resolved',
          userId: authUser.id,
          telegramId: telegramId.toString(),
          role: authUser.systemRole,
          requestId: ctx.requestId,
        });

        await next();
      } catch (err: unknown) {
        // 5. Handle deactivated user
        if (err instanceof UserDeactivatedException) {
          this.logger?.warn({
            event: 'auth_deactivated_user_attempt',
            telegramId: telegramId.toString(),
            requestId: ctx.requestId,
          });

          const deactMessage =
            `🚫 <b>Доступ заблокирован</b>\n\n` +
            `Ваш аккаунт деактивирован. Обратитесь к администратору.\n\n` +
            `Ваш Telegram ID: <code>${telegramId.toString()}</code>`;

          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
              text: 'Ваш аккаунт деактивирован. Обратитесь к администратору.',
              show_alert: true,
            });
          } else {
            await ctx.reply(deactMessage, { parse_mode: 'HTML' });
          }
          return;
        }

        throw err; // Forward unexpected errors to exception filter
      }
    };
  }
}
```

---

## 5. Pillar 3: Centralized Exception Filter & Error Handler

### 5.1 Requirement & Scope (`AGENTS.md` §32)
Separate:
- Validation errors (`ValidationException`)
- Authorization errors (`UnauthorizedUserException`, `UserDeactivatedException`, `PermissionDeniedException`)
- Conflict errors (`PostConflictException`, `IdempotencyConflictException`)
- Domain / State transition errors (`InvalidPostStateTransitionException`, `PostNotFoundException`)
- Telegram API errors (`TelegramRateLimitException`, `TelegramRetryableException`, `TelegramPermanentException`)
- Unexpected errors (`Error`)

User-facing errors must be understandable Russian messages. Never expose stack traces, database schemas, tokens, or raw authorization headers to Telegram users.

### 5.2 Error Response Dispatching Strategy
- **Callback Query Handling**:
  - Always call `ctx.answerCallbackQuery()` to stop the Telegram client's pending button spinner.
  - If error text $\le 200$ chars, show as native modal alert (`show_alert: true`).
  - If text is longer or requires HTML, answer query silently and send a message via `ctx.reply`.
- **Message / Command Handling**:
  - Send message via `ctx.reply(message, { parse_mode: 'HTML' })`.
- **Structured Error Logging (`AGENTS.md` §33)**:
  - Log structured JSON with `request_id`, `user_id`, `telegram_update_id`, `errorCode`, `errorName`, `errorMessage`, redacting secrets.

### 5.3 Exception Mapping Table

| Exception Class | HTTP Status | Error Code | Friendly Russian UI Message | Log Level |
|---|---|---|---|---|
| `UnauthorizedUserException` | 401 | `UNAUTHORIZED_USER` | `🚫 У вас пока нет доступа к редакции. Обратитесь к администратору.` | `warn` |
| `UserDeactivatedException` | 403 | `USER_DEACTIVATED` | `🚫 Ваш аккаунт деактивирован. Обратитесь к администратору.` | `warn` |
| `PermissionDeniedException` | 403 | `PERMISSION_DENIED` | `⛔️ Недостаточно прав для выполнения этого действия.` | `warn` |
| `PostConflictException` | 409 | `POST_CONFLICT` | `⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие.` | `warn` |
| `IdempotencyConflictException` | 409 | `IDEMPOTENCY_CONFLICT` | `⏳ Публикация уже находится в обработке или отправлена в очередь.` | `info` |
| `InvalidPostStateTransitionException` | 400 | `INVALID_STATE_TRANSITION` | `⚠️ Действие невозможно: текущий статус публикации не позволяет этот переход.` | `warn` |
| `ValidationException` | 400 | `VALIDATION_ERROR` | `⚠️ Ошибка проверки данных: ${err.message}` | `warn` |
| `PostNotFoundException` | 404 | `POST_NOT_FOUND` | `❌ Публикация не найдена. Возможно, она была удалена.` | `warn` |
| `ChannelNotFoundException` | 404 | `CHANNEL_NOT_FOUND` | `❌ Канал не найден или деактивирован.` | `warn` |
| `TemplateNotFoundException` | 404 | `TEMPLATE_NOT_FOUND` | `❌ Шаблон публикации не найден.` | `warn` |
| `TelegramRateLimitException` | 429 | `RATE_LIMITED` | `⏳ Превышен лимит запросов к Telegram. Повторите попытку через несколько секунд.` | `warn` |
| `TelegramRetryableException` | 500 | `RETRYABLE_ERROR` | `⏳ Временный сбой связи с Telegram. Попробуйте еще раз.` | `warn` |
| `TelegramPermanentException` | 400 | `PERMANENT_ERROR` | `❌ Ошибка Telegram: не удалось выполнить действие.` | `error` |
| Unhandled / Generic `Error` | 500 | `INTERNAL_ERROR` | `❌ Произошла непредвиденная ошибка. Мы уже зафиксировали проблему. Попробуйте позже.` | `error` |

### 5.4 TelegramExceptionFilter Implementation

```ts
// src/modules/telegram/filters/telegram-exception.filter.ts
import { Injectable, Optional } from '@nestjs/common';
import { MiddlewareFn } from 'grammy';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { BotContext } from '../interfaces/bot-context.interface';
import {
  DomainException,
  UnauthorizedUserException,
  UserDeactivatedException,
  PermissionDeniedException,
  PostConflictException,
  IdempotencyConflictException,
  InvalidPostStateTransitionException,
  ValidationException,
  PostNotFoundException,
  ChannelNotFoundException,
  TemplateNotFoundException,
} from '../../../common/exceptions/domain.exceptions';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../../infrastructure/telegram-api/errors/telegram-api.exceptions';

@Injectable()
export class TelegramExceptionFilter {
  constructor(@Optional() private readonly logger?: StructuredLoggerService) {}

  create(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      try {
        await next();
      } catch (err: unknown) {
        await this.handleError(err, ctx);
      }
    };
  }

  async handleError(err: unknown, ctx: BotContext): Promise<void> {
    const { userMessage, errorCode, logLevel } = this.classifyError(err);

    // Structured logging
    const logPayload = {
      event: 'telegram_handler_error',
      requestId: ctx.requestId,
      telegramUserId: ctx.from?.id ? String(ctx.from.id) : undefined,
      username: ctx.from?.username,
      errorCode,
      errorName: err instanceof Error ? err.name : 'UnknownError',
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };

    if (this.logger) {
      if (logLevel === 'error') {
        this.logger.error(logPayload, err instanceof Error ? err.stack : undefined);
      } else if (logLevel === 'warn') {
        this.logger.warn(logPayload);
      } else {
        this.logger.log(logPayload);
      }
    }

    // Deliver user-facing message safely
    try {
      if (ctx.callbackQuery) {
        if (userMessage.length <= 180) {
          await ctx.answerCallbackQuery({ text: userMessage, show_alert: true });
        } else {
          await ctx.answerCallbackQuery();
          await ctx.reply(userMessage, { parse_mode: 'HTML' });
        }
      } else if (ctx.chat) {
        await ctx.reply(userMessage, { parse_mode: 'HTML' });
      }
    } catch (deliveryError) {
      this.logger?.warn({
        event: 'telegram_error_message_delivery_failed',
        requestId: ctx.requestId,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      });
    }
  }

  private classifyError(err: unknown): { userMessage: string; errorCode: string; logLevel: 'info' | 'warn' | 'error' } {
    if (err instanceof UnauthorizedUserException) {
      return {
        userMessage: '🚫 У вас пока нет доступа к редакции. Обратитесь к администратору.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof UserDeactivatedException) {
      return {
        userMessage: '🚫 Ваш аккаунт деактивирован. Обратитесь к администратору.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PermissionDeniedException) {
      return {
        userMessage: '⛔️ Недостаточно прав для выполнения этого действия.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PostConflictException) {
      return {
        userMessage: '⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof IdempotencyConflictException) {
      return {
        userMessage: '⏳ Публикация уже находится в обработке или отправлена в очередь.',
        errorCode: err.errorCode,
        logLevel: 'info',
      };
    }
    if (err instanceof InvalidPostStateTransitionException) {
      return {
        userMessage: '⚠️ Невозможно выполнить действие: текущий статус публикации не позволяет этот переход.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof ValidationException) {
      return {
        userMessage: `⚠️ Ошибка проверки данных: ${this.sanitizeValidationMessage(err.message)}`,
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PostNotFoundException) {
      return {
        userMessage: '❌ Публикация не найдена. Возможно, она была удалена.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof ChannelNotFoundException) {
      return {
        userMessage: '❌ Канал не найден или недоступен.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof TemplateNotFoundException) {
      return {
        userMessage: '❌ Шаблон публикации не найден.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramRateLimitException) {
      return {
        userMessage: '⏳ Превышен лимит запросов к Telegram. Повторите попытку через несколько секунд.',
        errorCode: 'RATE_LIMITED',
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramRetryableException) {
      return {
        userMessage: '⏳ Временный сбой связи с Telegram. Попробуйте еще раз.',
        errorCode: 'RETRYABLE_ERROR',
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramPermanentException) {
      return {
        userMessage: '❌ Ошибка Telegram: не удалось выполнить действие.',
        errorCode: 'PERMANENT_ERROR',
        logLevel: 'error',
      };
    }

    return {
      userMessage: '❌ Произошла непредвиденная ошибка. Мы уже зафиксировали проблему. Попробуйте позже.',
      errorCode: 'INTERNAL_ERROR',
      logLevel: 'error',
    };
  }

  private sanitizeValidationMessage(msg: string): string {
    return msg.replace(/[<>&]/g, '');
  }
}
```

---

## 6. Pillar 4: Role-Based Main Menu & Handlers

### 6.1 Role-Based Menus (`tasks.md` §8)
- **Author Menu**:
  ```text
  ➕ Создать пост
  📝 Мои материалы
  📅 Контент-план
  📚 Публикации
  ❓ Помощь
  ```
- **Editor / Super Admin Menu**:
  ```text
  ➕ Создать пост
  📝 Материалы
  ✅ На согласовании
  📅 Контент-план
  📚 Публикации
  👥 Пользователи (Super Admin only)
  ⚙️ Настройки (Super Admin only)
  ```

### 6.2 StartHandler Implementation
```ts
// src/modules/telegram/handlers/start.handler.ts
import { Injectable } from '@nestjs/common';
import { Keyboard } from 'grammy';
import { BotContext } from '../interfaces/bot-context.interface';
import { SystemRole, ChannelRole } from '../../../common/enums';

@Injectable()
export class StartHandler {
  async handle(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return; // Guaranteed by auth middleware

    const isEditorOrAdmin =
      ctx.isSuperAdmin ||
      user.channelMemberships.some((m) => m.role === ChannelRole.EDITOR);

    const keyboard = new Keyboard();
    keyboard.text('➕ Создать пост');

    if (isEditorOrAdmin) {
      keyboard.text('📝 Материалы').row();
      keyboard.text('✅ На согласовании').text('📅 Контент-план').row();
      keyboard.text('📚 Публикации');
      if (ctx.isSuperAdmin) {
        keyboard.text('👥 Пользователи').row();
        keyboard.text('⚙️ Настройки').text('❓ Помощь').row();
      } else {
        keyboard.text('❓ Помощь').row();
      }
    } else {
      keyboard.text('📝 Мои материалы').row();
      keyboard.text('📅 Контент-план').text('📚 Публикации').row();
      keyboard.text('❓ Помощь').row();
    }

    keyboard.resized();

    const roleTitle = ctx.isSuperAdmin
      ? 'Главный администратор'
      : isEditorOrAdmin
        ? 'Редактор'
        : 'Автор';

    const welcome =
      `👋 Добро пожаловать в редакционную панель, <b>${user.firstName || user.username || 'Коллега'}</b>!\n\n` +
      `Ваша роль: <b>${roleTitle}</b>\n` +
      `Доступных каналов: <b>${user.channelMemberships.length}</b>\n\n` +
      `Выберите необходимое действие в меню ниже:`;

    await ctx.reply(welcome, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}
```

---

## 7. Concrete File Layout for `src/modules/telegram/`

```text
src/modules/telegram/
├── controllers/
│   └── telegram-webhook.controller.ts     # POST /telegram/webhook with secret token guard
├── guards/
│   └── telegram-webhook.guard.ts          # Validates X-Telegram-Bot-Api-Secret-Token
├── middlewares/
│   ├── telegram-request-id.middleware.ts  # Adds unique requestId to context and logs update
│   └── telegram-auth.middleware.ts        # Resolves user via AuthService, handles unreg/deact
├── filters/
│   └── telegram-exception.filter.ts       # Centralized error boundary mapping domain errors
├── handlers/
│   ├── start.handler.ts                   # /start handler rendering role-based menu
│   └── help.handler.ts                    # /help handler
├── interfaces/
│   ├── bot-context.interface.ts           # Extended grammY BotContext type
│   └── telegram-handler.interface.ts      # Standard handler interface
├── telegram-bot.service.ts                # Lifecycle service (onModuleInit, onApplicationShutdown)
├── telegram.module.ts                     # NestJS module bundling all telegram components
└── index.ts                               # Public exports
```

---

## 8. Implementation Plan & Worker Instructions

### Step 1: Create Interfaces & Types
- Create `src/modules/telegram/interfaces/bot-context.interface.ts`.

### Step 2: Implement Request ID & Logging Middleware
- Create `src/modules/telegram/middlewares/telegram-request-id.middleware.ts`.
- Generates `ctx.requestId = crypto.randomUUID()`.
- Logs incoming update event with sanitized fields.

### Step 3: Implement Centralized Exception Filter
- Create `src/modules/telegram/filters/telegram-exception.filter.ts`.
- Implements classification table and safe delivery via `ctx.answerCallbackQuery` or `ctx.reply`.

### Step 4: Implement Authentication Middleware
- Create `src/modules/telegram/middlewares/telegram-auth.middleware.ts`.
- Injects `AuthService` and resolves `BigInt(ctx.from.id)`.
- Rejects unregistered users with tasks.md §7 Russian prompt.
- Rejects deactivated users with `UserDeactivatedException` prompt.
- Attaches `authUser` and permission helpers to `BotContext`.

### Step 5: Implement Webhook Guard & Controller
- Create `src/modules/telegram/guards/telegram-webhook.guard.ts` using `crypto.timingSafeEqual`.
- Create `src/modules/telegram/controllers/telegram-webhook.controller.ts`.

### Step 6: Implement Core Handlers (`StartHandler`, `HelpHandler`)
- Create `src/modules/telegram/handlers/start.handler.ts` with role-based reply keyboard.
- Create `src/modules/telegram/handlers/help.handler.ts`.

### Step 7: Implement TelegramBotService & TelegramModule
- Create `src/modules/telegram/telegram-bot.service.ts` with lifecycle hooks.
- Create `src/modules/telegram/telegram.module.ts`.
- Import `TelegramModule` into `src/app.module.ts`.

### Step 8: Unit Testing
Write unit tests covering all components:
1. `tests/unit/telegram-auth.middleware.spec.ts`:
   - Rejection of unknown Telegram ID with Russian message.
   - Rejection of deactivated user with Russian message.
   - Context enrichment for active user.
2. `tests/unit/telegram-exception.filter.spec.ts`:
   - Mapping of `UnauthorizedUserException`, `PermissionDeniedException`, `PostConflictException`, `ValidationException`, `PostNotFoundException`.
   - Correct invocation of `answerCallbackQuery` vs `reply`.
3. `tests/unit/telegram-webhook.guard.spec.ts`:
   - Verification of valid token matching header.
   - Rejection of mismatched or missing secret tokens.
4. `tests/unit/telegram-bot-lifecycle.spec.ts`:
   - Verification that polling starts in polling mode.
   - Verification that webhook is set in webhook mode.
   - Graceful shutdown stops runner.

---

## 9. Verification & Invalidation Criteria

- **Unit Test Command**: `npm test`
- **E2E Test Command**: `npm run test:e2e`
- **Invalidation Condition**: If an unhandled error inside a Telegram handler causes an unhandled rejection, or if Telegram receives non-200 for normal user input validation errors causing infinite webhook retries, the error boundary must be adjusted to ensure updates always acknowledge 200 while displaying domain errors to the user.
