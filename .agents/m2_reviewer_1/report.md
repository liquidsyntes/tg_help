# Milestone 2 Quality & Adversarial Review Report

**Reviewer**: `m2_reviewer_1` (Teamwork Reviewer & Adversarial Critic)  
**Target**: Milestone 2 (Domain Models, RBAC & State Machine) implemented by `m2_worker_1`  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m2_reviewer_1`  

---

## 1. Review Summary

**Definitive Verdict**: **APPROVE**  
**Integrity Assessment**: **PASSED** (Zero integrity violations; genuine domain implementations, real OCC concurrency control, robust database transactions, no hardcoded shortcuts or facades).  
**Risk Assessment**: **LOW** (Well-isolated domain architecture, high test fidelity across 111 unit tests and 34 E2E tests, clean compilation).

---

## 2. Mission Checklist Verification

### 2.1. Authentication by BigInt Telegram ID & Active Status Enforcement
- **Implementation**: `src/modules/auth/auth.service.ts`, `src/modules/users/users.service.ts`
- **Verification**:
  - `AuthService.resolveUser` and `AuthService.authenticate` accept `bigint | number | string` and parse via `BigInt(telegramId)`.
  - Stored `telegramId` in Prisma is a native `BigInt` unique identifier; no unstable username/display name authorization is permitted (AGENTS.md §8).
  - When `user.isActive === false`, `UserDeactivatedException` is thrown with the exact expected Russian user message: `"Ваш аккаунт деактивирован. Обратитесь к администратору."`.
  - When user is unknown/not registered, `UnauthorizedUserException` is thrown with the exact expected Russian user message: `"У вас пока нет доступа к редакции. Обратитесь к администратору."` (tasks.md §7).
- **Status**: **VERIFIED / PASS**

### 2.2. Dual-Tier RBAC, Capability Flags, SUPER_ADMIN Bypass, & Channel Active Checks
- **Implementation**: `src/modules/auth/permission.service.ts`
- **Verification**:
  - Dual-tier role hierarchy is enforced: system level (`SystemRole.SUPER_ADMIN`, `SystemRole.USER`) and channel level (`ChannelRole.EDITOR`, `ChannelRole.AUTHOR`, `ChannelRole.VIEWER`).
  - `SUPER_ADMIN` system bypass: unconditionally grants access to any channel action and any post modification without requiring explicit channel membership.
  - Channel active check: non-super-admins cannot perform any action in a channel where `isActive === false`.
  - Granular capability flags: `canPublish` and `canApprove` strictly gate `PUBLISH_POST`, `APPROVE_POST`, `REQUEST_REVISION`, and `REJECT_POST`.
  - Post edit ownership rules (`checkPostEditPermission`):
    - `SUPER_ADMIN` and `EDITOR` can edit any post in the channel.
    - `AUTHOR` can ONLY edit their own posts (`post.authorId === actorId`), and ONLY while in editable statuses (`DRAFT` or `NEEDS_REVISION`). Once submitted (`PENDING_REVIEW`) or approved (`APPROVED`), authors are strictly prevented from altering the post.
    - Author A cannot edit Author B's draft.
- **Status**: **VERIFIED / PASS**

### 2.3. Channels Multi-Channel Resolution, Auto-Skip Single Channel, & Timezone Conversion
- **Implementation**: `src/modules/channels/channels.service.ts`, `src/modules/channels/utils/timezone.util.ts`
- **Verification**:
  - `getUserAuthorizedChannels`: resolves all active channels for `SUPER_ADMIN`, or all active channels where user holds a membership for regular users.
  - `autoSkipSingleChannel`: returns `{ singleChannel: Channel, channels: [Channel], mustChoose: false }` if user has access to exactly 1 channel, and `{ singleChannel: null, channels, mustChoose: true }` if user has $>1$ channels. Satisfies tasks.md §9.
  - Timezone parsing (`parseAndValidateScheduledDate`): uses Luxon `IANAZone` with default `Europe/Kyiv` (tasks.md §3, §19; AGENTS.md §24, §47).
  - Supports `dd.MM.yyyy HH:mm`, `yyyy-MM-dd HH:mm`, and ISO 8601 strings.
  - Converts local Kyiv time to UTC instant (`Date` / PostgreSQL `TIMESTAMPTZ`).
  - Rejects past dates (`date.getTime() <= nowMs`) with `ValidationException`: `"Нельзя планировать публикацию в прошлом."`.
  - Formats UTC dates back to local channel time (`dd.MM.yyyy HH:mm`) via `formatChannelDate`.
- **Status**: **VERIFIED / PASS**

### 2.4. OCC, Post State Machine, Review Comments, & Audit Logging
- **Implementation**: `src/modules/posts/posts.repository.ts`, `src/modules/posts/post-workflow.service.ts`, `src/modules/reviews/reviews.service.ts`, `src/modules/audit/audit.service.ts`
- **Verification**:
  - `PostsRepository.updateWithOcc` atomically executes `WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL` and increments `version = version + 1`. On 0 rows affected, it checks if deleted (`ValidationException`) or conflicted (`PostConflictException` with `"Публикация была изменена другим пользователем."`).
  - `PostWorkflowService` governs all 10 states: `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`.
  - Invalid transitions throw `InvalidPostStateTransitionException`.
  - Atomic transactions (`prisma.$transaction`): OCC update, review record, and audit log write execute in a single database transaction.
  - `ReviewsService` strictly enforces non-empty feedback comments on `REQUEST_REVISION` / `NEEDS_REVISION`.
  - `AuditService` logs immutable records with deep recursive secret masking (`audit-payload.sanitizer.ts`).
  - `NotificationService` and `PostsService.autosaveStep` enforce the Autosave Silent Rule (F-40, zero notifications emitted on routine draft saves).
- **Status**: **VERIFIED / PASS**

---

## 3. Adversarial Stress-Test Challenges & Evaluation

### Challenge 1: Concurrency Conflict on State Transitions (OCC)
- **Attack Scenario**: Two editors review the same post in `PENDING_REVIEW` at the same time; Editor 1 approves while Editor 2 requests revision.
- **Evaluation**: The first transaction executes `updateWithOcc` matching `version = 1`, bumping it to `version = 2`. The second transaction attempts `updateWithOcc` with `expectedVersion = 1`; `updateMany` affects 0 rows. The repository queries the post, detects that `version` is now 2, and aborts with `PostConflictException`. Neither corrupted reviews nor phantom state updates occur.
- **Verdict**: **RESILIENT / PASS**

### Challenge 2: Inactive Channel Security Bypass
- **Attack Scenario**: An active editor attempts to create or edit posts in a channel that was deactivated (`isActive = false`) by a Super Admin.
- **Evaluation**: `PermissionService.checkChannelPermission` queries the channel and checks `if (!channel || !channel.isActive) return false;`. All operations are denied at the domain level before reaching database mutations.
- **Verdict**: **RESILIENT / PASS**

### Challenge 3: Inactive User Security Bypass
- **Attack Scenario**: A user is deactivated via `UsersService.deactivateUser`. They send a request with their Telegram ID.
- **Evaluation**: `AuthService.resolveUser` throws `UserDeactivatedException`. In addition, `PermissionService` checks `actor.isActive` and denies all channel/system operations.
- **Verdict**: **RESILIENT / PASS**

### Challenge 4: Author Privilege Escalation & Cross-Post Tampering
- **Attack Scenario**:
  1. Author A attempts to edit Author B's post.
  2. Author A attempts to edit their own post after it was approved (`APPROVED`) or submitted (`PENDING_REVIEW`).
  3. Author A attempts to approve or publish their own post.
- **Evaluation**:
  1. `checkPostEditPermission` checks `isOwner = post.authorId === actorId`. Author A is denied.
  2. `checkPostEditPermission` checks `isEditableStatus = post.status === PostStatus.DRAFT || post.status === PostStatus.NEEDS_REVISION`. Editing an approved or in-review post is denied.
  3. `APPROVE_POST` requires `member.role === ChannelRole.EDITOR && member.canApprove`. Author A cannot approve. `PUBLISH_POST` requires `member.canPublish`.
- **Verdict**: **RESILIENT / PASS**

### Challenge 5: Sensitive Credential Leakage in Audit Logs
- **Attack Scenario**: User content or command payload contains a Telegram Bot Token (`123456789:AAABBB...`) or database URI (`postgresql://postgres:secret@host:5432/db`).
- **Evaluation**: `sanitizeAuditPayload` recursively detects Telegram bot tokens and URI passwords and masks them with `[REDACTED_BOT_TOKEN]` and `[REDACTED]`. It also masks keys matching `token`, `password`, `secret`, `api_key`, and converts `BigInt` to string.
- **Verdict**: **RESILIENT / PASS**

### Challenge 6: Timezone Ambiguity & Past Date Injection
- **Attack Scenario**: Attacker attempts to schedule publication for a past date or invalid time format in `Europe/Kyiv`.
- **Evaluation**: `parseAndValidateScheduledDate` evaluates input against `Date.now()`. Past dates immediately throw `ValidationException('Нельзя планировать публикацию в прошлом.')`. Invalid formats are rejected with an instructive Russian error message.
- **Verdict**: **RESILIENT / PASS**

---

## 4. Build and Test Verification

Commands were independently executed in the environment:

1. **TypeScript Build Verification**:
   ```pwsh
   npm run build
   ```
   - Exit code: `0`
   - Output: NestJS build completed with 0 errors.

2. **TypeScript Strict Typecheck**:
   ```pwsh
   npx tsc --project tsconfig.build.json --noEmit
   ```
   - Exit code: `0`
   - Output: 0 type errors.

3. **Jest Unit Test Suite**:
   ```pwsh
   npm test
   ```
   - Exit code: `0`
   - Test Suites: `8 passed, 8 total`
   - Tests: `111 passed, 111 total`
   - Suites verified:
     - `auth.spec.ts` (10 tests)
     - `permissions.spec.ts` (11 tests)
     - `channels-timezone.spec.ts` (9 tests)
     - `occ-state-machine.spec.ts` (9 tests)
     - `audit-reviews.spec.ts` (11 tests)
     - `health.spec.ts`
     - `config.spec.ts`
     - `adversarial-stress.spec.ts`

4. **Hermetic E2E Test Suite**:
   ```pwsh
   npm run test:e2e
   ```
   - Exit code: `0`
   - Suites: `22 suites, 34 tests passed, 0 failed`
   - Coverage: Tier 1 (14 tests), Tier 2 (12 tests), Tier 3 (4 tests), Tier 4 (4 tests).

---

## 5. Coverage Gaps & Downstream Hand-off Notes

- **Downstream Boundaries**:
  - **Milestone 3**: Post templates, dynamic schema validation, HTML sanitizer, canonical `TelegramRenderer`, media handling.
  - **Milestone 4**: BullMQ publishing queue, worker execution, `ITelegramPublisher` abstraction, idempotency keys, partial publishing resume.
  - **Milestone 5**: grammY Telegram bot setup, Telegram callback handlers, and wizard UI.
- All foundation contracts required for Milestones 3, 4, and 5 have been implemented, verified, and exported in `AppModule`.

---

## 6. Conclusion

Milestone 2 implementation satisfies all product and architectural requirements specified in `AGENTS.md`, `tasks.md`, and `PROJECT.md`. The domain services are cleanly isolated, data integrity is guarded by Optimistic Concurrency Control, and security rules prevent privilege escalation.

**Final Verdict**: **APPROVE**
