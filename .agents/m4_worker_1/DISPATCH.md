## 2026-09-21T14:01:39Z
You are m4_worker_1, a teamwork_preview_worker.
Your working directory is: c:/TgHelp/.agents/m4_worker_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (specifically §20, §21, §22, §23, §24, §25, §27, §28, §30, §48, §49, §50, §65)
- c:/TgHelp/tasks.md (specifically §20, §21, §22, §23, §24, §25, §27)
- c:/TgHelp/.agents/m4_explorer_1/report.md (Queue, BullMQ Worker, Idempotency & Transitions)
- c:/TgHelp/.agents/m4_explorer_2/report.md (TelegramPublisher Abstraction, Error Classification & Mock Double)
- c:/TgHelp/.agents/m4_explorer_3/report.md (Scheduling, Two-Stage Preflight & Partial Publish Resume)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Mission:
Implement Milestone 4 (Publishing Engine & BullMQ Idempotency) in c:/TgHelp:

1. Telegram API Abstraction (src/infrastructure/telegram-api/):
   - Implement ITelegramPublisher interface: accept chatId: string | bigint, methods: sendMessage, sendPhoto, sendVideo, sendDocument, sendAnimation, sendMediaGroup, publishOutgoingMessage.
   - Implement TelegramPublisherService: wraps grammY Api (bot.api) cleanly.
   - Implement TelegramErrorClassifier: tri-tier error classification:
     a) RATE_LIMITED (HTTP 429, extract parameters.retry_after)
     b) RETRYABLE (network timeouts, 5xx server errors, connection resets)
     c) PERMANENT (HTTP 400 chat not found/invalid payload, HTTP 403 bot kicked/forbidden/not admin)
   - Implement TelegramApiModule and export TELEGRAM_PUBLISHER provider.
   - Update tests/mocks/mock-telegram-publisher.ts to implement full ITelegramPublisher while preserving 100% backward compatibility with existing tests.

2. Publishing Module (src/modules/publishing/):
   - Implement PublishingPreflightService:
     - Stage 1 (pre-enqueue): verifies post is APPROVED, template valid, content schema valid, media group invariants sound, dry-run render succeeds.
     - Stage 2 (worker pre-send): verifies post exists and not soft-deleted, status is valid (APPROVED/SCHEDULED/PUBLISHING), channel active, bot admin rights verified.
   - Implement PublishingService:
     - enqueuePublish(postId, actorId): validates channel permissions, performs Stage 1 preflight, generates idempotency key `publish:{postId}:{postVersion}`.
     - Creates PublicationJob record in DB (handling P2002 duplicate key collision gracefully to return existing job).
     - Adds job to BullMQ publication queue with jobId: idempotencyKey.
   - Implement PublishingProcessor (BullMQ Worker):
     - Extends WorkerHost (@Processor(PUBLICATION_QUEUE_NAME)), concurrency 5.
     - Transitions post APPROVED/SCHEDULED -> PUBLISHING on start (guards against re-transition if already PUBLISHING on retry).
     - Renders payload via TelegramRenderer.
     - Executes multi-message dispatch loop: after each part succeeds, persists message IDs in PublicationJob.telegramMessageIds.
     - Partial publication resume: on retry, checks already-persisted message IDs and skips already-sent parts (Rule F-26).
     - On completion: transitions post PUBLISHING -> PUBLISHED with publishedAt = now(), writes audit log, dispatches PostPublishedEvent.
     - On error: classifies via TelegramErrorClassifier. If RATE_LIMITED, delays BullMQ retry by retry_after. If PERMANENT or attempts exhausted, transitions post PUBLISHING -> PUBLISH_FAILED, writes audit log, dispatches PostPublicationFailedEvent, and throws UnrecoverableError.
     - Implements OnModuleDestroy (graceful close).
   - Implement PublishingModule.

3. Scheduling Module (src/modules/scheduling/):
   - Implement SchedulingService:
     - schedulePost(postId, scheduledAt, actorId): accepts user datetime in channel timezone (Europe/Kyiv by default via Luxon timezone.util.ts), validates future date, converts to UTC TIMESTAMPTZ.
     - Transitions post APPROVED -> SCHEDULED with OCC increment and audit log.
     - Enqueues delayed BullMQ job (delay = scheduledTime - Date.now()).
     - cancelSchedule(postId, actorId): cancels delayed BullMQ job, marks PublicationJob as CANCELLED, transitions post SCHEDULED -> CANCELLED (or APPROVED) with audit log.
   - Implement SchedulingModule.

4. Integration & App Wiring:
   - Register TelegramApiModule, PublishingModule, SchedulingModule in src/app.module.ts and src/worker.module.ts.

5. Comprehensive Unit Testing:
   - Add tests/unit/publishing.spec.ts (enqueue, idempotency, preflight, worker processing, retries, partial resume).
   - Add tests/unit/scheduling.spec.ts (timezone conversion, delayed job calculation, cancellation).
   - Add tests/unit/telegram-publisher.spec.ts (error classification, rate limit delay extraction, ITelegramPublisher methods).

6. Verification:
   - Run npm run build and verify clean compilation.
   - Run npm test and verify ALL unit tests pass (100%).
   - Run npm run test:e2e and verify ALL 34 E2E tests pass (100%).

Write your changes to c:/TgHelp/.agents/m4_worker_1/changes.md and handoff report to c:/TgHelp/.agents/m4_worker_1/handoff.md.
When complete, notify parent orchestrator via send_message with test results and handoff path.
