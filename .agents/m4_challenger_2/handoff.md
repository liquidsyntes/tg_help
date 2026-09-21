# Milestone 4 Challenger 2 Handoff Report

**Agent**: `m4_challenger_2` (teamwork_preview_challenger)  
**Roles**: critic, specialist  
**Working Directory**: `c:/TgHelp/.agents/m4_challenger_2`  
**Date**: 2026-09-21  
**Milestone**: M4 — Publishing Engine & BullMQ Idempotency  
**Verdict**: **APPROVE**  

---

## 1. Observation

1. **Empirical Adversarial Test Suite Created**:
   - `tests/unit/adversarial-empirical-m4.spec.ts`: 26 test cases covering partial publication resume (multi-part media group + overflow text, 3-part cascading failure, status guard on retry, completed/cancelled job skip), tri-tier error classification (429 parameter/regex extraction, 5xx retryable, 400/403 permanent fast-fail, transient retry exhaustion), and scheduling stress (past date rejection, Europe/Kyiv Summer/Winter DST conversion, custom channel timezone, BullMQ delayed job removal upon cancellation).
   - `tests/stress/adversarial-m4-empirical.ts`: Standalone execution harness running 21 live assertions testing partial resume network failure, 403 unrecoverable error immediate failure, and Europe/Kyiv timezone conversions.

2. **Partial Publication Resume Verification**:
   - Multi-message publication (media group of 3 photos + overflow text message) simulated where the media group succeeds and returns IDs `[2001, 2002, 2003]`, followed by `ECONNRESET` on the text message.
   - `PublicationJob.telegramMessageIds` in PostgreSQL persisted `[2001, 2002, 2003]` after Attempt 1 failure.
   - On Attempt 2 (retry), `PublishingProcessor` inspected `telegramMessageIds`, verified that Part 0 was already sent, bypassed `publishOutgoingMessage` for Part 0, and invoked `publishOutgoingMessage` exclusively for Part 1 (text).
   - On completion, `telegramMessageIds` recorded `[2001, 2002, 2003, 2004]`, and post status updated to `PUBLISHED`.
   - Zero duplicated Telegram messages were dispatched.

3. **Error Backoff & Unrecoverable Error Verification**:
   - 429 RATE_LIMITED: `TelegramErrorClassifier` extracted `retry_after` from `parameters.retry_after` (17s, 35s) and fallback regex from description (42s, 48s). In worker, delayed retry was scheduled via `job.moveToDelayed` without marking the post as failed.
   - 400 Bad Request & 403 Forbidden: Worker immediately transitioned post state to `PUBLISH_FAILED`, marked job `FAILED`, dispatched `PostPublicationFailedEvent`, and threw `UnrecoverableError` on attempt 1.
   - Transient errors: Attempt 1 and 2 rethrew for BullMQ exponential backoff; attempt 3 of 3 (exhaustion) transitioned post to `PUBLISH_FAILED` and threw `UnrecoverableError`.

4. **Scheduling Invariants Verification**:
   - Past dates (past strings, past Date objects, 1ms in past) strictly rejected with `ValidationException: Нельзя планировать публикацию в прошлом.`
   - Timezone conversion verified: Europe/Kyiv Summer (15.07.2028 15:30 EEST = 12:30 UTC), Europe/Kyiv Winter (15.01.2028 15:30 EET = 13:30 UTC), and New York (15.01.2028 15:30 EST = 20:30 UTC).
   - Schedule cancellation (`cancelSchedule`): verifies `ChannelPermission.CANCEL_SCHEDULE`, removes delayed BullMQ job via `bullJob.remove()`, marks `PublicationJob` as `CANCELLED`, and transitions post state `SCHEDULED -> CANCELLED`.

5. **Test Execution Observations**:
   - `npm run build`: Exit code 0 (Clean TypeScript build).
   - `npm test`: 20 test suites passed, 401 tests passed (100% pass rate).
   - `npm run test:e2e`: 34 tests passed, 0 failed across Tiers 1–4 (100% pass rate).
   - `npx ts-node -r tsconfig-paths/register tests/stress/adversarial-m4-empirical.ts`: 21/21 passed.

---

## 2. Logic Chain

1. **Partial Publication Resume (AGENTS.md §23, tasks.md §23)**:
   - *Observation*: Multi-part payloads must not duplicate sent messages upon worker retry.
   - *Logic*: `PublishingProcessor` persists `sentMessageIds` to `PublicationJob.telegramMessageIds` after each successful message part. On retry, `accumulatedExpectedIds` is evaluated against `sentMessageIds.length`. Because the media group's expected count (3 items) is $\le 3$ already recorded IDs, the worker skips Part 0 and sends only Part 1.
   - *Conclusion*: Implementation conforms 100% to AGENTS.md §23.

2. **Permanent vs. Retryable Error Differentiation (AGENTS.md §49, §50)**:
   - *Observation*: Indefinite retry of permanent errors violates BullMQ worker safety.
   - *Logic*: `TelegramErrorClassifier` tags 400 and 403 as `isPermanent: true`. In `PublishingProcessor.process`, `if (classification.isPermanent || isExhausted)` immediately triggers post state transition to `PUBLISH_FAILED`, marks the database job as `FAILED`, and throws `UnrecoverableError`.
   - *Conclusion*: Indefinite retry loops on client errors or permission loss are prevented.

3. **Rate Limit Handling (AGENTS.md §50)**:
   - *Observation*: When Telegram returns 429, the bot must honor `retry_after`.
   - *Logic*: `job.moveToDelayed(Date.now() + delayMs, token)` pauses the BullMQ job for the exact duration instructed by Telegram. Post remains in `PUBLISHING` status, avoiding false failure notifications.
   - *Conclusion*: Implemented cleanly and verified.

4. **Timezone Conversion & Validation (AGENTS.md §24, §47, tasks.md §19)**:
   - *Observation*: Scheduled dates must be entered in channel timezone (Europe/Kyiv default) and persisted as UTC `TIMESTAMPTZ`, rejecting past dates.
   - *Logic*: `parseAndValidateScheduledDate` evaluates input against Luxon `IANAZone`, computes absolute UTC instant, and ensures `date.getTime() > nowMs`. `cancelSchedule` gracefully removes the delayed BullMQ job and transitions state to `CANCELLED`.
   - *Conclusion*: Verified for standard and daylight saving regimes.

---

## 3. Caveats

1. **Hermetic Test Double**:
   - Tests execute against stateful mock implementations (`MockTelegramPublisher`, in-memory database doubles) rather than live Telegram Bot API or live Redis instances, adhering to CI/CD hermetic isolation standards.
2. **Post-Cancellation Resubmission**:
   - When a post schedule is cancelled (`SCHEDULED -> CANCELLED`), its status remains `CANCELLED` until an author or editor initiates a new revision/approval workflow cycle.
3. **No Other Caveats**: All dispatch requirements have been tested and verified.

---

## 4. Conclusion

Milestone 4 (Publishing Engine & BullMQ Idempotency) satisfies all functional, architectural, and adversarial requirements.
- Partial publication resume skips already-sent parts and accumulates message IDs correctly.
- Tri-tier error classification and BullMQ backoff/unrecoverable error handling operate as specified.
- Scheduling, timezone parsing, and cancellation work reliably.
- Build compiles cleanly, and all 401 unit tests and 34 E2E tests pass.

**Verdict**: **APPROVE**

---

## 5. Verification Method

To independently reproduce and verify this assessment:

1. **Verify TypeScript Compilation**:
   ```bash
   npm run build
   ```
   *Expected*: Exit code 0, 0 TypeScript errors.

2. **Run All Unit Tests (including M4 Adversarial Suites)**:
   ```bash
   npm test
   ```
   *Expected*: 20 test suites passed, 401 tests passed (100%).

3. **Run Standalone M4 Empirical Stress Harness**:
   ```bash
   npx ts-node -r tsconfig-paths/register tests/stress/adversarial-m4-empirical.ts
   ```
   *Expected*: 21/21 passed (0 failed).

4. **Run All E2E Tests**:
   ```bash
   npm run test:e2e
   ```
   *Expected*: 34 tests passed across Tiers 1–4 (100%).
