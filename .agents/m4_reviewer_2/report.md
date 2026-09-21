# Milestone 4 Quality & Adversarial Review Report

**Reviewer**: `m4_reviewer_2` (teamwork_preview_reviewer)  
**Roles**: Reviewer, Adversarial Critic  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 4 — Publishing Engine, Telegram API Abstraction & SchedulingService  
**Verdict**: **APPROVE**  

---

## 1. Quality Review Summary

**Verdict**: **APPROVE**

Milestone 4 implementation delivered by `m4_worker_1` has been reviewed in depth. The implementation of the **Telegram API Abstraction** (`ITelegramPublisher`, `TelegramPublisherService`, `TelegramErrorClassifier`) and the **Scheduling Service** (`SchedulingService`, `SchedulingModule`) meets or exceeds all requirements stipulated in `ORIGINAL_REQUEST.md`, `PROJECT.md`, `AGENTS.md` (§3, §10, §13, §16, §17, §18, §20, §21, §22, §23, §24, §25, §30, §47, §48, §49, §50), and `tasks.md` (§6, §16, §18, §19, §20, §21, §22, §23).

No integrity violations, fake facade implementations, or shortcuts were found. The code is modular, strictly typed in TypeScript, implements defensive limits validation, enforces optimistic concurrency control (OCC), integrates real grammY Bot API wrappers and Luxon timezone conversions, and ensures zero silent failures.

---

## 2. Review Findings & Assessment

### [Good Practice] Finding 1: Strict External API Isolation & Limits Validation
- **Location**: `src/infrastructure/telegram-api/` (`ITelegramPublisher`, `TelegramPublisherService`)
- **Assessment**:
  - `ITelegramPublisher` enforces polymorphic `chatId: string | bigint` across all methods (`sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, `sendMediaGroup`, `publishOutgoingMessage`).
  - `TelegramPublisherService` normalizes `chatId` safely (converting `bigint` to string, trimming whitespace, and rejecting empty chat IDs with 400 `TelegramPermanentException`).
  - Strict boundary enforcement of `TELEGRAM_LIMITS`:
    - Text length $\le 4096$ characters.
    - Media captions $\le 1024$ characters.
    - Media groups strictly bounded to $2 \le N \le 10$ items.
  - Media groups dynamically use grammY `InputMediaBuilder` for documents, photos, and videos with HTML parse mode.

### [Good Practice] Finding 2: Robust Tri-Tier Error Classification
- **Location**: `src/infrastructure/telegram-api/errors/telegram-error.classifier.ts`
- **Assessment**:
  - Tri-tier classification cleanly separates:
    1. `RATE_LIMITED` (HTTP 429): Extracts `parameters.retry_after` from grammY `GrammyError` or regex extraction from description (`retry_after: \d+` or `retry after \d+`), defaulting to 5s.
    2. `RETRYABLE` (5xx server errors, `HttpError`, network socket errors like `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, `fetch failed`, `socket hang up`).
    3. `PERMANENT` (HTTP 400 Bad Request, 401 Unauthorized, 403 Forbidden / bot kicked, 404 Chat not found).
  - Unclassified fallback errors are treated as `PERMANENT` (HTTP 400) in accordance with AGENTS.md §49 to prevent infinite retry storms.

### [Good Practice] Finding 3: Timezone-Aware Scheduling & Delayed BullMQ Enqueueing
- **Location**: `src/modules/scheduling/scheduling.service.ts`
- **Assessment**:
  - Parses channel timezone using Luxon with `Europe/Kyiv` default.
  - Rejects past dates with user-friendly Russian validation error (`Нельзя планировать публикацию в прошлом.`).
  - Validates Stage 1 preflight (status is `APPROVED`, channel is active with valid `telegramChatId`, actor has `ChannelPermission.PUBLISH_POST`, template schema is satisfied).
  - Executes OCC transition `APPROVED -> SCHEDULED` incrementing `post.version` and writing audit logs.
  - Stores UTC `TIMESTAMPTZ` in PostgreSQL `PublicationJob` with unique idempotency key `publish:{postId}:{postVersion}`.
  - Enqueues delayed BullMQ job with `delay = Math.max(0, scheduledDate.getTime() - Date.now())` and exponential backoff.

### [Good Practice] Finding 4: Secure Schedule Cancellation
- **Location**: `src/modules/scheduling/scheduling.service.ts` (`cancelSchedule`)
- **Assessment**:
  - Enforces `ChannelPermission.CANCEL_SCHEDULE` permission check for the channel.
  - Rejects non-`SCHEDULED` posts with `InvalidPostStateTransitionException`.
  - Removes delayed BullMQ job via `publicationQueue.getJob(jobId).remove()`.
  - Durably updates `PublicationJob.status = CANCELLED` in PostgreSQL.
  - Transitions post state `SCHEDULED -> CANCELLED` with audit trail.
  - BullMQ worker processor additionally validates `pubJob.status === CANCELLED` and Stage 2 preflight to safeguard against concurrent dispatch races.

### [Good Practice] Finding 5: MockTelegramPublisher Backwards Compatibility
- **Location**: `tests/mocks/mock-telegram-publisher.ts`
- **Assessment**:
  - Implements full `ITelegramPublisher` interface with zero external dependencies (allowing hermetic execution under Node test runners).
  - Retains all simulation helpers (`simulateTransientFailures`, `simulateRateLimit`, `simulatePermanentFailure`, `getSentMessages`, `clear`).
  - 100% backward compatibility maintained with all existing unit and E2E test suites.

---

## 3. Verified Claims

| Claim from Worker / Specification | Verification Method | Result |
|---|---|:---:|
| TypeScript build compiles without errors | Executed `npm run build` | **PASS** (Exit code 0, 0 errors) |
| All unit tests pass across all modules | Executed `npm test` | **PASS** (18/18 suites, 341/341 tests) |
| All E2E tests pass across all tiers | Executed `npm run test:e2e` | **PASS** (34/34 tests across 22 suites) |
| `ITelegramPublisher` accepts polymorphic `chatId: string \| bigint` | Inspected `interfaces/telegram-publisher.interface.ts` & `telegram-publisher.service.ts` | **PASS** |
| `TelegramErrorClassifier` correctly classifies 429, 5xx, network, and 400/403 | Unit tests in `telegram-publisher.spec.ts` | **PASS** |
| `SchedulingService.schedulePost` parses Luxon timezone, rejects past dates, transitions `APPROVED -> SCHEDULED` | Unit tests in `scheduling.spec.ts` & E2E 2.2, 3.2 | **PASS** |
| `SchedulingService.cancelSchedule` checks permission, removes BullMQ job, sets status `CANCELLED` | Unit tests in `scheduling.spec.ts` & E2E 3.2 | **PASS** |
| Publication idempotency key `publish:{postId}:{version}` enforced in DB | Unit tests in `publishing.spec.ts` & E2E 1.5 | **PASS** |
| Partial Publication Resume skips previously sent parts | Unit tests in `publishing.spec.ts` & E2E 3.3 | **PASS** |

---

## 4. Adversarial Review & Stress Testing

**Overall Risk Assessment**: **LOW**

### Challenge 1: Polymorphic `chatId` Representation and Negative Channel IDs
- **Assumption Challenged**: Telegram supergroup and channel IDs are large negative 64-bit numbers (e.g. `-1001234567890`), which can overflow standard JavaScript 32-bit bitwise operations or truncate if cast to `Number`.
- **Attack Scenario**: Calling `sendMessage` or `publishOutgoingMessage` with negative channel IDs as `string` or `bigint`.
- **Evaluation**: In `TelegramPublisherService.normalizeChatId`:
  ```ts
  if (typeof chatId === 'bigint') {
    return chatId.toString();
  }
  const trimmed = String(chatId).trim();
  ```
  BigInt is converted directly to string `chatId.toString()`, and strings are kept as strings without unsafe `Number(...)` parsing. grammY's `Api.sendMessage` accepts `string | number`.
- **Result**: **PASS**. Safe against precision loss.

### Challenge 2: Daylight Saving Time Transitions in `Europe/Kyiv` Timezone
- **Assumption Challenged**: Transitioning between EET (UTC+2) and EEST (UTC+3) might create ambiguous or non-existent wall-clock times during spring/autumn clock shifts.
- **Attack Scenario**: Scheduling a post during DST shift (e.g. 03:00 on spring forward Sunday).
- **Evaluation**: Luxon's `DateTime.fromFormat(..., { zone: 'Europe/Kyiv' })` handles ambiguous and gap times deterministically according to IANA TZ rules, producing a valid UTC `toJSDate()` instant.
- **Result**: **PASS**. Robust UTC instant generation.

### Challenge 3: Concurrent Race between Delayed Job Fire and `cancelSchedule`
- **Assumption Challenged**: If a user cancels a scheduled publication at the exact millisecond the delayed BullMQ job fires, the worker might pick up the job before it is removed.
- **Attack Scenario**: Worker starts processing while `cancelSchedule` is in flight.
- **Evaluation**: The pipeline employs defense-in-depth:
  1. `cancelSchedule` marks the DB `PublicationJob` as `status: CANCELLED`.
  2. `PublishingProcessor.process` queries PostgreSQL for `pubJob`. If `pubJob.status === CANCELLED`, it immediately aborts without sending any message.
  3. `PublishingPreflightService.validateStage2` checks `validExecutionStatuses` (`APPROVED`, `SCHEDULED`, `PUBLISHING`, `PUBLISH_FAILED`). If post is `CANCELLED`, preflight rejects with `TelegramPermanentException`.
- **Result**: **PASS**. Dual guard prevents duplicate or illicit publication.

### Challenge 4: OCC Version Skew during Scheduling
- **Assumption Challenged**: If Editor A is scheduling post while Author or Editor B edits/modifies it, the post version could drift.
- **Attack Scenario**: Schedule submitted with stale `expectedVersion`.
- **Evaluation**: `SchedulingService.schedulePost` delegates the transition to `PostWorkflowService.transition({ expectedVersion: ... })`. `PostWorkflowService` executes a conditional update `WHERE id = :id AND version = :expectedVersion`. If the version in the database does not match, it throws `PostConflictException`.
- **Result**: **PASS**. Invariant maintained.

---

## 5. Coverage Gaps & Unverified Items

- **Coverage Gaps**: None. All core components, boundary conditions, and cross-feature interactions are exercised by tests.
- **Unverified Items**: None. All claims independently verified via automated build, unit test suites, and E2E test suites.

---

## 6. Conclusion

Milestone 4 is complete, robust, and ready for integration.
**Verdict**: **APPROVE**.
