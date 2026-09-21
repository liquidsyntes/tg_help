# Changes Report — Milestone 5 (Telegram Transport & Interactive Wizard UI)

**Agent**: `m5_worker_1` (teamwork_preview_worker)  
**Date**: 2026-09-21  
**Milestone**: Milestone 5 — Telegram Transport & Interactive Wizard UI  

---

## Summary of Changes

Milestone 5 implements the complete Telegram bot transport layer for the Telegram Content Publisher Bot MVP. In strict adherence to `AGENTS.md` (§3, §5), all Telegram handlers function exclusively as transport controllers that authenticate incoming updates, validate payload shapes, invoke application and domain services, and render output via the canonical rendering pipeline. No business logic, direct Prisma queries, or background publishing operations are located inside Telegram handlers.

---

## Files Created

### 1. Telegram Module Core & Lifecycle (`src/modules/telegram/`)
- `telegram.module.ts`: NestJS module registering all telegram controllers, handlers, services, middlewares, filters, and guards.
- `telegram-bot.service.ts`: Manages the grammY `Bot<BotContext>` lifecycle, dual transport support (production Webhook + local polling via `@grammyjs/runner`), graceful shutdown (`onApplicationShutdown`), test environment suppression, and unhandled error logging.
- `index.ts`: Barrel export for the telegram module.

### 2. Controllers & Guards (`src/modules/telegram/controllers/`, `guards/`)
- `controllers/telegram-webhook.controller.ts`: Handles incoming Telegram updates via `POST /telegram/webhook` with `TelegramWebhookGuard`.
- `guards/telegram-webhook.guard.ts`: Timing-safe token comparison (`crypto.timingSafeEqual`) validating `X-Telegram-Bot-Api-Secret-Token` against `WEBHOOK_SECRET_TOKEN` to prevent timing attacks.

### 3. Middlewares & Filters (`src/modules/telegram/middlewares/`, `filters/`)
- `middlewares/telegram-request-id.middleware.ts`: Generates structured `requestId` for every update, binds context, and emits trace logs.
- `middlewares/telegram-auth.middleware.ts`: Resolves actor via `AuthService.resolveUser(telegramId)`. Rejects unregistered users with a friendly Russian message containing their numeric ID. Rejects deactivated users. Binds `authUser`, `isSuperAdmin`, and `canChannel` permission checking functions to `BotContext`.
- `filters/telegram-exception.filter.ts`: Centralized grammY error boundary mapping domain exceptions (`UnauthorizedUserException`, `UserDeactivatedException`, `PermissionDeniedException`, `PostConflictException`, `ValidationException`, `PostNotFoundException`, etc.) into empathetic Russian messages. Answers callback queries with `show_alert: true` for pop-up dialogs.

### 4. Interfaces & Session Types (`src/modules/telegram/interfaces/`)
- `interfaces/bot-context.interface.ts`: Defines `BotContextFlavor` and `BotContext` extending grammY `Context` with `requestId`, `authUser`, `isSuperAdmin`, and `canChannel`.
- `interfaces/wizard-session.interface.ts`: Strongly typed interfaces for `WizardSessionData`, `ReviewSessionData`, and `ScheduleSessionData` stored in Redis.

### 5. Transport Keyboards (`src/modules/telegram/keyboards/`)
- `keyboards/main-menu.keyboard.ts`: Role-based persistent reply keyboards (Author menu vs Editor/Admin menu).
- `keyboards/wizard.keyboard.ts`: Channel selection buttons, template selection buttons, field input controls (Skip, Cancel), and media upload controls (Done, Cancel).
- `keyboards/post-controls.keyboard.ts`: Companion Control Card inline action buttons based on `PostStatus` and user permissions (Submit for review, Edit field, Delete draft, Approve, Request revision, Reject, Publish now, Schedule, Cancel schedule, Retry publish, Back to drafts).

### 6. Codecs & Utilities (`src/modules/telegram/utils/`)
- `utils/callback-data.codec.ts`: Compact serialization/deserialization strictly under Telegram's 64-byte limit (max 52 bytes for action:postId:version).
- `utils/status-formatter.util.ts`: Russian emoji status badges for all 10 `PostStatus` enum values.
- `utils/entity-converter.util.ts`: Converts Telegram `MessageEntity[]` into Telegram-compliant HTML tags.
- `utils/media-extractor.util.ts`: Extracts `AttachMediaDto` directly from grammY messages (zero-download principle). Detects video sent as uncompressed document.

### 7. Transport Services (`src/modules/telegram/services/`)
- `services/telegram-preview.service.ts`: Renders canonical preview via `TelegramRenderer` and delivers or in-place updates the Companion Control Card.
- `services/post-wizard.service.ts`: Multi-step post creation wizard with immediate PostgreSQL autosave (`PostsService.autosaveStep`) after every field. Zero reliance on in-memory state. Buffers media group items in Redis with 600ms debounce timer.
- `services/draft-manager.service.ts`: Lists author drafts, resumes incomplete drafts from the first missing required field, and performs granular single-field editing under OCC.
- `services/review-queue.service.ts`: Multi-channel pending review card deck navigation and formatting.

### 8. Handlers (`src/modules/telegram/handlers/`)
- `handlers/start.handler.ts`: `/start` greeting and role-tailored menu rendering.
- `handlers/help.handler.ts`: `/help` command displaying role-tailored instructions.
- `handlers/post-wizard.handler.ts`: Orchestrates channel pick, template pick, step-by-step field prompt/input, skip, and media upload.
- `handlers/draft-manager.handler.ts`: Handles `/drafts`, draft selection, resumption, granular editing, and draft deletion.
- `handlers/review-queue.handler.ts`: Handles `/reviews`, card deck pagination, approval, rejection, and revision request with mandatory feedback comment captured via Redis session.
- `handlers/post-actions.handler.ts`: Handles submission for review, publishing now, scheduling with quick presets or custom date in channel timezone, schedule cancellation, and manual retry.

### 9. Test Suites (`tests/unit/`)
- `tests/unit/telegram-auth.middleware.spec.ts`
- `tests/unit/telegram-exception.filter.spec.ts`
- `tests/unit/telegram-webhook.guard.spec.ts`
- `tests/unit/callback-data.codec.spec.ts`
- `tests/unit/post-controls.keyboard.spec.ts`
- `tests/unit/post-wizard.service.spec.ts`
- `tests/unit/draft-manager.service.spec.ts`
- `tests/unit/telegram-preview.service.spec.ts`
- `tests/unit/review-queue.service.spec.ts`
- `tests/unit/telegram-bot-lifecycle.spec.ts`

---

## Files Modified

1. `src/app.module.ts`:
   - Imported `TelegramModule` into root application module.
2. `src/modules/notifications/notification.module.ts`:
   - Imported `TelegramApiModule` to supply `TELEGRAM_PUBLISHER`.
3. `src/modules/notifications/notification.service.ts`:
   - Injected optional `ITelegramPublisher` (`TELEGRAM_PUBLISHER`).
   - Added outbound Telegram message dispatch via `sendTelegramMessageSafely` in a non-blocking `try/catch` block (`AGENTS.md §27`).
4. `src/modules/telegram/handlers/post-actions.handler.ts`:
   - Enforced type-safe `ChannelPermission.APPROVE_POST` and `ChannelPermission.PUBLISH_POST` permission checks.
5. `src/modules/telegram/handlers/review-queue.handler.ts`:
   - Enforced type-safe `ChannelPermission.APPROVE_POST` and `ChannelPermission.PUBLISH_POST` permission checks.
6. `src/modules/telegram/handlers/draft-manager.handler.ts`:
   - Enforced type-safe `ChannelPermission.APPROVE_POST` and `ChannelPermission.PUBLISH_POST` permission checks.
7. `src/modules/telegram/handlers/post-wizard.handler.ts`:
   - Enforced type-safe `ChannelPermission.APPROVE_POST` and `ChannelPermission.PUBLISH_POST` permission checks.
8. `src/modules/telegram/telegram-bot.service.ts`:
   - Implemented typed `Update` boundary cast instead of `any`.
