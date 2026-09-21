# BRIEFING — 2026-09-21T19:08:00Z

## Mission
Investigate and design Telegram Transport, Bot Lifecycle, and Authentication Middleware for Milestone 5.

## 🔒 My Identity
- Archetype: explorer
- Roles: teamwork_preview_explorer
- Working directory: c:/TgHelp/.agents/m5_explorer_1
- Original parent: 6f35b072-3fac-43df-87fc-95e48993acc2
- Milestone: Milestone 5

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Follow AGENTS.md (§3, §4, §5, §8, §9, §32, §36, §37)
- Dual transport mode (Webhook with secret_token validation, Polling for dev)
- Centralized exception filter mapping domain errors to friendly Russian messages
- Do not modify source code directly; write designs, reports, and recommendations

## Current Parent
- Conversation ID: 6f35b072-3fac-43df-87fc-95e48993acc2
- Updated: 2026-09-21T19:08:00Z

## Investigation State
- **Explored paths**: `src/modules/auth/`, `src/modules/users/`, `src/modules/posts/`, `src/infrastructure/config/`, `src/infrastructure/telegram-api/`, `src/common/exceptions/`, `tests/`, `package.json`, `prisma/schema.prisma`, `prisma/seed.ts`.
- **Key findings**:
  1. Full dual transport lifecycle designed: `@grammyjs/runner` for polling with graceful teardown, and `POST /telegram/webhook` with `TelegramWebhookGuard` using `crypto.timingSafeEqual`.
  2. `TelegramAuthMiddleware` resolves Telegram ID (`BigInt`) via `AuthService.resolveUser`, rejecting unregistered and deactivated users immediately per acceptance criteria, and attaching typed user identities and permission checkers to `BotContext`.
  3. `TelegramExceptionFilter` provides centralized error boundary and maps domain exceptions (`UnauthorizedUserException`, `UserDeactivatedException`, `PermissionDeniedException`, `PostConflictException`, `ValidationException`, `PostNotFoundException`, etc.) to clear Russian user messages, answering callback queries with `show_alert: true`.
  4. Role-based menu dynamically renders Author vs Editor/Admin menu per `tasks.md` §8.
- **Unexplored areas**: None for this investigation scope; ready for Worker implementation.

## Key Decisions Made
- Use `@grammyjs/runner` for concurrent polling and graceful stop in development.
- Use `crypto.timingSafeEqual` in `TelegramWebhookGuard` to prevent timing attacks on Telegram secret token.
- Extend grammY `Context` via `BotContextFlavor` with `authUser`, `requestId`, `isSuperAdmin`, `canChannel`.
- Route domain error messages through centralized filter handling both callback queries (`show_alert: true`) and text replies.
- Written comprehensive `report.md` and 5-component `handoff.md`.

## Artifact Index
- c:/TgHelp/.agents/m5_explorer_1/DISPATCH.md — Stored dispatch prompt
- c:/TgHelp/.agents/m5_explorer_1/progress.md — Liveness heartbeat and task progress
- c:/TgHelp/.agents/m5_explorer_1/report.md — Detailed investigation report
- c:/TgHelp/.agents/m5_explorer_1/handoff.md — 5-component handoff report
