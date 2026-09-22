# Quality & Adversarial Review Report — Milestone 5 (Telegram Transport & Interactive Wizard UI)

**Reviewer**: `m5_reviewer_1` (teamwork_preview_reviewer)  
**Roles**: reviewer, critic  
**Date**: 2026-09-21  
**Milestone**: Milestone 5 — Telegram Transport & Interactive Wizard UI  
**Target Path**: `c:/TgHelp`  

---

## Review Summary

**Verdict**: **APPROVE**

Milestone 5 implements a robust, well-architected Telegram bot transport layer adhering strictly to `AGENTS.md` (§3, §4, §5, §8, §9, §10, §11, §12, §13, §14, §15, §16, §18, §27, §36, §51, §52, §54) and `tasks.md` specifications.

All required interfaces, lifecycle behaviors, security checks, and interactive wizard flows are fully implemented with zero shortcuts, zero facade implementations, and zero integrity violations. Independent verification confirms that the application compiles cleanly (`npm run build`, `tsc --noEmit`), and all 452 unit tests and 34 E2E tests pass with a 100% success rate.

---

## 1. Dimensional Review

### 1.1 Bot Lifecycle & Dual Transport (`telegram-bot.service.ts`, `telegram-webhook.guard.ts`, `telegram-webhook.controller.ts`)
- **Lifecycle Management**: `TelegramBotService` manages grammY initialization, middleware assembly order (`requestId` -> `exceptionFilter` -> `authMiddleware`), and graceful shutdown (`onApplicationShutdown` stops the runner).
- **Dual Transport Mode**: Supports both `polling` via `@grammyjs/runner` (with automatic deletion of webhooks) and `webhook` mode (`setWebhook` with `secret_token`).
- **Test Isolation**: In automated test execution (`isTest: true`), polling and webhook network calls are safely bypassed, preventing network timeouts.
- **Timing-Safe Webhook Guard**: `TelegramWebhookGuard` implements constant-time comparison via `crypto.timingSafeEqual` with buffer length validation, thwarting timing attack vectors.

### 1.2 Authentication & RBAC Middleware (`telegram-auth.middleware.ts`)
- **Telegram ID Identity**: Reliably resolves Telegram ID as `BigInt(fromUser.id)` via `AuthService.resolveUser`.
- **Unregistered User Rejection**: Unregistered users are immediately rejected with the standardized Russian prompt specifying their numeric Telegram ID (`tasks.md §7`). Non-text callback queries are answered with `show_alert: true`. Middleware propagation halts (`next()` is not called).
- **Deactivated User Rejection**: Deactivated users (throwing `UserDeactivatedException`) are blocked with a clear Russian rejection prompt.
- **Context Enrichment**: Attaches `authUser`, `isSuperAdmin`, and `canChannel` permission-checking helpers to `BotContext`.

### 1.3 Centralized Exception Boundary (`telegram-exception.filter.ts`)
- **Exhaustive Mapping**: All domain and infrastructure exceptions (`UnauthorizedUserException`, `UserDeactivatedException`, `PermissionDeniedException`, `PostConflictException`, `IdempotencyConflictException`, `InvalidPostStateTransitionException`, `ValidationException`, `PostNotFoundException`, `ChannelNotFoundException`, `TemplateNotFoundException`, `TelegramRateLimitException`, `TelegramRetryableException`, `TelegramPermanentException`) are mapped to clear, empathetic Russian user messages.
- **Interactive Alerts**: For callback queries, messages $\le 180$ characters trigger Telegram native modal dialogs (`show_alert: true`), while larger payloads reply in chat.
- **Sanitization & Safety**: Validation error messages are stripped of raw markup delimiters (`<>&`), and message delivery errors are caught locally to prevent unhandled rejection loops.

### 1.4 Post Wizard & Immediate Autosave (`post-wizard.service.ts`, `post-wizard.handler.ts`)
- **Dynamic Schema-Driven Loop**: The wizard dynamically iterates over fields defined in `template.schemaJson.fields`.
- **Immediate PostgreSQL Autosave (AGENTS.md §11, §12)**:
  - Initial draft is created immediately in PostgreSQL upon template selection (`status: DRAFT`, `version: 1`).
  - Every field input immediately triggers `PostsService.autosaveStep`, updating `contentJson` in PostgreSQL and incrementing the database `version`.
  - In-memory state is never the source of truth. Redis holds only transient session metadata (`step`, `fieldIndex`, `expectedVersion`).
- **Required vs Optional Field Handling**: Required fields cannot be skipped; optional fields allow skipping and store `null`.
- **Media Debouncing**: Multi-file media group uploads (albums) are buffered in Redis with a 600ms debounce timer before batch attachment (`attachMediaBatch`), avoiding race conditions.

### 1.5 Draft Resumption & Granular Editing (`draft-manager.service.ts`, `draft-manager.handler.ts`)
- **Resumption from First Missing Field**: `resumeDraft` inspects `template.schemaJson.fields` against database `contentJson` to locate the first unfilled required field. If all required fields are filled, it presents the Control Card.
- **Granular Single-Field Editing**: Supports editing individual fields (`startEditField` / `submitEditedField`) under optimistic concurrency control without restarting the wizard (`tasks.md §11`).
- **Soft-Deletion**: Enforces safe draft soft-deletion under OCC with explicit user confirmation.

### 1.6 Canonical Preview & Companion Control Card (`telegram-preview.service.ts`, `post-controls.keyboard.ts`)
- **Canonical Rendering Parity (AGENTS.md §15)**: `TelegramPreviewService` invokes `TelegramRenderer.render`, guaranteeing that preview formatting strictly matches publication output.
- **Companion Control Card Pattern**: Because Telegram Bot API prohibits `reply_markup` on media groups (albums), the service dispatches preview message(s) followed by a dedicated Companion Control Card message containing the inline action keyboard.
- **Stale UI Protection (AGENTS.md §51, §52)**: Callback actions encode expected versions (`<action>:<postId>:<version>`). When an OCC version mismatch occurs, handlers update the Control Card in-place with an explanatory warning banner rather than executing stale actions.

---

## 2. Adversarial Challenges & Edge-Case Analysis

### Challenge 1: Concurrent Post Modification During Wizard / Review
- **Assumption Challenged**: Can two users (or two browser/bot sessions) concurrently modify or act upon the same post and corrupt state?
- **Analysis**: All state changes and autosaves pass through `PostsService.autosaveStep` or `PostWorkflowService.transition`, which execute SQL queries with `WHERE id = :id AND version = :expectedVersion`.
- **Finding**: On conflict, `PostConflictException` is raised. `TelegramExceptionFilter` maps this to an alert, and `ReviewQueueHandler` / `PostActionsHandler` refresh the Control Card in-place with current DB data.
- **Risk Level**: **LOW (Defended)**.

### Challenge 2: Total Redis Cache Flush During Post Creation
- **Assumption Challenged**: If Redis crashes or undergoes `FLUSHALL` while an author is halfway through post creation, is the draft lost?
- **Analysis**: Because `selectTemplate` and `processFieldInput` persist each step immediately into PostgreSQL (`posts` table), the post content and filled fields remain intact in the database.
- **Finding**: Calling `/drafts` or `DraftManagerService.resumeDraft` inspects PostgreSQL, re-evaluates `template.schemaJson.fields`, identifies the first unfilled required field, and rebuilds the wizard session seamlessly.
- **Risk Level**: **LOW (Defended)**.

### Challenge 3: Telegram Callback Data 64-Byte Limit Overflow
- **Assumption Challenged**: Can a long UUID or large version number cause `callback_data` to exceed Telegram's strict 64-byte payload limit?
- **Analysis**: `CallbackCodec` uses compact action prefixes (`r:app`, `p:sub`, `pub:sch`) with 36-byte UUIDs and numeric versions. Max payload length is 52 bytes. `CallbackCodec.encode` explicitly verifies `byteLength <= 64` and throws an error if exceeded.
- **Risk Level**: **LOW (Defended)**.

---

## 3. Verified Claims

| Claim | Verification Command / Method | Result |
|---|---|:---:|
| TypeScript Strict Compilation | `npm run build` & `npx tsc --project tsconfig.build.json --noEmit` | PASS (0 errors) |
| Unit Test Suite (30 Suites, 452 Tests) | `npm test` | PASS (100% pass) |
| E2E Test Suite (22 Suites, 34 Tests) | `npm run test:e2e` | PASS (100% pass) |
| Zero `any` casts in `src/modules/telegram/` | Codebase grep for `: any` and `as any` | PASS (0 matches) |
| Zero direct Prisma queries in handlers | Codebase grep for `prisma` in `handlers/` | PASS (0 matches) |
| Integrity Check (No hardcoded/facade bypasses) | Code review of all services and handlers | PASS |

---

## 4. Minor Observations (Non-Blocking)

1. **ReviewQueueService Direct Prisma Queries**: `ReviewQueueService` queries channels and posts using `PrismaService` directly. While this conforms to `AGENTS.md §3` because it is an application service (not a handler), encapsulating these queries into `PostsRepository` and `ChannelsRepository` would further strengthen abstraction in future refactorings.
2. **Media Group Debounce Timer Scope**: `albumTimers` in `PostWizardService` uses an in-memory `Map<string, NodeJS.Timeout>`. This is fully functional for the single-process MVP bot instance. If horizontal multi-instance scaling is introduced in the future, transitioning the debounce mechanism to BullMQ delayed jobs will ensure cross-instance coordination.
3. **ESLint v9 Configuration File**: Running `npm run lint` reports an ESLint 9 configuration migration notice due to the legacy `.eslintrc.js` format. This does not affect TypeScript compilation or runtime behavior, but can be updated during maintenance.

---

## 5. Review Verdict

**APPROVE**  
Milestone 5 is fully implemented, verified, and ready for Milestone 6 (E2E Testing & Adversarial Hardening).
