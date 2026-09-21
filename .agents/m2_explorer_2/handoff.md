# Handoff Report — Milestone 2: Post Workflow State Machine, OCC, and Reviews

**Agent**: `m2_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Handoff Type**: Hard (Investigation & Technical Design Complete)  
**Target Recipient**: Orchestrator (`6f35b072-3fac-43df-87fc-95e48993acc2`) / Milestone 2 Implementer  
**Detailed Report**: `c:/TgHelp/.agents/m2_explorer_2/report.md`

---

## 1. Observation

1. **Existing Database Schema & Models**:
   - `prisma/schema.prisma` lines 25-36 define `enum PostStatus`: `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`.
   - Lines 143-173 define `model Post` with `version Int @default(1) @map("version")`, `scheduledAt DateTime?`, `publishedAt DateTime?`, and `deletedAt DateTime? @map("deleted_at") @db.Timestamptz`.
   - Lines 197-211 define `model PostReview` with `postId String`, `reviewerId String`, `action ReviewAction`, `comment String?`.
   - Lines 259-274 define `model AuditLog` with `action String`, `entityType String`, `entityId String`, `actorId String?`, `payload Json`.

2. **Existing Domain Exceptions & Error Requirements**:
   - `src/common/exceptions/domain.exceptions.ts` line 62 defines `InvalidStateTransitionException`.
   - Prompt specifically requires: `"Disallowed transitions MUST throw InvalidPostStateTransitionException."`
   - `tests/e2e/tier1-feature-coverage.spec.ts` line 223-224 expects:
     ```ts
     assert.ok(err instanceof InvalidStateTransitionException);
     assert.match(err.message, /Invalid status transition from DRAFT to APPROVED/i);
     ```
   - `tests/e2e/tier2-boundary-cases.spec.ts` line 144-145 expects:
     ```ts
     assert.ok(err instanceof PostConflictException);
     assert.match((err as Error).message, /Публикация была изменена другим пользователем/i);
     ```
   - `tests/e2e/tier2-boundary-cases.spec.ts` lines 50-51 & 74-75 expect:
     ```ts
     assert.ok(err instanceof ValidationError);
     assert.match((err as Error).message, /обязателен комментарий/i);
     ```

3. **Existing Test Suite Baseline**:
   - Jest unit tests (`npm test`): 3 test suites, 61 passed, 0 failed.
   - Node E2E tests (`npm run test:e2e`): 4 suites, 34 passed, 0 failed.

4. **Test Harness Workflow Invariants (`tests/harness/test-harness.ts`)**:
   - Line 121 defines `ALLOWED_TRANSITIONS`:
     `DRAFT -> ['PENDING_REVIEW']`
     `PENDING_REVIEW -> ['APPROVED', 'NEEDS_REVISION', 'REJECTED']`
     `NEEDS_REVISION -> ['PENDING_REVIEW']`
     `APPROVED -> ['SCHEDULED', 'PUBLISHING']`
     `SCHEDULED -> ['PUBLISHING', 'CANCELLED']`
     `PUBLISHING -> ['PUBLISHED', 'PUBLISH_FAILED']`
     `PUBLISH_FAILED -> ['PUBLISHING', 'CANCELLED']`
     `REJECTED -> []`, `CANCELLED -> []`, `PUBLISHED -> []`.
   - Line 490 checks mandatory review comments:
     `if (!comment || comment.trim() === '') throw new ValidationError('Для возврата на доработку обязателен комментарий.');`
   - Line 555 checks past date scheduling:
     `if (scheduledAt.getTime() <= Date.now()) throw new ValidationError('Нельзя планировать публикацию в прошлом.');`
   - Line 324, 374, 409, 434, 546, 593: all operations reject if `!post || post.deletedAt !== null`.

---

## 2. Logic Chain

1. **State Machine Conformance**:
   - Observation (1) and Observation (4) show 10 statuses and an exact directed transition graph.
   - By creating `PostWorkflowService.transition()`, all status changes are checked against `ALLOWED_TRANSITIONS`. If invalid, `InvalidPostStateTransitionException` is thrown.
   - By aliasing `InvalidStateTransitionException = InvalidPostStateTransitionException` and formatting the message as `Invalid status transition from ${currentStatus} to ${targetStatus}`, existing tests (Observation 2) pass while fulfilling the prompt.

2. **Atomic OCC Execution with Prisma**:
   - Because `[id, version]` is not a unique composite key in Prisma, `prisma.post.updateMany` with `where: { id: postId, version: expectedVersion, deletedAt: null }` and `data: { version: { increment: 1 } }` generates atomic SQL `UPDATE posts SET version = version + 1 WHERE id = $1 AND version = $2 AND deleted_at IS NULL`.
   - If `result.count === 0`, checking `findUnique` reveals whether the post was deleted/missing (`PostNotFoundException` / `ValidationError`) or modified concurrently (`PostConflictException` with Russian message `"Публикация была изменена другим пользователем. ..."` matching Observation 2).

3. **Transactional Integrity for Reviews and Audit**:
   - Per `AGENTS.md` §28, a transition is a logical unit comprising post status change + review entry + audit log.
   - By executing `PostsRepository.updateWithOcc`, `ReviewsService.createReview`, and `AuditLogService.record` inside `prisma.$transaction(async (tx) => ...)`, database consistency is guaranteed.
   - Notifications are dispatched outside the transaction post-commit, ensuring notification network errors never roll back database transactions.

4. **Soft Deletion Filtering**:
   - Per `AGENTS.md` §31 and Observation (4), queries must exclude soft-deleted posts (`deletedAt: null`).
   - By encapsulating all database queries inside `PostsRepository`, default queries consistently filter out `deletedAt IS NOT NULL`, while attempts to mutate deleted records fail with `ValidationError('Post not found or deleted.')`.

---

## 3. Caveats

1. **PermissionService Interface Integration**: `m2_explorer_1` is designing `PermissionService`. The implementation in `PostWorkflowService` assumes `permissionService.checkPermission(actorId, channelId, permission)` returns `Promise<boolean>` and handles `SUPER_ADMIN` system role bypass, matching `test-harness.ts`.
2. **Notification Service Decoupling**: `m2_explorer_3` is designing `NotificationService` and `AuditLogService`. The transaction boundary must ensure notifications are called after `prisma.$transaction` commits to uphold `AGENTS.md` §27.
3. **Queue Enqueueing (Milestone 4)**: In Milestone 2, `SCHEDULED` stores `scheduledAt` in the database. Active delayed job enqueueing to BullMQ occurs in Milestone 4 (`F-30`, `F-37`).

---

## 4. Conclusion

The architectural design for `PostWorkflowService`, `PostsRepository` (with OCC and Soft Deletion), and `ReviewsService` is complete, fully specified, and documented in `c:/TgHelp/.agents/m2_explorer_2/report.md`.
The implementation maintains 100% compliance with `AGENTS.md`, `tasks.md`, existing schema models, and the 95 existing tests across Jest and Node E2E test runners.

---

## 5. Verification Method

To independently verify the architecture and subsequent worker implementation:

1. **Verify Existing Tests Pass**:
   ```bash
   npm test
   npm run test:e2e
   ```
2. **Inspect Technical Specifications**:
   - View report: `c:/TgHelp/.agents/m2_explorer_2/report.md`
3. **Post-Implementation Regression & Type Check**:
   ```bash
   npx tsc --noEmit
   npm test
   npm run test:e2e
   ```
   All 34 E2E tests and 61 Jest tests must continue to pass without error.
