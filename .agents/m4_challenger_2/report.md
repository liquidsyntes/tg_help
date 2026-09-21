# Milestone 4 Empirical & Adversarial Challenge Report

**Author**: `m4_challenger_2` (teamwork_preview_challenger)  
**Role**: Empirical Challenger (critic, specialist)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 4 — Publishing Engine & BullMQ Idempotency  
**Verdict**: **APPROVE**  

---

## 1. Executive Summary

As an empirical challenger, I subjected the Milestone 4 deliverables (`PublishingProcessor`, `PublishingService`, `PublishingPreflightService`, `SchedulingService`, `TelegramPublisherService`, and `TelegramErrorClassifier`) to hostile adversarial stress-testing.

Every claim made by the worker was tested by executing real verification code, including a dedicated unit test suite (`tests/unit/adversarial-empirical-m4.spec.ts`) and a standalone live stress harness (`tests/stress/adversarial-m4-empirical.ts`).

### Key Empirical Findings:
1. **Partial Publication Resume (AGENTS.md §23)**:
   - Successfully verified that when a multi-message publication (media group of 3 items + overflow text message) fails mid-stream after sending the media group, the first part's message IDs (`[2001, 2002, 2003]`) are durably persisted to `PublicationJob.telegramMessageIds` in PostgreSQL.
   - On retry, the worker detects the sent parts, **skips the media group entirely**, sends only the remaining text part (`[2004]`), and commits the merged array `[2001, 2002, 2003, 2004]` to PostgreSQL, transitioning the post to `PUBLISHED`.
   - Zero duplicated messages sent to Telegram.
2. **Cascading Partial Failures (3-part publication)**:
   - Verified that across multiple failure/retry iterations (Part 0 succeeds → Part 1 fails → Retry 1: Part 1 succeeds, Part 2 fails → Retry 2: Part 2 succeeds), the worker incrementally accumulates and persists IDs without re-sending any previously completed part.
3. **Error Backoff & Unrecoverable Errors (AGENTS.md §22, §49, §50)**:
   - **429 RATE_LIMITED**: Correctly extracts `retry_after` from `GrammyError.parameters` (e.g. 17s, 35s) or regex fallback from message description (e.g. 42s, 48s). In the worker, delays BullMQ execution via `job.moveToDelayed` without marking the post as failed.
   - **400 / 403 PERMANENT**: Permanent errors (such as 400 Bad Request or 403 bot kicked from channel) immediately trigger `UnrecoverableError` on attempt 1, transition post state `PUBLISHING -> PUBLISH_FAILED`, and mark the database job as `FAILED` without burning retry attempts.
   - **Transient Retry Exhaustion**: Retryable network socket errors (`ECONNRESET`, `ETIMEDOUT`) and 5xx errors are rethrown on attempts 1 and 2, but on attempt 3 of 3 trigger post transition to `PUBLISH_FAILED` and throw `UnrecoverableError`.
4. **Scheduling & Timezones (AGENTS.md §24, §47, tasks.md §6, §19)**:
   - Past dates are strictly rejected with user-friendly Russian `ValidationException` (`Нельзя планировать публикацию в прошлом.`).
   - Verified Europe/Kyiv Summer Time (EEST, UTC+3) and Winter Time (EET, UTC+2) conversions to UTC `TIMESTAMPTZ`, as well as non-default timezones (`America/New_York`).
   - Verified schedule cancellation (`cancelSchedule`): removes delayed BullMQ job, sets DB job to `CANCELLED`, and transitions post state `SCHEDULED -> CANCELLED`.
5. **Full Repository Verification**:
   - `npm run build`: Exit code 0 (clean compilation).
   - `npm test`: 20 test suites passed, 401 tests passed (100% pass rate).
   - `npm run test:e2e`: 34 E2E tests passed across Tiers 1–4 (100% pass rate).
   - Standalone stress harness (`adversarial-m4-empirical.ts`): 21/21 assertions passed.

---

## 2. Adversarial Challenge Results

### Challenge 1: Partial Publication Resume (AGENTS.md §23)

- **Assumption Challenged**: If a publication involves multiple Telegram messages (e.g. media group + overflow text) and the worker fails after sending part 1, retrying must never re-send part 1 to Telegram.
- **Attack Scenario**:
  - Configured a post with a 3-photo media group (Part 0) and an overflow body text message (Part 1).
  - Attempt 1: Part 0 returned message IDs `[2001, 2002, 2003]`. Part 1 was forced to fail with `connect ECONNRESET`.
  - Attempt 2 (Retry): Worker executed with `attemptsMade: 1`.
- **Observations & Evidence**:
  - `PublicationJob.telegramMessageIds` stored `[2001, 2002, 2003]` after Attempt 1 failure.
  - On Attempt 2, `mockPublisher.publishOutgoingMessage` was called **exactly once** with `{ type: 'text' }`.
  - The media group was **not** sent again.
  - After text dispatch, `dbJob.telegramMessageIds` updated to `[2001, 2002, 2003, 2004]`.
  - Post transitioned to `PostStatus.PUBLISHED`.
  - `PostPublishedEvent` emitted with all 4 message IDs.
- **Verdict**: **PASS**

### Challenge 2: State Machine Guard on Worker Retry

- **Assumption Challenged**: When BullMQ retries a job, the post is already in `PostStatus.PUBLISHING`. A naive worker might attempt to transition `APPROVED -> PUBLISHING` again and fail with `InvalidPostStateTransitionException` or an OCC version mismatch.
- **Attack Scenario**:
  - Ran `PublishingProcessor.process` on a post already in `PostStatus.PUBLISHING`.
- **Observations & Evidence**:
  - Worker inspected `if (currentPost.status !== PostStatus.PUBLISHING)` and safely bypassed the `START_PUBLISHING` transition.
  - Only the final `PUBLISHING -> PUBLISHED` transition occurred.
- **Verdict**: **PASS**

### Challenge 3: Completed & Cancelled Job Safety

- **Assumption Challenged**: If BullMQ delivers a delayed job whose publication was already completed or cancelled, the worker might erroneously re-publish.
- **Attack Scenario**:
  - Picked up jobs with DB status `COMPLETED` and `CANCELLED`.
- **Observations & Evidence**:
  - Worker checked DB `PublicationJob.status` in Step 1.
  - Early-returned immediately without calling `publisher.publishOutgoingMessage` or `postWorkflow.transition`.
- **Verdict**: **PASS**

### Challenge 4: Rate Limiting (429) & Delay Backoff (AGENTS.md §50)

- **Assumption Challenged**: On HTTP 429 Too Many Requests, the system must extract the retry delay and delay BullMQ execution rather than failing the post.
- **Attack Scenario**:
  - Injected `GrammyError` with `parameters: { retry_after: 17 }` and `description: "Too Many Requests: retry after 42"`.
  - Injected `TelegramRateLimitException` with `retryAfterSeconds = 14`.
- **Observations & Evidence**:
  - `TelegramErrorClassifier.classify` extracted exact seconds (17s, 42s, 14s).
  - In `PublishingProcessor`, `job.moveToDelayed` was invoked with `Date.now() + 14000`.
  - Post was NOT transitioned to `PUBLISH_FAILED`.
  - `AuditAction.PUBLICATION_ATTEMPT_FAILED` was recorded with category `RATE_LIMITED`.
- **Verdict**: **PASS**

### Challenge 5: Permanent Error Fast-Fail (AGENTS.md §49)

- **Assumption Challenged**: Permanent errors (400 Bad Request, 403 Forbidden: bot kicked) should NOT be retried indefinitely. They must transition immediately to `PUBLISH_FAILED` on attempt 1 and stop queue retries via `UnrecoverableError`.
- **Attack Scenario**:
  - Dispatched 400 Bad Request ("chat not found") and 403 Forbidden ("bot kicked from channel") on attempt 1 of 3.
- **Observations & Evidence**:
  - Processor classified error as `PERMANENT`.
  - Worker immediately called `postWorkflow.transition` with `targetStatus: PostStatus.PUBLISH_FAILED`.
  - `PublicationJob.status` updated to `FAILED`.
  - `PostPublicationFailedEvent` dispatched.
  - BullMQ `UnrecoverableError` was thrown, preventing further queue attempts.
- **Verdict**: **PASS**

### Challenge 6: Scheduling Invariants & Past Date Rejection (AGENTS.md §24)

- **Assumption Challenged**: Scheduling a date in the past must be rejected at input boundary.
- **Attack Scenario**:
  - Tested past date strings (`"21.09.2021 18:30"`), Date objects in the past, Date object 1ms in past, and invalid strings (`"garbage"`, `"32.13.2028 25:99"`).
- **Observations & Evidence**:
  - All rejected with `ValidationException` (`Нельзя планировать публикацию в прошлом.` or `Некорректный формат даты`).
  - Zero state transitions and zero jobs enqueued.
- **Verdict**: **PASS**

### Challenge 7: Timezone Conversions & Roundtrip (AGENTS.md §24, §47)

- **Assumption Challenged**: Timezone conversions must account for daylight saving time (DST) in Europe/Kyiv.
- **Attack Scenario**:
  - Kyiv Summer Time (July, EEST, UTC+3): `"15.07.2028 15:30"` -> verified UTC hours = 12:30.
  - Kyiv Winter Time (January, EET, UTC+2): `"15.01.2028 15:30"` -> verified UTC hours = 13:30.
  - Custom Timezone (New York, EST, UTC-5): `"15.01.2028 15:30"` -> verified UTC hours = 20:30.
  - Roundtrip formatting with `formatChannelDate` returned exact input string.
- **Verdict**: **PASS**

### Challenge 8: Schedule Cancellation (tasks.md §6, F-38)

- **Assumption Challenged**: Cancelling a scheduled post must remove the delayed BullMQ job, mark DB job `CANCELLED`, and transition post `SCHEDULED -> CANCELLED`.
- **Attack Scenario**:
  - Invoked `SchedulingService.cancelSchedule`.
  - Tested unauthorized user (rejected with `PermissionDeniedException`).
  - Tested post not in `SCHEDULED` status (rejected with `InvalidPostStateTransitionException`).
- **Observations & Evidence**:
  - `bullJob.remove()` was executed.
  - `PublicationJob.status` was updated to `CANCELLED`.
  - Post transitioned to `PostStatus.CANCELLED` with OCC version increment.
- **Verdict**: **PASS**

---

## 3. Test Execution Summary

| Test Suite | Tests Run | Passed | Failed | Status |
|---|:---:|:---:|:---:|:---:|
| Unit Test Suites (18 original + 2 M4 adversarial) | 401 | 401 | 0 | **PASS** |
| `tests/unit/adversarial-empirical-m4.spec.ts` | 26 | 26 | 0 | **PASS** |
| `tests/stress/adversarial-m4-empirical.ts` | 21 | 21 | 0 | **PASS** |
| E2E Test Suite (`npm run test:e2e`) | 34 | 34 | 0 | **PASS** |
| TypeScript Compilation (`npm run build`) | N/A | N/A | 0 | **PASS** |

---

## 4. Final Assessment

Milestone 4 implementation is robust, adheres strictly to the architectural requirements of `AGENTS.md`, and completely satisfies the acceptance criteria for partial publication resumption, error backoff classification, and publication scheduling.

**Verdict**: **APPROVE**
