# Handoff Report: Telegram Transport, Bot Lifecycle, and Authentication Middleware (Milestone 5)

**Agent**: `m5_explorer_1`  
**Working Directory**: `c:/TgHelp/.agents/m5_explorer_1`  
**Report**: `c:/TgHelp/.agents/m5_explorer_1/report.md`  
**Handoff Type**: Hard (Complete investigation and design)

---

## 1. Observation

1. **Configuration & Mode Parameters** (`src/infrastructure/config/environment.variables.ts:20-22, 70-87`):
   - `TELEGRAM_MODE`: enum `TelegramMode.POLLING` (`'polling'`) or `TelegramMode.WEBHOOK` (`'webhook'`).
   - `WEBHOOK_DOMAIN`: optional string.
   - `WEBHOOK_PATH`: string, defaults to `'/telegram/webhook'`.
   - `WEBHOOK_SECRET_TOKEN`: optional string.
   - `BOT_TOKEN`: string matching `/^\d+:[A-Za-z0-9_-]{35,}$/`.
2. **Existing Authentication & Permissions** (`src/modules/auth/auth.service.ts:15-46`, `src/modules/auth/permission.service.ts:14-89`):
   - `AuthService.resolveUser(telegramId: bigint | number | string): Promise<AuthUser | null>` converts input to `BigInt(telegramId)`.
   - If user is not found in database: returns `null`.
   - If user is deactivated (`!user.isActive`): throws `UserDeactivatedException(parsedId)`.
   - If active: returns `AuthUser` containing `id` (database UUID), `telegramId` (`bigint`), `systemRole`, and `channelMemberships`.
   - `PermissionService.checkChannelPermission`: Evaluates granular permissions (`CREATE_POST`, `PUBLISH_POST`, `APPROVE_POST`, etc.) with `SUPER_ADMIN` system bypass.
3. **Domain Exceptions** (`src/common/exceptions/domain.exceptions.ts:17-44, 76-91, 129-136`):
   - `UnauthorizedUserException` (statusCode: 401, errorCode: `UNAUTHORIZED_USER`, userFriendlyMessage: `'У вас пока нет доступа к редакции. Обратитесь к администратору.'`).
   - `UserDeactivatedException` (statusCode: 403, errorCode: `USER_DEACTIVATED`, userFriendlyMessage: `'Ваш аккаунт деактивирован. Обратитесь к администратору.'`).
   - `PermissionDeniedException` (statusCode: 403, errorCode: `PERMISSION_DENIED`).
   - `PostConflictException` (statusCode: 409, errorCode: `POST_CONFLICT`).
   - `ValidationException` (statusCode: 400, errorCode: `VALIDATION_ERROR`).
4. **Existing Application Module Tree** (`src/app.module.ts:1-46`):
   - `AppModule` imports all foundational and domain modules (Auth, Users, Posts, Templates, Media, Reviews, Scheduling, Publishing, TelegramApi), but does not yet import `TelegramModule`.
   - In `src/worker.module.ts:1-24`, only background infrastructure and publishing modules are imported, maintaining complete separation between `app` and `worker` processes (`AGENTS.md` §65).
5. **Test Suite Baseline** (executed commands):
   - Command `npm test`: 20 test suites passed, 401 tests passed, 0 failures.
   - Command `npm run test:e2e`: 4 suites passed, 34 tests passed, 0 failures.

---

## 2. Logic Chain

1. **Transport Isolation (`AGENTS.md` §3, §5, §36)**:
   - Observation 4 shows `TelegramApiModule` is used for outgoing API calls in workers and services, while incoming updates have no transport module yet.
   - Setting up `TelegramModule` in `src/modules/telegram/` provides the transport boundary.
   - Telegram handlers must receive updates, convert Telegram IDs to domain UUIDs via `AuthService.resolveUser`, and invoke application services (`PostsService`, `PostWorkflowService`) rather than containing business logic directly.
2. **Dual Transport Lifecycle (`tasks.md` §28, §29, `PROJECT.md` F-47)**:
   - Based on Observation 1, the app needs both `webhook` and `polling` support.
   - In polling mode: `@grammyjs/runner` manages update polling and graceful shutdown (`onApplicationShutdown`), preceded by `deleteWebhook` during `onModuleInit` to prevent Telegram conflicts.
   - In webhook mode: `POST /telegram/webhook` is handled by `TelegramWebhookController`, guarded by `TelegramWebhookGuard` verifying `X-Telegram-Bot-Api-Secret-Token` via constant-time comparison `crypto.timingSafeEqual` (`tasks.md` §30).
3. **Authentication & RBAC Middleware Flow (`tasks.md` §7, `AGENTS.md` §8, §9, `ORIGINAL_REQUEST.md` AC)**:
   - Based on Observation 2, `AuthService.resolveUser` provides the exact contract needed.
   - An incoming update without a sender is ignored.
   - If `resolveUser` returns `null` (unregistered): reply with `У вас пока нет доступа к редакции. Обратитесь к администратору.` showing the user's Telegram ID, and halt propagation immediately (satisfying the acceptance criterion "Users without proper permissions are rejected immediately upon /start").
   - If `resolveUser` throws `UserDeactivatedException`: reply with `Ваш аккаунт деактивирован. Обратитесь к администратору.` and halt propagation.
   - If active: attach `ctx.authUser` and permission helper functions to `BotContext`, and continue down the middleware chain.
4. **Centralized Error Handling (`AGENTS.md` §32)**:
   - Based on Observation 3, all domain exceptions have specific error codes and meanings.
   - In grammY, wrapping the pipeline in an error boundary middleware and configuring `bot.catch` intercepts all thrown domain and infrastructure errors.
   - For callback queries, `ctx.answerCallbackQuery` is called with `show_alert: true` to halt button loading spinners and display friendly alerts.
   - For messages, `ctx.reply` sends sanitized HTML messages.
   - Diagnostics are logged in structured JSON via `StructuredLoggerService`, and sensitive variables (`BOT_TOKEN`) are never leaked (`AGENTS.md` §33, §34).

---

## 3. Caveats

1. **Telegram Client Callback Query Limit**: Telegram limits callback query alert messages to 200 characters. For errors longer than 180 characters, the error filter must answer the callback query without alert and reply with a separate chat message.
2. **Test Mode Polling Suppression**: During unit and automated integration test runs (`config.isTest === true`), network polling must be suppressed to avoid socket timeouts or collisions with live Telegram bots.
3. **Interactive Wizard Scope**: Interactive multi-step draft forms (F-07 through F-14) will build on top of this transport and auth foundation in subsequent M5 tasks.

---

## 4. Conclusion

The architectural design for Telegram Transport, Bot Lifecycle, and Authentication Middleware is complete, strictly adheres to `AGENTS.md` and `tasks.md`, and is fully documented in `c:/TgHelp/.agents/m5_explorer_1/report.md`.

Key components designed for the worker:
1. `TelegramBotService` in `src/modules/telegram/telegram-bot.service.ts` managing grammY setup, `@grammyjs/runner` polling, and webhook registration.
2. `TelegramWebhookController` and `TelegramWebhookGuard` in `src/modules/telegram/controllers/` and `guards/` handling `POST /telegram/webhook` with constant-time token comparison.
3. `TelegramAuthMiddleware` in `src/modules/telegram/middlewares/telegram-auth.middleware.ts` enforcing authentication and context enrichment.
4. `TelegramExceptionFilter` in `src/modules/telegram/filters/telegram-exception.filter.ts` providing centralized Russian error mapping.
5. `StartHandler` and `HelpHandler` in `src/modules/telegram/handlers/` rendering role-tailored menus.

---

## 5. Verification Method

To verify the implementation once coded:
1. **Unit Test Suite**:
   ```bash
   npm test
   ```
   All 401 existing unit tests must remain passing, plus new unit test suites for:
   - `tests/unit/telegram-auth.middleware.spec.ts`
   - `tests/unit/telegram-exception.filter.spec.ts`
   - `tests/unit/telegram-webhook.guard.spec.ts`
   - `tests/unit/telegram-bot-lifecycle.spec.ts`
2. **E2E Test Suite**:
   ```bash
   npm run test:e2e
   ```
   All 34 E2E tests across Tiers 1–4 must continue to pass without regression.
3. **Invalidation Conditions**:
   - If an unhandled domain exception causes an HTTP 500 response on the webhook endpoint, Telegram will trigger repeated delivery attempts. The error boundary must guarantee HTTP 200 response while presenting the domain error message to the user.
   - If an unregistered user sends `/start` and receives anything other than the prompt "У вас пока нет доступа к редакции. Обратитесь к администратору.", the acceptance criterion is violated.
