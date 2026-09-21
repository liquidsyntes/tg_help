# Milestone 2 Handoff Report: Domain Models, RBAC & State Machine

**Author**: `m2_worker_1` (teamwork_preview_worker: implementer, qa, specialist)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 2 (Domain Models, RBAC & State Machine)  
**Status**: Task Complete (Hard Handoff)

---

## 1. Observation

1. **Initial Codebase State**:
   - Milestone 1 was completed: Prisma models (10 models), BullMQ, Redis, StructuredLogger, EnvironmentConfig, and Health probe were functional.
   - None of the Milestone 2 domain modules existed in `src/modules/` prior to this task (only `modules/health/`).
   - `npm test` ran 3 suites (`config.spec.ts`, `health.spec.ts`, `adversarial-stress.spec.ts`) with 61 tests passing.
   - `npm run test:e2e` ran 4 tiers (`tier1-feature-coverage.spec.ts`, `tier2-boundary-cases.spec.ts`, `tier3-cross-feature.spec.ts`, `tier4-application-scenarios.spec.ts`) with 34 tests passing using the in-memory test harness.

2. **Implemented Milestone 2 Domain Modules**:
   - `src/common/exceptions/domain.exceptions.ts`: Implemented `InvalidPostStateTransitionException` (with `InvalidStateTransitionException` alias), `PostConflictException` with prefix `"Публикация была изменена другим пользователем."`, `ValidationError` alias, and user-friendly Russian messages in `UnauthorizedUserException` and `UserDeactivatedException`.
   - `src/common/enums/index.ts`: Re-exported Prisma enums (`SystemRole`, `ChannelRole`, `PostStatus`, `MediaType`, `ReviewAction`, `PublicationJobStatus`) and added `ChannelPermission`, `SystemPermission`, and `AuditAction`.
   - `src/modules/audit/`: Implemented `AuditService` with append-only semantics, `audit-payload.sanitizer.ts` with recursive token, database password, and secret redaction, and `AuditModule`.
   - `src/modules/notifications/`: Implemented `DomainEventBus` (RxJS-based), `NotificationService` with non-blocking alert dispatch and notification logging, domain events (`PostSubmittedEvent`, `PostApprovedEvent`, etc.), and `NotificationsModule`.
   - `src/modules/users/`: Implemented `UsersRepository`, `UsersService` with BigInt `telegramId` parsing, user lifecycle (`createUser`, `updateUser`, `deactivateUser`, `reactivateUser`) with audit logging, and `UsersModule`.
   - `src/modules/auth/`: Implemented `AuthService` (`resolveUser`, `authenticate`, active status enforcement), `PermissionService` (RBAC with `SUPER_ADMIN` system bypass, channel permission matrix, post ownership rules), `AuthGuard`, `RoleGuard`, and `AuthModule`.
   - `src/modules/channels/`: Implemented `ChannelsService` (multi-channel querying, `autoSkipSingleChannel` helper), `timezone.util.ts` using Luxon for channel timezone parsing (`Europe/Kyiv` -> UTC `TIMESTAMPTZ` with past-date rejection), and `ChannelsModule`.
   - `src/modules/reviews/`: Implemented `ReviewsService` with mandatory non-empty comment enforcement on `REQUEST_REVISION`, review history querying, and `ReviewsModule`.
   - `src/modules/posts/`: Implemented `PostsRepository` (Optimistic Concurrency Control atomic check `WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL` incrementing version, soft deletion filter `deletedAt: null`), `PostWorkflowService` (10-status state machine, allowed transitions matrix, atomic `prisma.$transaction` combining OCC post update, review record, and audit log, followed by post-commit domain event emission), `PostsService` (draft creation, silent autosave emitting zero notifications per F-40, media attachment, soft delete), and `PostsModule`.
   - `src/app.module.ts`: Registered all 7 new modules (`AuditModule`, `NotificationsModule`, `UsersModule`, `AuthModule`, `ChannelsModule`, `ReviewsModule`, `PostsModule`).

3. **Build & Test Verification Execution**:
   - Command `npx tsc --project tsconfig.build.json --noEmit`: Exited with code 0 (0 errors).
   - Command `npm run build`: Exited with code 0.
   - Command `npm test`:
     ```text
     PASS tests/unit/auth.spec.ts (7.95 s)
     PASS tests/unit/audit-reviews.spec.ts (7.912 s)
     PASS tests/unit/occ-state-machine.spec.ts (7.996 s)
     PASS tests/unit/permissions.spec.ts (8.056 s)
     PASS tests/unit/channels-timezone.spec.ts (8.354 s)
     PASS tests/unit/config.spec.ts
     PASS tests/unit/health.spec.ts (8.462 s)
     PASS tests/unit/adversarial-stress.spec.ts (11.29 s)

     Test Suites: 8 passed, 8 total
     Tests:       111 passed, 111 total
     Snapshots:   0 total
     Time:        12.22 s
     Ran all test suites.
     ```
   - Command `npm run test:e2e`:
     ```text
     ℹ tests 34
     ℹ suites 22
     ℹ pass 34
     ℹ fail 0
     ```

---

## 2. Logic Chain

1. **Identity & Authentication (F-01, tasks.md §4, §7; AGENTS.md §8)**:
   - *Observation*: `users.telegram_id` in PostgreSQL is a `BigInt` unique identifier. Usernames and display names are mutable.
   - *Deduction*: `AuthService` must accept and parse incoming identifiers as `BigInt`. Active status (`isActive`) must be enforced before allowing access. Unknown users must trigger `UnauthorizedUserException` with the exact Russian message: `"У вас пока нет доступа к редакции. Обратитесь к администратору."`. Deactivated users must trigger `UserDeactivatedException` with `"Ваш аккаунт деактивирован. Обратитесь к администратору."`.

2. **RBAC & System Bypass (F-02, tasks.md §5; AGENTS.md §9)**:
   - *Observation*: Role model consists of `systemRole` (`SUPER_ADMIN`, `USER`) and channel-level `role` (`EDITOR`, `AUTHOR`, `VIEWER`) plus flags `canPublish` and `canApprove`.
   - *Deduction*: `PermissionService` checks actor status first. If actor is `SUPER_ADMIN`, all channel restrictions are bypassed. Otherwise, channel active status and membership are evaluated against the action permission matrix. In addition, post edit ownership rules restrict authors to modifying only their own posts and only while in `DRAFT` or `NEEDS_REVISION` status.

3. **Timezone Conversion & Wizard Auto-Skip (F-05, F-06, tasks.md §3, §9, §19; AGENTS.md §24, §47)**:
   - *Observation*: Publication dates are submitted in local channel time (default `Europe/Kyiv`) but persisted as UTC `TIMESTAMPTZ`. Past publication dates are invalid.
   - *Deduction*: `timezone.util.ts` uses Luxon's `IANAZone` to resolve the timezone, parse `dd.MM.yyyy HH:mm` and ISO formats, reject dates where `date.getTime() <= nowMs` with `"Нельзя планировать публикацию в прошлом."`, and convert to UTC `Date`. `autoSkipSingleChannel` queries authorized channels; if `channels.length === 1`, it signals `mustChoose: false` with `singleChannel`.

4. **Optimistic Concurrency Control (OCC) & Soft Deletion (F-15, F-16, tasks.md §12; AGENTS.md §13, §31)**:
   - *Observation*: Concurrent updates by multiple users or workers must not cause lost updates. Soft-deleted posts must not be modified or published.
   - *Deduction*: `PostsRepository.updateWithOcc` executes atomic Prisma `updateMany` matching `WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL` and incrementing `version = version + 1`. If 0 rows are affected, it checks if the post is deleted (throwing `ValidationException`) or if a version conflict occurred (throwing `PostConflictException` with `"Публикация была изменена другим пользователем."`). Soft deletion sets `deletedAt = NOW()`, and all standard repository queries apply `deletedAt: null`.

5. **Post Workflow State Machine & Atomic Transactions (F-23, F-25, F-26, F-27, tasks.md §6, §13; AGENTS.md §10, §28)**:
   - *Observation*: Post lifecycle traverses 10 states. Editorial reviews (`APPROVE`, `REQUEST_REVISION`, `REJECT`) create review records. `REQUEST_REVISION` strictly mandates a non-empty comment. Audit logging is required for every state transition.
   - *Deduction*: `PostWorkflowService.transition` validates transitions against `ALLOWED_TRANSITIONS`. Invalid transitions throw `InvalidPostStateTransitionException`. Preconditions (such as mandatory comment) are verified before entering the database transaction. Inside a single short `prisma.$transaction`, OCC update, review insertion, and audit log entry execute atomically. Decoupled notifications are dispatched via `DomainEventBus` post-commit, ensuring notification delivery issues cannot abort database state.

6. **Audit Sanitization & Autosave Silent Rule (F-40, F-41, tasks.md §24, §26; AGENTS.md §26, §27, §33, §34)**:
   - *Observation*: Audit records are append-only and must never leak secrets (tokens, DB passwords). Routine draft autosaves (`post_updated`) must emit 0 notifications.
   - *Deduction*: `AuditService.record` applies recursive sanitization regexes to redact bot tokens (`\b\d{8,11}:[A-Za-z0-9_-]{35,}\b`) and URI credentials, and masks sensitive keys (`token`, `password`, `secret`, `api_key`). `PostsService.autosaveStep` updates draft content and logs audit records without publishing any events to `DomainEventBus`, guaranteeing the Autosave Silent Rule.

---

## 3. Caveats

- **External Services in Test Mode**: The E2E tests in `tests/e2e/` run hermetically with Node test runner using the in-memory `TestHarness` from Milestone 1. Live PostgreSQL and Redis containers (defined in `docker-compose.yml`) are verified during containerized runs.
- **Milestone 3 & 4 Hand-off Boundaries**: The publishing worker (`PublishingWorker`), BullMQ queues for delayed scheduling, template dynamic schema rendering (`TelegramRenderer`), and grammY Telegram bot handlers will be implemented in subsequent milestones (M3, M4, M5). Milestone 2 delivers the complete foundational domain models, repository OCC layer, RBAC, workflow state machine, audit logging, reviews, and event notifications that those milestones depend upon.

---

## 4. Conclusion

Milestone 2 is completely implemented and verified in strict accordance with `AGENTS.md`, `tasks.md`, `PROJECT.md`, and the Explorer reports:
1. `UsersService` and `AuthService` authenticate users by BigInt `telegramId` and enforce active status with Russian rejection messages.
2. `PermissionService` provides full dual-tier RBAC (`SUPER_ADMIN` override, channel roles, granular flags `canPublish`/`canApprove`, post ownership rules).
3. `ChannelsService` handles multi-channel querying, `autoSkipSingleChannel` wizard shortcut, and Luxon-based timezone parsing with past-date rejection.
4. `PostsRepository` and `PostWorkflowService` manage the 10-status post lifecycle with OCC atomic checks (`updateWithOcc`), soft deletion (`deleted_at = NOW()`), and atomic unit-of-work transactions.
5. `ReviewsService` strictly enforces non-empty feedback comments on `REQUEST_REVISION`.
6. `AuditService` ensures append-only logging with recursive secret and token sanitization.
7. `NotificationService` and `DomainEventBus` deliver decoupled, post-commit domain alerts while honoring the Autosave Silent Rule.
8. NestJS compilation (`npm run build`) passes cleanly with 0 errors.
9. All 111 unit tests (`npm test`) and all 34 E2E tests (`npm run test:e2e`) pass with 100% success rate.

---

## 5. Verification Method

To independently verify the implementation:

1. **Verify TypeScript Compilation**:
   ```bash
   npm run build
   npx tsc --project tsconfig.build.json --noEmit
   ```
   *Expected Output*: Exit code 0, 0 compilation or type errors.

2. **Run Unit Test Suite**:
   ```bash
   npm test
   ```
   *Expected Output*: 8 test suites passed, 111 tests passed, 0 failures.

3. **Run End-to-End Test Suite**:
   ```bash
   npm run test:e2e
   ```
   *Expected Output*: 34 tests passed, 0 failures across all 4 tiers.

4. **Inspect Key Artifacts**:
   - State transition matrix: `src/modules/posts/post-workflow.service.ts` lines 36-48.
   - OCC atomic update: `src/modules/posts/posts.repository.ts` lines 61-97.
   - Timezone conversion: `src/modules/channels/utils/timezone.util.ts` lines 14-41.
   - Audit payload sanitizer: `src/modules/audit/audit-payload.sanitizer.ts` lines 31-80.
   - Mandatory review comment check: `src/modules/reviews/reviews.service.ts` lines 21-27.
