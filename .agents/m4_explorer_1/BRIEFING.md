# BRIEFING — 2026-09-21T14:02:00Z

## Mission
Investigate and design the Publishing Queue & BullMQ Worker Architecture for Milestone 4 (Queue definition, BullMQ worker processor, database-enforced idempotency key, state machine integration, PublishingService enqueueing, and implementation roadmap).

## 🔒 My Identity
- Archetype: explorer
- Roles: teamwork_preview_explorer
- Working directory: c:/TgHelp/.agents/m4_explorer_1
- Original parent: 6f35b072-3fac-43df-87fc-95e48993acc2
- Milestone: Milestone 4 (Publishing Engine & BullMQ Idempotency)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement in source code
- Strictly respect AGENTS.md (§20, §21, §22, §28, §30) and tasks.md (§20, §21, §22, §26)
- Keep state machine transitions managed via PostWorkflowService with OCC and audit logging
- Output analysis report to .agents/m4_explorer_1/report.md and handoff report to .agents/m4_explorer_1/handoff.md
- Notify parent orchestrator via send_message when complete

## Current Parent
- Conversation ID: 6f35b072-3fac-43df-87fc-95e48993acc2
- Updated: 2026-09-21T14:02:00Z

## Investigation State
- **Explored paths**:
  - `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`
  - `c:/TgHelp/.agents/PROJECT.md`
  - `c:/TgHelp/.agents/TEST_READY.md`
  - `c:/TgHelp/tasks.md` (§20, §21, §22, §26)
  - `c:/TgHelp/AGENTS.md` (§10, §20, §21, §22, §28, §30)
  - `prisma/schema.prisma` (`PublicationJob`, `Post`, `Channel`, `User`, `AuditLog`)
  - `src/infrastructure/queues/queue.module.ts` and `src/common/constants/queue-names.ts`
  - `src/worker.main.ts` and `src/worker.module.ts`
  - `src/modules/posts/post-workflow.service.ts`, `posts.repository.ts`, `posts.service.ts`
  - `src/modules/rendering/telegram-renderer.service.ts` and `interfaces/telegram-payload.interface.ts`
  - `src/modules/auth/permission.service.ts`
  - `tests/harness/test-harness.ts`, `tests/mocks/mock-telegram-publisher.ts`, and all E2E spec suites (Tiers 1-4)
- **Key findings**:
  - BullMQ queue `publication` registered in `QueueModule` with 3 attempts and 2s exponential backoff.
  - Idempotency key format is `publish:{postId}:{postVersion}`, strictly enforced via database unique constraint on `PublicationJob.idempotencyKey`.
  - Double-click and concurrent race prevention via atomic Prisma create with `P2002` conflict catch-and-return-existing pattern.
  - State machine lifecycle `APPROVED/SCHEDULED -> PUBLISHING -> PUBLISHED` (or `PUBLISH_FAILED` upon retry exhaustion), guarded against invalid `PUBLISHING -> PUBLISHING` transitions on worker retries.
  - Partial publishing resume: each sent message part's Telegram message ID is durably recorded in `PublicationJob.telegramMessageIds`; worker skips already-sent parts on retry.
  - External Telegram API calls isolated behind `ITelegramPublisher` abstraction.
- **Unexplored areas**:
  - None within Milestone 4 scope.

## Key Decisions Made
- Confirmed that `PublishJobData` payload contains `{ postId, postVersion, channelId, actorId, enqueuedAt }`.
- Designed `PublishingProcessor` with concurrency 5, 30s lock duration, token-bucket limiter (20 msgs/s), and `onModuleDestroy` graceful shutdown.
- Mapped out step-by-step implementation roadmap for builder agents.

## Artifact Index
- `c:/TgHelp/.agents/m4_explorer_1/DISPATCH.md` — Initial dispatch message
- `c:/TgHelp/.agents/m4_explorer_1/BRIEFING.md` — Agent state and persistent memory
- `c:/TgHelp/.agents/m4_explorer_1/progress.md` — Liveness heartbeat
- `c:/TgHelp/.agents/m4_explorer_1/report.md` — Comprehensive architectural investigation and design report
- `c:/TgHelp/.agents/m4_explorer_1/handoff.md` — Standard 5-component hard handoff report
