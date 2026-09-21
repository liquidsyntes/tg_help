# BRIEFING — 2026-09-21T19:20:00Z

## Mission
Investigate and design Post Preview, Review Cards, Editorial Actions & Scheduling UI for Milestone 5 (Post Preview, Review Cards, Editorial Actions & Scheduling UI).

## 🔒 My Identity
- Archetype: teamwork_preview_explorer
- Roles: explorer, investigator, architect/designer
- Working directory: c:/TgHelp/.agents/m5_explorer_3
- Original parent: 6f35b072-3fac-43df-87fc-95e48993acc2
- Milestone: Milestone 5 (Post Preview, Review Cards, Editorial Actions & Scheduling UI)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement production code
- Adhere strictly to AGENTS.md (§3, §7, §9, §10, §13, §15, §20, §24, §26, §27, §51, §52, §53, §54, §64)
- Canonical TelegramRenderer for preview and publish (AGENTS.md §15)
- Transport layer separation (AGENTS.md §3)
- Concurrency & Stale Button Defense (AGENTS.md §7, §13)
- Output files only in `.agents/m5_explorer_3/`

## Current Parent
- Conversation ID: 6f35b072-3fac-43df-87fc-95e48993acc2
- Updated: 2026-09-21T19:20:00Z

## Investigation State
- **Explored paths**:
  - `prisma/schema.prisma`
  - `src/modules/rendering/` (`TelegramRenderer`, `HtmlSanitizer`, `HtmlSplitter`, `TelegramPayload`)
  - `src/infrastructure/telegram-api/` (`TelegramPublisherService`, `ITelegramPublisher`, `TELEGRAM_LIMITS`)
  - `src/modules/posts/` (`PostsService`, `PostWorkflowService`, `PostsRepository`)
  - `src/modules/reviews/` (`ReviewsService`)
  - `src/modules/publishing/` (`PublishingService`, `PublishingPreflightService`, `PublishingProcessor`)
  - `src/modules/scheduling/` (`SchedulingService`, `timezone.util`)
  - `src/modules/notifications/` (`NotificationService`, `DomainEventBus`, domain events)
  - `src/common/` (enums, exceptions, limits)
  - `src/infrastructure/redis/` (`RedisService`)
  - `tests/` (unit, integration, e2e)
- **Key findings**:
  - `sendMediaGroup` does NOT accept `reply_markup` in Telegram Bot API. Solved via the Companion Control Card pattern (preview rendered canonically, followed by an anchor control card holding metadata + inline keyboard).
  - All callback data formats (`<action>:<uuid>:<version>`) strictly fit within 52 bytes ($52 \le 64$ bytes).
  - 4-Tier Concurrency Defense: Codec validation -> Transport version check -> Database OCC (`updateWithOcc`) -> Database unique idempotency key (`publish:{id}:{v}`).
  - Revision request flow requires Redis-backed conversational state for mandatory comment capture (`user:session:{telegramId}`, 15 min TTL).
  - `NotificationService` requires real Telegram delivery via injected `TelegramPublisherService.sendMessage` wrapped in isolated `try/catch`.
- **Unexplored areas**: None within the M5 Explorer 3 scope.

## Key Decisions Made
- Companion Control Card architecture adopted to allow canonical media group preview and in-place control card edits.
- Typesafe `CallbackCodec` designed with 64-byte validation.
- Comprehensive report generated at `c:/TgHelp/.agents/m5_explorer_3/report.md`.
- 5-component handoff report generated at `c:/TgHelp/.agents/m5_explorer_3/handoff.md`.

## Artifact Index
- `c:/TgHelp/.agents/m5_explorer_3/DISPATCH.md` — Initial dispatch instructions
- `c:/TgHelp/.agents/m5_explorer_3/BRIEFING.md` — Persistent situational awareness
- `c:/TgHelp/.agents/m5_explorer_3/progress.md` — Liveness and progress tracker
- `c:/TgHelp/.agents/m5_explorer_3/report.md` — Comprehensive architecture & design report
- `c:/TgHelp/.agents/m5_explorer_3/handoff.md` — 5-component handoff report
