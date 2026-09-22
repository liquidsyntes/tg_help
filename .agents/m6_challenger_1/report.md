# Milestone 6 Phase 2: Tier 5 Adversarial Coverage Hardening Report
**Track**: Domain, State Machine & Publishing Track  
**Agent**: `m6_challenger_1` (`teamwork_preview_challenger` — Critic, Specialist)  
**Date**: 2026-09-22  
**Target Suite**: `tests/unit/adversarial-empirical-m6-domain.spec.ts`  
**Execution Command**: `npx jest tests/unit/adversarial-empirical-m6-domain.spec.ts --config ./tests/jest.json`  
**Status**: `PASSED` (22 / 22 tests passed, 0 failures, 100% success rate)

---

## 1. Executive Summary

As part of Milestone 6 Phase 2 (Adversarial Coverage Hardening), `m6_challenger_1` conducted white-box adversarial stress testing against the core domain modules:
- `src/modules/posts/` (`PostsRepository`, `PostWorkflowService`, `PostsService`)
- `src/modules/publishing/` (`PublishingProcessor`, `PublishingService`, `PublishingPreflightService`)
- `src/infrastructure/queues/` (`queue.module.ts`, BullMQ configuration)
- `src/infrastructure/telegram-api/` (`TelegramErrorClassifier`, `ITelegramPublisher`, typed error hierarchy)

A dedicated, comprehensive adversarial suite was authored in `tests/unit/adversarial-empirical-m6-domain.spec.ts` covering 4 high-risk operational dimensions. All 22 adversarial scenarios were empirically executed and validated with 100% pass rate.

---

## 2. White-Box Attack Vectors & Empirical Results

### Dimension 1: Partial Publication Resume Without Duplicate Messages (AGENTS.md §23, tasks.md §23)
*Goal: Stress-test multi-message publication where parts fail mid-execution or where database commits fail post-send.*

- **Scenario 1.1: 4-part complex payload cascading failure & recovery (media_group + text1 + document + text2)**:
  - **Attack**: A publication with 4 parts (3-item photo media group, text message 1, document file, text message 2; total expected message IDs = 6) experiences cascading failures. Attempt 1 sends Part 0 and Part 1 successfully, then fails on Part 2 with `503 Service Unavailable`. Attempt 2 skips Parts 0 and 1, sends Part 2, then fails on Part 3 with `504 Gateway Timeout`. Attempt 3 skips Parts 0, 1, and 2, and sends Part 3 successfully.
  - **Empirical Result**: `PASS`. The worker resumed precisely at the unacknowledged part index. Over all 3 attempts, Part 0 and Part 1 were sent exactly once, Part 2 was sent exactly once, and Part 3 was sent exactly once. Zero duplicate messages were sent. Database stored merged IDs `[1001, 1002, 1003, 1004, 1005, 1006]` and dispatched `PostPublishedEvent` with all 6 IDs.
- **Scenario 1.2: Post-send database commit crash recovery**:
  - **Attack**: Worker successfully dispatches message to Telegram and receives message ID `[7001]`, saves to `publication_jobs.telegram_message_ids`, but the worker process crashes before transitioning the post to `PUBLISHED`. On retry attempt 2, BullMQ redelivers the job.
  - **Empirical Result**: `PASS`. Worker identifies `sentMessageIds.length >= 1`, completely bypasses `publisher.publishOutgoingMessage` (0 Telegram calls), transitions post to `PUBLISHED`, and finalizes `PublicationJob` as `COMPLETED`.
- **Scenario 1.3: Number primitive vs Array return from publisher**:
  - **Attack**: External publisher double returns a primitive number `8888` instead of an array.
  - **Empirical Result**: `PASS`. `PublishingProcessor` handles both array and number returns, normalizing into `telegramMessageIds: [8888]`.
- **Scenario 1.4: Dynamic media group item count calculation**:
  - **Attack**: Media group containing 5 items where 5 IDs are recorded.
  - **Empirical Result**: `PASS`. `accumulatedExpectedIds` advances by `message.items.length` (5), skipping the media group and correctly dispatching following text parts.

---

### Dimension 2: Idempotency Key Collision Under Heavy Concurrent Retries (AGENTS.md §21, tasks.md §21, §22)
*Goal: Stress-test high concurrency double-click storms and lifecycle idempotency key rotation.*

- **Scenario 2.1: 50-client race condition on `enqueuePublish`**:
  - **Attack**: 50 parallel requests invoke `enqueuePublish('post-m6-500', 'usr-editor-m6')` simultaneously with simulated network latency jitter. All 50 check `findUnique` simultaneously and see null, racing on `create`.
  - **Empirical Result**: `PASS`. Exactly 1 request succeeds in `publicationJob.create` and enqueues to BullMQ (`queue.add`). 49 requests encounter PostgreSQL unique constraint collision `P2002` on `idempotency_key`, catch the exception, and execute `findUniqueOrThrow`. All 50 callers return identical job instances (`idempotencyKey: publish:post-m6-500:10`). Exactly 1 record exists in DB, exactly 1 job in queue, and exactly 1 audit record created.
- **Scenario 2.2: Manual retry on `PUBLISH_FAILED` with OCC version rotation**:
  - **Attack**: Post fails publication at version 10. Transitions to `PUBLISHING` (v11) then `PUBLISH_FAILED` (v12). Editor triggers manual retry (`🔁 Повторить публикацию`).
  - **Empirical Result**: `PASS`. Because the post version is now 12, `PublishingService` generates key `publish:post-m6-500:12`. This cleanly bypasses the old failed job record (`publish:post-m6-500:10`), creating a fresh `PublicationJob` and enqueueing to BullMQ. A second simultaneous click on manual retry for version 12 deduplicates against version 12 without re-enqueueing.
- **Scenario 2.3: Non-P2002 database error propagation**:
  - **Attack**: `publicationJob.create` throws a non-P2002 error (e.g. `P1001` database connection lost).
  - **Empirical Result**: `PASS`. The error is re-thrown without being swallowed or falsely treated as a duplicate job.
- **Scenario 2.4: Query delegate integrity (`getJobById`, `getJobByIdempotencyKey`)**:
  - **Empirical Result**: `PASS`. Delegates correctly query Prisma `findUnique` and return matching job or null.

---

### Dimension 3: Unrecoverable Error Handling vs Retryable Backoff (AGENTS.md §22, §49, §50)
*Goal: Verify error classification boundaries, rate-limiting backoff, preflight Stage 2 aborts, and retry exhaustion.*

- **Scenario 3.1: Permanent Error Matrix (400, 401, 403, 404)**:
  - **Attack**: Publisher throws permanent errors on attempt 1 (`attemptsMade = 0`):
    - 400: `Bad Request: message text is empty`
    - 401: `Unauthorized: invalid bot token`
    - 403: `Forbidden: bot was kicked from the channel`
    - 404: `Not Found: chat not found`
  - **Empirical Result**: `PASS`. On each error:
    1. Worker immediately transitions post to `PUBLISH_FAILED` without retrying.
    2. `PublicationJob` is updated to `FAILED` with sanitized error message.
    3. `PostPublicationFailedEvent` is emitted.
    4. Throws BullMQ `UnrecoverableError` so BullMQ marks the job permanently failed.
- **Scenario 3.2: 429 Rate Limiting `moveToDelayed` with Redis disconnect fallback**:
  - **Attack**: Publisher throws 429 with `retryAfter: 20s`. `job.moveToDelayed` throws an unexpected error (`Redis connection closed`).
  - **Empirical Result**: `PASS`. Processor catches the `moveToDelayed` failure and falls through to standard re-throw of the 429 error so BullMQ handles backoff. Post is NOT falsely marked `PUBLISH_FAILED`.
- **Scenario 3.3: Preflight Stage 2 permanent abort before publishing starts**:
  - **Attack**: Stage 2 preflight (`validateStage2`) throws `TelegramPermanentException` (e.g. channel inactive) while post is in `APPROVED` status.
  - **Empirical Result**: `PASS`. Because `APPROVED -> PUBLISH_FAILED` is an illegal state transition in the state machine, the worker does NOT call `postWorkflow.transition`, avoiding an `InvalidPostStateTransitionException`. The `PublicationJob` is marked `FAILED` and `UnrecoverableError` is thrown cleanly.
- **Scenario 3.4: Unclassified runtime exception fallback (AGENTS.md §49)**:
  - **Attack**: Publisher throws an arbitrary `TypeError`.
  - **Empirical Result**: `PASS`. `TelegramErrorClassifier` classifies unhandled exceptions as `PERMANENT` to prevent indefinite retry loops. Worker transitions post to `PUBLISH_FAILED` and throws `UnrecoverableError`.
- **Scenario 3.5: Clean worker shutdown**:
  - **Empirical Result**: `PASS`. `onModuleDestroy` invokes `worker.close()` cleanly.

---

### Dimension 4: OCC Version Integrity Under Atomic Transitions (AGENTS.md §10, §13, §28)
*Goal: Stress-test optimistic locking, monotonic version increments, soft-delete invariants, and transaction rollbacks.*

- **Scenario 4.1: 20-client high-concurrency race on `updateWithOcc`**:
  - **Attack**: 20 concurrent update requests execute against a post at version 1 (`expectedVersion = 1`).
  - **Empirical Result**: `PASS`. Exactly 1 update matches `WHERE version = 1` and increments version to 2. The remaining 19 requests match 0 rows, detect `existing.version === 2`, and throw `PostConflictException` with Russian localization: `"Публикация была изменена другим пользователем. Обновите страницу."`.
- **Scenario 4.2: Strict sequential monotonic version chaining**:
  - **Attack**: Exercise the full post editorial lifecycle:
    `DRAFT(v1) -> PENDING_REVIEW(v2) -> NEEDS_REVISION(v3) -> PENDING_REVIEW(v4) -> APPROVED(v5)`.
    At each step, attempt to pass a stale version.
  - **Empirical Result**: `PASS`. Every stale version attempt throws `PostConflictException`. Valid transitions strictly increment version monotonically: 1 -> 2 -> 3 -> 4 -> 5. Audit logs are recorded for each step.
- **Scenario 4.3: Soft-delete invariant enforcement**:
  - **Attack**: Post has `deletedAt !== null`. Attempts made to update via `updateWithOcc` or transition via `transition`.
  - **Empirical Result**: `PASS`. Both operations fail with `ValidationException("Post ... not found or deleted.")`, guaranteeing soft-deleted posts can never be modified or advanced.
- **Scenario 4.4: Transaction rollback integrity on audit failure**:
  - **Attack**: Inside `prisma.$transaction`, `updateWithOcc` succeeds, but `auditService.record` throws an error (e.g. disk full).
  - **Empirical Result**: `PASS`. The entire transaction aborts. Post version is not incremented, and `eventBus.publish` is never called.
- **Scenario 4.5: Complete State Machine Illegal Transition Matrix (21 transitions)**:
  - **Attack**: Test all illegal transitions: terminal states (`REJECTED`, `PUBLISHED`, `CANCELLED`) attempting to move to any status; non-sequential jumps (`DRAFT -> PUBLISHED`, `PENDING_REVIEW -> PUBLISHED`, `APPROVED -> REJECTED`, `CANCELLED -> PUBLISHING`, etc.).
  - **Empirical Result**: `PASS`. All 21 illegal transitions are rejected with `InvalidPostStateTransitionException`.
- **Scenario 4.6: RBAC authorization boundary on state transitions**:
  - **Attack**: Author attempts to approve, reject, or request revision without editor permissions.
  - **Empirical Result**: `PASS`. All unauthorized transition attempts throw `PermissionDeniedException`.

---

## 3. Findings & Behavioral Notes

During white-box analysis, two notable architectural behaviors were verified:
1. **Preflight Stage 2 Error Handling Invariant**: When preflight Stage 2 fails (e.g. channel becomes inactive after post approval), the post is still in `APPROVED` status. Because the state machine forbids `APPROVED -> PUBLISH_FAILED`, `PublishingProcessor` correctly checks `if (freshPost.status === PostStatus.PUBLISHING)` before invoking `postWorkflow.transition`. This prevents secondary transition exceptions from obscuring the root error, allowing the `PublicationJob` to be marked `FAILED` cleanly.
2. **Manual Retry OCC Version Decoupling**: When a post publication fails and transitions from `PUBLISHING` (version $N+1$) to `PUBLISH_FAILED` (version $N+2$), the post's OCC version is incremented. Consequently, when the user clicks `🔁 Повторить публикацию`, the new idempotency key `publish:{postId}:{N+2}` is distinct from the previous failed job's key `publish:{postId}:{N}`. This cleanly decouples the retry job in PostgreSQL and BullMQ without requiring invasive deletion or manual mutation of old audit/job records.

---

## 4. Test Suite Execution Summary

```text
PASS tests/unit/adversarial-empirical-m6-domain.spec.ts (5.299 s)
  Milestone 6 Phase 2: Tier 5 Adversarial Hardening (Domain, State Machine & Publishing)
    Dimension 1: Partial Publication Resume Without Duplicate Messages
      √ 1.1 4-part complex payload (media_group + text1 + doc + text2): cascading failure across 3 attempts resumes with zero duplicate messages (18 ms)
      √ 1.2 Crash recovery after all messages sent: retry must skip ALL Telegram API calls and finalize DB state
      √ 1.3 should support publisher returning a single number primitive rather than array
      √ 1.4 Partial resume correctly computes media group item counts when items length is defined
    Dimension 2: Idempotency Key Collision Under Heavy Concurrent Retries
      √ 2.1 Massive 50-client race condition: all callers receive identical job, exactly 1 DB record, 1 BullMQ job (19 ms)
      √ 2.2 Manual retry on PUBLISH_FAILED post: uses new OCC version key, allowing re-enqueue without collision
      √ 2.3 Non-P2002 database error on create must be re-thrown without being swallowed
      √ 2.4 getJobById and getJobByIdempotencyKey query delegates properly to Prisma (1 ms)
    Dimension 3: Unrecoverable Error Handling vs Retryable Backoff
      √ 3.1 Permanent error 400 (Bad Request: message text is empty) MUST immediately fail post and throw UnrecoverableError on attempt 1 (3 ms)
      √ 3.1 Permanent error 401 (Unauthorized: invalid bot token) MUST immediately fail post and throw UnrecoverableError on attempt 1 (1 ms)
      √ 3.1 Permanent error 403 (Forbidden: bot was kicked from the channel) MUST immediately fail post and throw UnrecoverableError on attempt 1 (1 ms)
      √ 3.1 Permanent error 404 (Not Found: chat not found) MUST immediately fail post and throw UnrecoverableError on attempt 1
      √ 3.2 Rate limit (429) fallback: when moveToDelayed throws, re-throws error for BullMQ backoff without failing post (1 ms)
      √ 3.3 Stage 2 preflight permanent failure (e.g. channel inactive): aborts cleanly with UnrecoverableError without illegal status transition
      √ 3.4 Unclassified arbitrary runtime error is classified as PERMANENT to prevent indefinite retry loops (1 ms)
      √ 3.5 OnModuleDestroy closes BullMQ worker instance cleanly
    Dimension 4: OCC Version Integrity Under Atomic Transitions
      √ 4.1 High-concurrency 20-client OCC race: exactly 1 update succeeds, 19 throw PostConflictException (2 ms)
      √ 4.2 Strict sequential monotonic version chaining: DRAFT(v1) -> PENDING_REVIEW(v2) -> NEEDS_REVISION(v3) -> PENDING_REVIEW(v4) -> APPROVED(v5) (5 ms)
      √ 4.3 Soft-deleted post cannot be updated or transitioned even if version matches (1 ms)
      √ 4.4 Transaction atomicity: if auditService.record fails, post version must NOT change and events must NOT dispatch
      √ 4.5 Complete State Machine Illegal Transition Matrix verification (3 ms)
      √ 4.6 Actor RBAC permission enforcement: Author cannot approve, reject, or request revision

Test Suites: 1 passed, 1 total
Tests:       22 passed, 22 total
Snapshots:   0 total
Time:        5.299 s
```
