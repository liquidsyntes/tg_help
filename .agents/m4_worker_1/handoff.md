# Milestone 4 Handoff Report: Publishing Engine & BullMQ Idempotency

**Agent**: `m4_worker_1` (teamwork_preview_worker)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m4_worker_1`  
**Milestone**: M4 — Publishing Engine & BullMQ Idempotency  

---

## 1. Observation

1. **Telegram API Abstraction Created**:
   - `src/infrastructure/telegram-api/interfaces/telegram-publisher.interface.ts`: Defines `ITelegramPublisher` interface with polymorphic `chatId: string | bigint` across all methods (`sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, `sendMediaGroup`, `publishOutgoingMessage`, `categorizeError`, `isRetryable`, `getRetryDelay`) and export token `TELEGRAM_PUBLISHER = 'TELEGRAM_PUBLISHER'`.
   - `src/infrastructure/telegram-api/errors/telegram-api.exceptions.ts`: Defined `TelegramRateLimitException` (429), `TelegramRetryableException` (5xx, network), `TelegramPermanentException` (400, 403).
   - `src/infrastructure/telegram-api/errors/telegram-error.classifier.ts`: Tri-tier classifier handling grammY `GrammyError` and `HttpError`, `TelegramApiError`, system network errors (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`), and regex extraction of `retry_after`.
   - `src/infrastructure/telegram-api/telegram-publisher.service.ts`: Wraps grammY `Api` using `InputMediaBuilder` for media groups, enforces `TELEGRAM_LIMITS` (caption $\le 1024$, message text $\le 4096$, media group 2..10 items), and normalizes `chatId`.
   - `src/infrastructure/telegram-api/telegram-api.module.ts`: Wires providers and exports `TELEGRAM_PUBLISHER` token and service.
   - `tests/mocks/mock-telegram-publisher.ts`: Upgraded to implement full `ITelegramPublisher` while keeping 100% backward compatibility with existing test harness and E2E tests.

2. **Publishing Module Created**:
   - `src/modules/publishing/interfaces/publish-job-data.interface.ts`: Purely serializable JSON interface for BullMQ job data.
   - `src/modules/publishing/publishing-preflight.service.ts`:
     - Stage 1: Pre-enqueue validation verifying post is `APPROVED` or `PUBLISH_FAILED`, channel active with valid `telegramChatId`, actor has `ChannelPermission.PUBLISH_POST`, template valid, content validates against template schema, media group 2..10 items, and dry-run canonical render succeeds.
     - Stage 2: Worker pre-send validation re-fetching fresh DB post with relations, verifying post exists, not soft-deleted, status in valid lifecycle (`APPROVED`, `SCHEDULED`, `PUBLISHING`), channel active, and rendered payload sound.
   - `src/modules/publishing/publishing.service.ts`:
     - `enqueuePublish(postId, actorId)`: executes Stage 1 preflight, computes canonical idempotency key `publish:{postId}:{postVersion}`, checks DB for duplicate key, provisions `PublicationJob` in DB handling Prisma P2002 race conditions gracefully, adds job to BullMQ queue with `jobId: idempotencyKey`, and records audit log.
   - `src/modules/publishing/publishing.processor.ts`:
     - BullMQ Worker processor extending `WorkerHost` (`@Processor('publication', { concurrency: 5 })`).
     - State transition `APPROVED / SCHEDULED / PUBLISH_FAILED -> PUBLISHING` with guard preventing redundant transitions if already `PUBLISHING` on retry.
     - Multi-message dispatch loop with Partial Publication Resume: skips parts whose message IDs were already persisted in `PublicationJob.telegramMessageIds` on earlier attempts; persists new message IDs to PostgreSQL after each successful part.
     - Succeeded: transitions `PUBLISHING -> PUBLISHED` with `publishedAt = now()`, marks job `COMPLETED`, dispatches `PostPublishedEvent`.
     - Error handling: classifies via `TelegramErrorClassifier`. If `RATE_LIMITED`, delays BullMQ retry. If `PERMANENT` or attempts exhausted, transitions post `PUBLISHING -> PUBLISH_FAILED`, marks job `FAILED`, records audit log, dispatches `PostPublicationFailedEvent`, and throws `UnrecoverableError`.
     - Implements `OnModuleDestroy` for graceful worker shutdown.
   - `src/modules/publishing/publishing.module.ts`: Wires publishing services, worker, and dependencies.

3. **Scheduling Module Created**:
   - `src/modules/scheduling/dto/`: `SchedulePostDto` and `CancelScheduleDto`.
   - `src/modules/scheduling/scheduling.service.ts`:
     - `schedulePost`: parses datetime in channel timezone (Europe/Kyiv default via Luxon), rejects past dates, runs Stage 1 preflight, transitions post `APPROVED -> SCHEDULED` with OCC increment and audit log, creates `PublicationJob` record in DB, and enqueues delayed BullMQ job.
     - `cancelSchedule`: checks `ChannelPermission.CANCEL_SCHEDULE`, removes delayed BullMQ job, marks `PublicationJob` as `CANCELLED`, and transitions post `SCHEDULED -> CANCELLED` with audit log.
   - `src/modules/scheduling/scheduling.module.ts`: Wires scheduling module.

4. **Integration & App Wiring**:
   - `src/app.module.ts`: Registered `TelegramApiModule`, `PublishingModule`, `SchedulingModule`.
   - `src/worker.module.ts`: Registered `TelegramApiModule`, `PublishingModule`, `SchedulingModule`.

5. **Test Execution Observations**:
   - Command: `npm run build`  
     Output: `Exit code 0` (Clean build with zero TypeScript compilation errors).
   - Command: `npm test`  
     Output: `18 test suites passed, 18 total. 341 tests passed, 341 total (100% pass rate)`.
   - Command: `npm run test:e2e`  
     Output: `tests 34, suites 22, pass 34, fail 0 (100% pass rate)`.

---

## 2. Logic Chain

1. **External API Isolation (AGENTS.md §48)**:
   - Observation: Telegram API calls must be wrapped behind an abstraction.
   - Deduction: Created `ITelegramPublisher` and `TelegramPublisherService` under `src/infrastructure/telegram-api/`.
   - Verification: `PublishingProcessor` interacts strictly through `@Inject(TELEGRAM_PUBLISHER) private readonly publisher: ITelegramPublisher`, with zero direct grammY calls outside the infrastructure layer.

2. **Database-Level Idempotency Enforcement (AGENTS.md §21)**:
   - Observation: Network retries or repeated publish button clicks must never duplicate publications.
   - Deduction: `PublishingService` generates key `publish:{postId}:{postVersion}` and uses PostgreSQL unique constraint `@@unique([idempotencyKey])` on `PublicationJob`.
   - Verification: Unit tests in `publishing.spec.ts` and E2E tests in `tier1-feature-coverage.spec.ts` (test 1.5) confirm repeated clicks return the existing job without creating new DB records or duplicate queue jobs, and Prisma P2002 duplicate collision is handled gracefully.

3. **Partial Publication Resume (AGENTS.md §23)**:
   - Observation: If a publication consists of a media group followed by overflow text, and the first succeeds while the second fails, retries must not duplicate the already-published media group.
   - Deduction: `PublishingProcessor` persists returned Telegram message IDs to `PublicationJob.telegramMessageIds` in PostgreSQL after each part. On retry, the worker counts expected message IDs per part against `telegramMessageIds` and skips parts that were already delivered.
   - Verification: Unit test in `publishing.spec.ts` ("should implement Partial Publication Resume...") and E2E test in `tier3-cross-feature.spec.ts` (test 3.3) confirm that on retry after a transient text error, `sendMediaGroup` is never called again and only the remaining text is published.

4. **Two-Stage Preflight Validation (AGENTS.md §25)**:
   - Observation: Invariants must be checked both before queue enqueue and immediately before external dispatch in the worker.
   - Deduction: `PublishingPreflightService.validateStage1()` checks post status, permissions, template schema, and media counts synchronously; `PublishingPreflightService.validateStage2()` re-verifies post existence, non-deletion, active channel, and valid status inside the worker.
   - Verification: Unit tests verify both stages fail fast with appropriate domain or permanent exceptions when invariants are violated.

5. **Timezone-Aware Scheduling (AGENTS.md §24, §47)**:
   - Observation: Publication time must be parsed in channel timezone (Europe/Kyiv default) and stored as UTC `TIMESTAMPTZ`, rejecting past dates.
   - Deduction: `SchedulingService` leverages Luxon via `timezone.util.ts`, calculates BullMQ job delay (`scheduledAt.getTime() - Date.now()`), updates state `APPROVED -> SCHEDULED`, and supports cancellation (`cancelSchedule`).
   - Verification: Tested in `tests/unit/scheduling.spec.ts` and `tests/e2e/tier3-cross-feature.spec.ts` (test 3.2).

---

## 3. Caveats

1. **Local Redis/Postgres in CI vs Dev**:
   - The BullMQ queue is fully registered and wired for production and worker processes using Redis connection options from `EnvironmentConfigService`. In testing environments, unit and E2E tests run against stateful mocks/doubles (`MockTelegramPublisher`, mock queues, test harness).
2. **Scheduled Job Cancellation**:
   - In accordance with the 10-status post state machine in `AGENTS.md §10` and `tasks.md §6`, `cancelSchedule` transitions the post from `SCHEDULED` to `CANCELLED`. If a post is later re-edited or re-submitted, it will progress through the standard revision/resubmission lifecycle.
3. **No other caveats.** All dispatch requirements have been implemented and verified.

---

## 4. Conclusion

Milestone 4 (Publishing Engine & BullMQ Idempotency) is complete, fully functional, and verified.
All interfaces and services strictly adhere to repository architectural principles (AGENTS.md, tasks.md, PROJECT.md):
- `ITelegramPublisher`, `TelegramPublisherService`, `TelegramErrorClassifier`, `TelegramApiModule`.
- `PublishingPreflightService` (two-stage preflight).
- `PublishingService` (`enqueuePublish` with unique idempotency key `publish:{postId}:{postVersion}`).
- `PublishingProcessor` (BullMQ worker with OCC state transitions, partial resume, tri-tier error backoff / `UnrecoverableError`, and graceful shutdown).
- `SchedulingService` and `SchedulingModule` (timezone-aware scheduling and cancellation).
- All 18 unit test suites (341 tests) pass with 100% success rate.
- All 34 E2E tests across 4 tiers pass with 100% success rate.
- Clean compilation under `npm run build`.

---

## 5. Verification Method

To independently verify this milestone:

1. **Verify TypeScript Compilation**:
   ```bash
   npm run build
   ```
   *Expected*: Exit code 0, 0 errors.

2. **Run All Unit Tests**:
   ```bash
   npm test
   ```
   *Expected*: 18 test suites passed, 341 tests passed (100%).

3. **Run All E2E Tests**:
   ```bash
   npm run test:e2e
   ```
   *Expected*: 34 passed across Tiers 1-4.
