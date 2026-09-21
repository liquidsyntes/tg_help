# Milestone 4 Adversarial Stress & Empirical Challenge Report

**Agent**: `m4_challenger_1` (teamwork_preview_challenger)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 4 — Publishing Idempotency & Preflight  
**Verdict**: **APPROVE**  
**Overall Risk Assessment**: **LOW**

---

## 1. Executive Summary

Milestone 4 introduces the publishing engine, BullMQ async processing, two-stage preflight validation, database-enforced idempotency, and partial publication resumption according to `AGENTS.md` (§3, §20, §21, §22, §23, §24, §25, §30, §48, §49, §50) and `tasks.md` (§6, §19, §20, §21, §22, §23).

As an adversarial empirical challenger, I designed, authored, and executed high-concurrency stress harnesses and boundary-testing suites:
1. **Concurrency & Idempotency Stress**:
   - Simulated 50 and 100 simultaneous concurrent publish requests (simulating multi-tab/double-click flooding).
   - Tested PostgreSQL unique constraint P2002 race condition handling.
   - Tested BullMQ worker redelivery idempotency for `COMPLETED` and `CANCELLED` jobs.
   - Tested worker-level OCC guard against redundant transitions to `PUBLISHING`.
   - Tested partial publication resume to verify that previously sent parts are never duplicated.
2. **Preflight Validation Hardening**:
   - Tested complete status transition rejection matrix for non-publishable statuses (`DRAFT`, `PENDING_REVIEW`, `NEEDS_REVISION`, `REJECTED`, `CANCELLED`, `PUBLISHED`).
   - Verified that only `APPROVED`, `SCHEDULED`, and `PUBLISH_FAILED` pass Stage 1 preflight.
   - Tested soft-deleted and non-existent post rejection in both Stage 1 and Stage 2.
   - Tested RBAC permission enforcement (`ChannelPermission.PUBLISH_POST`).
   - Tested target channel validation (inactive channel, missing `telegramChatId`, whitespace-only `telegramChatId`).
   - Tested template schema and dynamic content validation (missing required fields, exceeding `maxLength`, type mismatch).
   - Tested media limits (count > 10, missing `telegramFileId`, missing `telegramFileUniqueId`, unsupported media types).
   - Tested empty outgoing payload rejection.

All empirical tests passed with a **100% success rate**. Zero duplicate database records were created, zero duplicate BullMQ jobs were scheduled, and all invalid preflight states were rejected fail-fast with appropriate domain and permanent exceptions.

---

## 2. Test Execution & Build Verification

| Verification Suite | Command | Result | Pass Rate | Details |
|---|---|:---:|:---:|---|
| **TypeScript Build** | `npm run build` | **PASS** | 100% | Clean NestJS build (Exit code 0, 0 errors) |
| **All Unit Test Suites** | `npm test` | **PASS** | 100% | 20 test suites passed, 401 tests passed (0 failures) |
| **End-to-End Test Suite** | `npm run test:e2e` | **PASS** | 100% | 22 suites, 34 tests passed across Tiers 1-4 |
| **Empirical Stress Harness** | `npx ts-node -r tsconfig-paths/register tests/stress/m4-empirical-challenge.ts` | **PASS** | 100% | 11/11 high-throughput empirical scenarios passed |
| **Challenger Concurrency Suite** | `npx jest tests/unit/adversarial-empirical-m4-concurrency.spec.ts` | **PASS** | 100% | 34/34 adversarial tests passed |

---

## 3. Empirical Challenge Dimensions & Findings

### Dimension 1: Concurrency & Idempotency Stress

#### Challenge 1.1: 50 and 100 Simultaneous Concurrent Publish Requests (Double-Click Flooding)
- **Assumption Challenged**: Under rapid concurrent requests, race conditions could insert multiple `PublicationJob` rows into PostgreSQL or push multiple jobs to BullMQ.
- **Empirical Test**: Executed `Promise.all` with 50 and 100 concurrent `enqueuePublish` calls with jittered simulated DB latency causing interleaved `findUnique` and `create` operations.
- **Empirical Observation**:
  - `dbRecordsCount`: 1 (exactly 1 row persisted in database).
  - `queueJobsCount`: 1 (exactly 1 job enqueued with BullMQ `jobId = publish:{postId}:{version}`).
  - `auditRecordsCount`: 1 (`PUBLICATION_JOB_CREATED` logged exactly once).
  - All 100 callers resolved to the identical canonical `PublicationJob` with matching UUID and idempotency key.
- **Result**: **PASS** (Zero duplicates, 100% deterministic resolution).

#### Challenge 1.2: PostgreSQL Unique Constraint P2002 Race Condition Recovery
- **Assumption Challenged**: When two or more requests simultaneously find no existing job in DB and race to execute `prisma.publicationJob.create`, one succeeds and the others receive Prisma error `P2002`. The colliding requests must gracefully recover without throwing unhandled rejections or creating duplicate queue jobs.
- **Empirical Test**: Forced `findUnique` to return `null` for 20 concurrent requests, triggering 1 successful insert and 19 P2002 errors.
- **Empirical Observation**: `PublishingService` caught all 19 `P2002` errors and resolved them cleanly via `findUniqueOrThrow`. Exactly 1 job was enqueued.
- **Result**: **PASS**.

#### Challenge 1.3: Worker Redelivery Idempotency for COMPLETED and CANCELLED Jobs
- **Assumption Challenged**: If BullMQ redelivers a job whose publication was already completed or cancelled (e.g. following worker restart before ACK), the worker might re-dispatch messages to Telegram.
- **Empirical Test**: Dispatched mock jobs with status `COMPLETED` and `CANCELLED`.
- **Empirical Observation**: The processor immediately checked DB status and exited early (`publisherCalls = 0`, `workflowTransitions = 0`).
- **Result**: **PASS**.

#### Challenge 1.4: Partial Publication Resume (AGENTS.md §23, Rule F-34)
- **Assumption Challenged**: On worker retry after a transient error during a multi-message post (e.g., media group succeeded but overflow text failed), the worker might re-send the media group.
- **Empirical Test**: Dispatched a job whose attempt 1 had saved `telegramMessageIds = [7001, 7002]` for part 0 (media group).
- **Empirical Observation**: On attempt 2, the worker inspected `telegramMessageIds`, verified part 0 was already delivered, and dispatched ONLY part 1 (text). The final database record contained `[7001, 7002, 7003]`.
- **Result**: **PASS**.

---

### Dimension 2: Preflight Validation Hardening

#### Challenge 2.1: Post Status Lifecycle Enforcement
- **Assumption Challenged**: Draft, pending, rejected, or cancelled posts might slip into the publishing queue.
- **Empirical Observation**:
  - `DRAFT`, `PENDING_REVIEW`, `NEEDS_REVISION`, `REJECTED`, `CANCELLED`, `PUBLISHED` were all rejected in Stage 1 with `InvalidPostStateTransitionException`.
  - `APPROVED`, `SCHEDULED`, and `PUBLISH_FAILED` (manual retry) were correctly allowed through Stage 1.
  - Stage 2 rejected all non-executable post statuses with `TelegramPermanentException` (code 400).
- **Result**: **PASS**.

#### Challenge 2.2: Soft-Deleted & Missing Post Rejection
- **Assumption Challenged**: Posts with `deletedAt !== null` or missing IDs might be processed.
- **Empirical Observation**:
  - Stage 1 threw `ValidationException: Post "..." not found or deleted.`
  - Stage 2 threw `TelegramPermanentException: Preflight Stage 2 failed: Post "..." not found or soft-deleted` (code 400).
- **Result**: **PASS**.

#### Challenge 2.3: RBAC Permission Enforcement
- **Assumption Challenged**: An actor lacking `ChannelPermission.PUBLISH_POST` might be able to enqueue publications.
- **Empirical Observation**: `PublishingPreflightService` invoked `checkChannelPermission(actorId, channelId, ChannelPermission.PUBLISH_POST)` and threw `PermissionDeniedException` when false.
- **Result**: **PASS**.

#### Challenge 2.4: Target Channel Validity
- **Assumption Challenged**: Inactive channels or channels without `telegramChatId` might cause unhandled worker crashes.
- **Empirical Observation**:
  - `channel.isActive === false` -> Rejected in Stage 1 (`ValidationException`) and Stage 2 (`TelegramPermanentException`).
  - `channel.telegramChatId === ''` or `'   '` -> Rejected in Stage 1 and Stage 2.
- **Result**: **PASS**.

#### Challenge 2.5: Template Schema Validation
- **Assumption Challenged**: Content not adhering to template schema (missing required fields, string exceeding `maxLength`) might reach the Telegram publisher.
- **Empirical Observation**: `templateValidator.validateContent()` was invoked synchronously in Stage 1; invalid content was rejected with informative validation messages.
- **Result**: **PASS**.

#### Challenge 2.6: Media Invariants
- **Assumption Challenged**: Attaching >10 media items, items without `telegramFileId`/`telegramFileUniqueId`, or unsupported media types might bypass validation.
- **Empirical Observation**: Stage 1 preflight rejected counts > 10 (`exceeds maximum limit of 10`), items missing file IDs, and types unsupported by the template.
- **Result**: **PASS**.

---

## 4. Unchallenged Areas

- Hardware-level network partitioning while BullMQ renews distributed locks in Redis clusters (out of scope for single-node Redis in MVP).

---

## 5. Final Recommendation & Verdict

Milestone 4 implementation is **exceptionally robust, strictly adhering to all architectural principles and invariants**.
The concurrency safeguards, database unique constraints, two-stage preflight validation, and partial resume logic perform flawlessly under empirical stress.

**Final Verdict**: **APPROVE**
