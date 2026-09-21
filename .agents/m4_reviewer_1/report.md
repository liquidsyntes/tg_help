# Milestone 4 Quality & Adversarial Review Report

**Reviewer**: `m4_reviewer_1` (Roles: `reviewer`, `critic`)  
**Date**: 2026-09-21  
**Scope**: Milestone 4 (Publishing Engine & BullMQ Idempotency) — `PublishingService`, `PublishingPreflightService`, `PublishingProcessor`, and supporting modules.  
**Target Path**: `c:/TgHelp`

---

## 1. Review Summary

**Verdict**: **APPROVE**

The Milestone 4 implementation strictly fulfills all requirements set forth in `ORIGINAL_REQUEST.md`, `PROJECT.md`, `AGENTS.md` (§3, §10, §13, §16, §18, §20, §21, §22, §23, §24, §25, §30, §48, §49, §50), and `tasks.md` (§6, §19, §20, §21, §22, §23, §34). 

Key design and implementation highlights:
1. **Canonical Idempotency**: `PublishingService.enqueuePublish` constructs canonical idempotency keys in exact format `publish:{postId}:{postVersion}`, backed by PostgreSQL's unique constraint `PublicationJob.idempotencyKey` and robust Prisma `P2002` race recovery.
2. **Two-Stage Preflight Validation**: Synchronous Stage 1 pre-enqueue checks (post state, active channel, telegram chat ID, user permissions, template schema validation, media counts, canonical dry-run render) and asynchronous Stage 2 worker pre-send checks (fresh DB re-fetch, non-deletion, active channel, sound payload, throwing permanent exceptions to prevent retry loops).
3. **Robust BullMQ Worker & OCC**: `PublishingProcessor` runs with concurrency 5, executes OCC state transitions (`APPROVED/SCHEDULED/PUBLISH_FAILED -> PUBLISHING -> PUBLISHED/PUBLISH_FAILED`), and includes an explicit guard (`if (currentPost.status !== PostStatus.PUBLISHING)`) to prevent illegal or redundant transitions on worker retries.
4. **Partial Publication Resume**: Seamlessly resumes multi-message publications by inspecting persisted `PublicationJob.telegramMessageIds` and skipping already sent parts on retry.
5. **Tri-Tier Error Classifier**: Intelligently handles rate limiting (`RATE_LIMITED` / 429 with delayed retry via `moveToDelayed`), transient failures (`RETRYABLE` / 5xx / network with exponential backoff), and unrecoverable errors (`PERMANENT` / 400 / 403 bot kicked with immediate `PUBLISH_FAILED` and `UnrecoverableError`).
6. **Integrity & Clean Execution**: Clean build (`npm run build` exit code 0), 100% unit test suite pass rate (18 suites, 341 tests), and 100% E2E test suite pass rate (34 tests across 4 tiers). No hardcoding, dummy facades, or task bypass shortcuts detected.

---

## 2. Findings

### Good Practices & Architectural Strengths
- **No Direct Telegram Calls in Handlers / Services**: Handlers and application services never invoke Telegram Bot API directly; all publishing is decoupled through PostgreSQL + BullMQ + `PublishingProcessor` + `ITelegramPublisher` abstraction.
- **Race Condition Immunity (Prisma P2002)**: The database unique index `idempotencyKey` serves as the authoritative source of truth. Concurrent requests catch `PrismaClientKnownRequestError` with code `P2002` and safely return the existing record without duplicating BullMQ jobs.
- **Atomic Progress Persistence for Partial Resume**: After dispatching each message part, `PublicationJob.telegramMessageIds` is immediately updated in PostgreSQL, ensuring that a transient error on subsequent parts does not trigger message duplication on retry.
- **Clean Module Lifecycle Management**: Worker implements `OnModuleDestroy` and awaits `this.worker.close()` for graceful shutdown.

### Minor Observations (Informational / Non-Blocking)
- **Informational 1**: In `PublishingProcessor`, if `job.moveToDelayed` fails during rate-limiting (e.g., if Redis connection flickers), the catch block falls back to re-throwing the error, allowing BullMQ's standard exponential backoff to handle it safely.
- **Informational 2**: Node emitted typeless package warnings during E2E tests (`MODULE_TYPELESS_PACKAGE_JSON`). This does not impact test execution or runtime correctness and was handled seamlessly by Node's ESM loader.

---

## 3. Verified Claims

| # | Claim | Verification Method | Result |
|---|---|---|:---:|
| 1 | `enqueuePublish` generates `publish:{postId}:{postVersion}` | Inspected `src/modules/publishing/publishing.service.ts` line 40 & unit test `publishing.spec.ts` | **PASS** |
| 2 | DB unique constraint on `idempotencyKey` | Inspected `prisma/schema.prisma` line 237 (`@unique @map("idempotency_key")`) | **PASS** |
| 3 | Prisma `P2002` collision handled gracefully without duplicate job | Inspected `publishing.service.ts` lines 71-78 & executed unit test `publishing.spec.ts` | **PASS** |
| 4 | Stage 1 preflight (permissions, template, media, dry run) | Inspected `publishing-preflight.service.ts` lines 55-160 & executed unit tests | **PASS** |
| 5 | Stage 2 worker preflight (fresh DB read, permanent error on invalid post/channel) | Inspected `publishing-preflight.service.ts` lines 166-237 & executed unit tests | **PASS** |
| 6 | Worker setup `@Processor('publication', { concurrency: 5 })` | Inspected `publishing.processor.ts` line 30 | **PASS** |
| 7 | OCC state transitions (`APPROVED -> PUBLISHING -> PUBLISHED`) | Inspected `publishing.processor.ts` lines 108-116, 179-185, 286-293 & tested via unit + E2E | **PASS** |
| 8 | Guard preventing redundant transition when already `PUBLISHING` | Inspected `publishing.processor.ts` line 108 (`if (currentPost.status !== PostStatus.PUBLISHING)`) | **PASS** |
| 9 | Partial publication resume skips already published message parts | Inspected `publishing.processor.ts` lines 141-151 & unit/E2E test suites | **PASS** |
| 10 | Retry exhaustion transitions post to `PUBLISH_FAILED` | Inspected `publishing.processor.ts` lines 280-325 & unit test `publishing.spec.ts` | **PASS** |
| 11 | Graceful worker shutdown on module destroy | Inspected `publishing.processor.ts` lines 49-57 (`onModuleDestroy` calling `this.worker.close()`) | **PASS** |
| 12 | TypeScript build succeeds | Executed `npm run build` | **PASS** (Exit code 0) |
| 13 | Unit tests pass | Executed `npm test` | **PASS** (18 suites, 341 tests) |
| 14 | E2E tests pass | Executed `npm run test:e2e` | **PASS** (34 tests, 22 suites) |

---

## 4. Adversarial Challenges & Stress-Testing

### Challenge 1: Concurrent Publish Invocations (Double-Click Race)
- **Assumption**: Two identical publish commands sent in parallel could race through memory checks and create duplicate BullMQ jobs.
- **Attack Scenario**: Both requests query `findUnique` simultaneously before either has written to PostgreSQL.
- **Stress-Test Analysis**: Both execute `prisma.publicationJob.create`. The first succeeds; the second immediately encounters PostgreSQL's unique constraint violation (`Prisma.PrismaClientKnownRequestError` code `P2002`). The catch handler executes `findUniqueOrThrow` and returns the existing job without adding a second job to `publicationQueue`.
- **Verdict**: **PASSED (Immune to race condition)**.

### Challenge 2: Channel Deactivation Mid-Flight
- **Assumption**: A channel is active during Stage 1 pre-enqueue, but the channel is deactivated or the bot is kicked before the BullMQ worker picks up the job.
- **Attack Scenario**: Job is queued in BullMQ. Admin deactivates channel in DB. Worker picks up job.
- **Stress-Test Analysis**: Inside `PublishingProcessor`, Stage 2 preflight re-queries PostgreSQL for a fresh channel and post record. Detecting `channel.isActive === false`, Stage 2 throws `TelegramPermanentException` (HTTP 400). The worker classifies this as `PERMANENT`, transitions the post to `PUBLISH_FAILED`, marks the job `FAILED`, and throws `UnrecoverableError` so BullMQ does not retry.
- **Verdict**: **PASSED (Defended via Stage 2 Preflight)**.

### Challenge 3: Scheduled Post Cancelled While In Queue
- **Assumption**: A user cancels a scheduled publication, but the delayed BullMQ job was already enqueued.
- **Attack Scenario**: Editor calls `cancelSchedule()`. Post status transitions `SCHEDULED -> CANCELLED`, and `PublicationJob.status` transitions to `CANCELLED`. If the BullMQ delayed job somehow still triggers, will it publish?
- **Stress-Test Analysis**: Line 90 of `PublishingProcessor`:
  ```typescript
  if (pubJob && pubJob.status === PublicationJobStatus.CANCELLED) {
    this.logger?.log({ event: 'publication_job_cancelled_skip', jobId: job.id, postId });
    return;
  }
  ```
  The processor checks for `CANCELLED` status immediately and returns without executing preflight, state transitions, or Telegram API calls.
- **Verdict**: **PASSED**.

### Challenge 4: Partial Failure on Multi-Message Publishing
- **Assumption**: A publication consists of a 2-photo media group and an overflow caption text message. The photo group succeeds, but Telegram returns 504 on the text message.
- **Attack Scenario**: Will the worker retry and post the photo group a second time?
- **Stress-Test Analysis**: After Part 0 (media group) succeeds, its message IDs (`[1001, 1002]`) are saved to `pubJob.telegramMessageIds` in PostgreSQL. Part 1 throws a retryable 504 error. On attempt 2, `pubJob.telegramMessageIds` has 2 IDs. The loop checks `sentMessageIds.length >= accumulatedExpectedIds + expectedCount` (`2 >= 0 + 2`), which evaluates to true. Part 0 is skipped with a log event. Only Part 1 is dispatched to Telegram.
- **Verdict**: **PASSED (Verified in `publishing.spec.ts` and `tier3-cross-feature.spec.ts`)**.

---

## 5. Integrity Verification Checklist

- [x] **No hardcoded test results**: Source files contain real domain logic, Prisma models, and BullMQ queues.
- [x] **No dummy facades**: `PublishingService`, `PublishingPreflightService`, `PublishingProcessor`, `TelegramPublisherService`, and `TelegramErrorClassifier` are fully implemented production services.
- [x] **No task bypass shortcuts**: Full architectural separation between Telegram transport and core business logic maintained.
- [x] **Independent verification**: Built and executed tests directly (`npm run build`, `npm test`, `npm run test:e2e`). All outputs independently observed.

---

## 6. Coverage Gaps & Unverified Items

- **Coverage Gaps**: None within the scope of Milestone 4. Full coverage across M1-M4 features.
- **Unverified Items**: None.
