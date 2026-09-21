# Empirical Challenge Report: Milestone 2 (State Machine, OCC, and Reviews)

**Challenger**: `m2_challenger_2` (teamwork_preview_challenger: critic, specialist)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 2 (Domain Models, RBAC & State Machine)  
**Database**: Live PostgreSQL 18.6 (`postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public`)  
**Cache / Queue Broker**: Live Redis 8.0.5 (`redis://127.0.0.1:6379`)  
**Verdict**: **APPROVE**

---

## 1. Challenge Summary

**Overall Risk Assessment**: **LOW**

All 4 mission-mandated invariants and 25 comprehensive stress scenarios were empirically evaluated against live PostgreSQL and live Redis using the full NestJS application context (`AppModule`), live database repositories (`PostsRepository`), domain services (`PostsService`, `PostWorkflowService`, `ReviewsService`, `AuditService`, `PermissionService`), and RxJS event stream (`DomainEventBus`).

| Category | Stress Scenarios Run | Passed | Failed | Empirical Status |
|---|:---:|:---:|:---:|:---:|
| 1. Optimistic Concurrency Control (OCC) | 5 | 5 | 0 | **VERIFIED** |
| 2. Review Comment Invariant | 5 | 5 | 0 | **VERIFIED** |
| 3. Soft Delete Invariant | 5 | 5 | 0 | **VERIFIED** |
| 4. Transaction Atomicity & Rollback | 3 | 3 | 0 | **VERIFIED** |
| 5. Adversarial Invariants & RBAC Boundaries | 7 | 7 | 0 | **VERIFIED** |
| **Total** | **25** | **25** | **0** | **100% PASS** |

---

## 2. Empirical Stress Test Suites & Results

### Suite 1: Concurrency Stress (Optimistic Concurrency Control)
*Harness*: `tests/stress/m2-empirical-challenge.ts` (Lines 185–330)

1. **Simultaneous 2-Worker OCC Race on Version 1**:
   - *Test*: Created post with initial `version = 1`. Dispatched two concurrent updates (`postsRepo.updateWithOcc`) via `Promise.allSettled`.
   - *Expected*: Exactly 1 promise fulfills with `version = 2`. Exactly 1 promise rejects with `PostConflictException` containing Russian prefix `"Публикация была изменена другим пользователем."`. Live PostgreSQL reflects `version = 2`.
   - *Empirical Result*: **PASS** (1 fulfilled, 1 rejected with `PostConflictException`, live DB version strictly 2).
2. **High-Burst 10-Worker OCC Race on Version 1**:
   - *Test*: Dispatched 10 concurrent updates on version 1 simultaneously.
   - *Expected*: Exactly 1 succeeds, exactly 9 fail with `PostConflictException`. Live DB version increments to exactly 2.
   - *Empirical Result*: **PASS** (1 fulfilled, 9 rejected with `PostConflictException`, DB version strictly 2).
3. **OCC Progression & Retry**:
   - *Test*: Worker that lost version 1 race retries with `expectedVersion = 2`.
   - *Expected*: Retry succeeds, increments version to 3. Live DB reflects `version = 3`.
   - *Empirical Result*: **PASS**.
4. **Concurrent Autosaves (`PostsService.autosaveStep`)**:
   - *Test*: Two simultaneous autosaves with `expectedVersion = 1` modifying `title` and `body`.
   - *Expected*: Exactly 1 succeeds, 1 rejects with `PostConflictException`. DB version is 2.
   - *Empirical Result*: **PASS**.
5. **Concurrent Workflow Transitions (`PostWorkflowService.transition`)**:
   - *Test*: Editor A requests `APPROVED` while Editor B requests `REJECTED` simultaneously on version 1.
   - *Expected*: Exactly 1 transition commits; the loser rejects with `PostConflictException`. Post status is deterministic (either `APPROVED` or `REJECTED`, never corrupted or dual-applied).
   - *Empirical Result*: **PASS**.

---

### Suite 2: Review Comment Invariant
*Harness*: `tests/stress/m2-empirical-challenge.ts` (Lines 340–535)

1. **Empty String Comment Rejection**:
   - *Test*: Transition post in `PENDING_REVIEW` to `NEEDS_REVISION` with `comment: ""`.
   - *Expected*: Rejects with `ValidationException` (`"Для возврата на доработку обязателен комментарий."`). Live PostgreSQL status remains `PENDING_REVIEW`, version remains 1, 0 review records inserted.
   - *Empirical Result*: **PASS** (Caught `ValidationException`, DB status `PENDING_REVIEW`, DB version 1, 0 reviews in `post_reviews`).
2. **Spaces-Only Whitespace Rejection**:
   - *Test*: Transition to `NEEDS_REVISION` with `comment: "     "`.
   - *Expected*: Rejects with `ValidationException`. Live PostgreSQL post status remains `PENDING_REVIEW`, version remains 1.
   - *Empirical Result*: **PASS**.
3. **Complex Whitespace Rejection (`\n\t  \r\n \t  `)**:
   - *Test*: Transition to `NEEDS_REVISION` with mixed whitespace and newlines.
   - *Expected*: Rejects with `ValidationException`. Post status and version remain unchanged in PostgreSQL.
   - *Empirical Result*: **PASS**.
4. **Direct Service Boundary Check (`ReviewsService.createReview`)**:
   - *Test*: Call `createReview` directly with `action: REQUEST_REVISION` and empty/whitespace comment.
   - *Expected*: Rejects with `ValidationException`. Zero records created in PostgreSQL.
   - *Empirical Result*: **PASS**.
5. **Valid Non-Empty Comment & Resubmission Cycle**:
   - *Test*: Transition to `NEEDS_REVISION` with valid comment `"  Пожалуйста, замените изображение в превью и уточните дату события.  "`.
   - *Expected*: Succeeds, post status becomes `NEEDS_REVISION`, version becomes 2. Review record saved with trimmed comment. Author resubmission (`NEEDS_REVISION -> PENDING_REVIEW`) succeeds and increments version to 3.
   - *Empirical Result*: **PASS** (Trimmed comment persisted, author resubmitted successfully to `PENDING_REVIEW` v3).

---

### Suite 3: Soft Delete Invariant
*Harness*: `tests/stress/m2-empirical-challenge.ts` (Lines 545–665)

1. **Soft Delete Execution**:
   - *Test*: Execute `postsService.softDeletePost(postId, 1, authorId)`.
   - *Expected*: Post updated with `deletedAt = NOW()`, version increments to 2. `postsRepo.findById` returns null.
   - *Empirical Result*: **PASS** (DB `deleted_at` timestamp set, version 2, default query returns `null`, query with `includeDeleted=true` returns record).
2. **Update Rejection via `PostsService.autosaveStep`**:
   - *Test*: Attempt `autosaveStep` on soft-deleted post.
   - *Expected*: Rejects with `PostNotFoundException`. PostgreSQL content and version untouched.
   - *Empirical Result*: **PASS**.
3. **Update Rejection via Direct `PostsRepository.updateWithOcc`**:
   - *Test*: Call `postsRepo.updateWithOcc` on soft-deleted post.
   - *Expected*: Atomic SQL update filters `deleted_at IS NULL`, updates 0 rows, detects deleted status, and throws `ValidationException`.
   - *Empirical Result*: **PASS**.
4. **Transition Rejection via `PostWorkflowService.transition`**:
   - *Test*: Attempt state machine transition on soft-deleted post.
   - *Expected*: Rejects with `ValidationException` (`Post "..." not found or deleted.`). Post remains in `DRAFT` status.
   - *Empirical Result*: **PASS**.
5. **Channel and Author Query Filtering**:
   - *Test*: Query `findByChannel`, `findByAuthor`, and `findPendingReview`.
   - *Expected*: Soft-deleted post is excluded from all standard operational listings.
   - *Empirical Result*: **PASS**.

---

### Suite 4: Transaction Atomicity & Rollback
*Harness*: `tests/stress/m2-empirical-challenge.ts` (Lines 675–845)

1. **Audit Log Failure Rollback**:
   - *Test*: Simulate database failure on audit log write (`auditService.record` throws inside `prisma.$transaction`).
   - *Expected*: Entire transaction aborts. In live PostgreSQL: post status rolls back to `PENDING_REVIEW` (NOT `APPROVED`), version rolls back to 1 (NOT 2), 0 review records committed, 0 audit records committed, 0 domain events emitted.
   - *Empirical Result*: **PASS** (Database status strictly `PENDING_REVIEW`, version strictly 1, `post_reviews` count unchanged, `audit_logs` count unchanged, 0 events published).
2. **Review Creation Failure Rollback**:
   - *Test*: Simulate failure on review record insertion (`reviewsService.createReview` throws inside `prisma.$transaction`).
   - *Expected*: Entire transaction aborts. Post status and version roll back completely.
   - *Empirical Result*: **PASS** (Database status remains `PENDING_REVIEW`, version 1, zero partial records).
3. **Clean Atomic Transition Verification**:
   - *Test*: Transition post cleanly to `APPROVED`.
   - *Expected*: Atomically updates post status, increments version, inserts review record, inserts audit log, and emits `PostApprovedEvent` post-commit.
   - *Empirical Result*: **PASS**.

---

### Suite 5: Adversarial Invariants & Edge Cases
*Harness*: `tests/stress/m2-empirical-challenge.ts` (Lines 850–1035)

1. **Direct Illegal Transition (`DRAFT -> APPROVED`)**: Rejects with `InvalidPostStateTransitionException` (**PASS**).
2. **Terminal State Transitions**: Transitions from `REJECTED`, `PUBLISHED`, `CANCELLED` are rejected (**PASS**).
3. **RBAC Author Self-Approval Attack**: Author without `APPROVE_POST` cannot approve own post; rejected with `PermissionDeniedException` (**PASS**).
4. **RBAC Viewer Draft Creation Attack**: Viewer role without `CREATE_POST` rejected with `PermissionDeniedException` (**PASS**).
5. **Past Scheduling Preflight**: Scheduling with datetime in the past rejected with `ValidationException` (**PASS**).
6. **Future Scheduling Lifecycle**: Scheduling with future date sets `scheduledAt`, transitions to `SCHEDULED`, and can be cleanly cancelled to `CANCELLED` (**PASS**).
7. **Autosave Silent Rule (F-40)**: 3 consecutive autosave steps update post content and version, write 3 audit records, and emit **0** domain events (**PASS**).

---

## 3. Challenges & Findings

### Challenge 1: WSL Process Lifetime vs PostgreSQL Connectivity [RESOLVED]
- **Risk**: MEDIUM
- **Observation**: During initial verification, WSL2 Ubuntu automatically stopped after idle periods, causing subsequent PostgreSQL connections to fail with `ECONNREFUSED 127.0.0.1:5432`.
- **Root Cause**: WSL2 terminates when no active sessions are running, stopping background services.
- **Resolution**: Launched a persistent daemon runner holding the WSL process active (`wsl -d Ubuntu -u root bash -c "service postgresql start && service redis-server start && sleep 86400"`) with `IsDaemon: true`. PostgreSQL and Redis remained 100% stable throughout all 25 stress test runs.

### Challenge 2: PostWorkflowService Preflight vs In-Transaction Error Handling [VERIFIED ROBUST]
- **Observation**: In `PostWorkflowService.transition`, review comment validation and permission checks occur prior to entering `prisma.$transaction`. Step A updates post status via OCC, Step B creates review, and Step C creates audit log inside `prisma.$transaction`. Decoupled domain event dispatching is strictly post-commit (`dispatchDomainEvents` after `$transaction`).
- **Empirical Proof**: When simulated failures were injected into Step B (review) or Step C (audit), PostgreSQL executed complete atomicity rollback (`ROLLBACK`), leaving post status and version pristine. No domain events were emitted for rolled-back transactions.

---

## 4. Unchallenged Areas

- **Queue Publishing Workers (BullMQ Worker)**: Scope of Milestone 4 (`PublishingWorker`, `TelegramPublisher`). Verified queue connection and models in M1, but publishing worker logic is scheduled for M4.
- **Dynamic Template Schema Validation & Rendering**: Scope of Milestone 3 (`TelegramRenderer`, `TemplateValidator`). Milestone 2 verified template foreign keys, versioning, and draft persistence.
- **Telegram Bot Transport (grammY)**: Scope of Milestone 5. M2 domain services were tested through application service boundaries, adhering to AGENTS.md § 3.

---

## 5. Conclusion & Final Verdict

Milestone 2 implementation by `m2_worker_1` fulfills all requirements with zero defects:
1. **Optimistic Concurrency Control**: Guarantees zero lost updates; concurrent races result in exactly 1 winner and clean `PostConflictException` with user-friendly Russian messages for all losers.
2. **Review Comment Invariant**: Strictly rejects empty or whitespace-only feedback comments; post status and version remain unaltered in PostgreSQL.
3. **Soft Delete Invariant**: Guarantees soft-deleted posts cannot be updated, transitioned, or retrieved by active operational queries.
4. **Transaction Atomicity**: All multi-entity state transitions execute inside atomic database transactions (`prisma.$transaction`) that completely roll back on any failure without leaking partial records or prematurely emitting domain events.
5. **Autosave Silent Rule**: Fully compliant with F-40; zero notifications emitted during routine draft saves.

**Verdict**: **APPROVE**
