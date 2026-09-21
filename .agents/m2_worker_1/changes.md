# Milestone 2 Implementation Changes

**Agent**: `m2_worker_1` (Teamwork Implementer / QA / Specialist)  
**Date**: 2026-09-21  
**Milestone**: Milestone 2 (Domain Models, RBAC & State Machine)

---

## 1. Summary of Changes

Milestone 2 establishes the core domain architecture of the Telegram Content Publisher Bot:
- Domain exceptions with user-friendly Russian messages, OCC conflict diagnostics, and aliases.
- Unified domain enums aligning with `@prisma/client`.
- Users and Authentication services anchored exclusively on `BigInt` Telegram IDs.
- Dual-tier RBAC system (`SUPER_ADMIN` system bypass, channel-scoped roles `EDITOR`/`AUTHOR`/`VIEWER`, granular flags `canPublish`/`canApprove`, post ownership rules).
- Channels service supporting multi-channel querying, `autoSkipSingleChannel` wizard helper, and Luxon-based IANA timezone conversions (`Europe/Kyiv` -> UTC `TIMESTAMPTZ` with past-date rejection).
- Append-only `AuditService` with deep recursive payload sanitization for bot tokens, connection credentials, and sensitive keys.
- Decoupled `NotificationService` consuming `DomainEventBus` events post-commit, enforcing the Autosave Silent Rule (F-40, zero notifications on routine draft saves).
- `ReviewsService` enforcing mandatory non-empty comments on `REQUEST_REVISION` / `NEEDS_REVISION`.
- `PostsRepository` implementing Optimistic Concurrency Control (`updateWithOcc`: atomic `WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL` incrementing version) and soft deletion (`deleted_at = NOW()`).
- `PostWorkflowService` controlling the 10-status post lifecycle (`DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`), invalid transition guards throwing `InvalidPostStateTransitionException`, and atomic state updates inside `prisma.$transaction` combining OCC update, review record, and audit log.
- Full wiring into `AppModule`.
- 5 new Jest unit test suites in `tests/unit/` (50 new unit tests), bringing total unit tests to 111/111 passing and e2e tests to 34/34 passing.

---

## 2. File Modification & Creation Inventory

### Common Layer
1. `src/common/exceptions/domain.exceptions.ts`
   - Added `InvalidPostStateTransitionException` and alias `InvalidStateTransitionException`.
   - Updated `PostConflictException` to prefix with `"Публикация была изменена другим пользователем."`.
   - Exported `ValidationError = ValidationException` alias.
   - Enhanced `UnauthorizedUserException` and `UserDeactivatedException` with user-friendly Russian messages.
2. `src/common/enums/index.ts`
   - Re-exported Prisma enums (`SystemRole`, `ChannelRole`, `PostStatus`, `MediaType`, `ReviewAction`, `PublicationJobStatus`) to guarantee nominal type identity across Prisma and NestJS services.
   - Added `ChannelPermission`, `SystemPermission`, and `AuditAction` enums.

### Audit Module (`src/modules/audit/`)
3. `src/modules/audit/audit-payload.sanitizer.ts`: Deep recursive payload sanitizer masking tokens, database URLs, and passwords.
4. `src/modules/audit/dto/create-audit-log.dto.ts`: Input DTO for audit log entries.
5. `src/modules/audit/audit.service.ts`: Append-only service with transaction client support.
6. `src/modules/audit/audit.module.ts`: NestJS module registering and exporting `AuditService`.
7. `src/modules/audit/index.ts`: Module exports.

### Notifications Module (`src/modules/notifications/`)
8. `src/modules/notifications/events/domain-events.ts`: Domain event classes (`PostSubmittedEvent`, `PostApprovedEvent`, etc.).
9. `src/modules/notifications/domain-event.bus.ts`: RxJS-based typed event stream.
10. `src/modules/notifications/notification.service.ts`: Event listener with non-blocking alert dispatch and notification logging.
11. `src/modules/notifications/notification.module.ts`: NestJS module exporting `NotificationService` and `DomainEventBus`.
12. `src/modules/notifications/index.ts`: Module exports.

### Users Module (`src/modules/users/`)
13. `src/modules/users/dto/create-user.dto.ts` & `update-user.dto.ts`: User input DTOs.
14. `src/modules/users/users.repository.ts`: Data access layer for User entity with channel members.
15. `src/modules/users/users.service.ts`: User lifecycle management with audit logging and BigInt conversion.
16. `src/modules/users/users.module.ts`: NestJS module exporting `UsersService` and `UsersRepository`.
17. `src/modules/users/index.ts`: Module exports.

### Auth & RBAC Module (`src/modules/auth/`)
18. `src/modules/auth/interfaces/auth-user.interface.ts`: `AuthUser` and `AuthChannelMembership` interfaces.
19. `src/modules/auth/permission.service.ts`: RBAC engine with `SUPER_ADMIN` system bypass, channel permission matrix, and post edit ownership rules.
20. `src/modules/auth/auth.service.ts`: Authentication by Telegram ID, active user validation, Russian rejection handling.
21. `src/modules/auth/auth.guard.ts` & `role.guard.ts`: NestJS guards for HTTP transport boundary.
22. `src/modules/auth/auth.module.ts`: NestJS module exporting auth and permission services.
23. `src/modules/auth/index.ts`: Module exports.

### Channels Module (`src/modules/channels/`)
24. `src/modules/channels/utils/timezone.util.ts`: Luxon-based parser and validator for channel timezones (Europe/Kyiv to UTC), past date rejection, and formatting.
25. `src/modules/channels/dto/create-channel.dto.ts` & `update-channel.dto.ts`: Channel DTOs.
26. `src/modules/channels/channels.service.ts`: Multi-channel management, `autoSkipSingleChannel` helper, date parsing and formatting.
27. `src/modules/channels/channels.module.ts`: NestJS module exporting `ChannelsService`.
28. `src/modules/channels/index.ts`: Module exports.

### Reviews Module (`src/modules/reviews/`)
29. `src/modules/reviews/dto/create-review.dto.ts`: Review input DTO.
30. `src/modules/reviews/reviews.service.ts`: Review management with mandatory non-empty comment on `REQUEST_REVISION`.
31. `src/modules/reviews/reviews.module.ts`: NestJS module exporting `ReviewsService`.
32. `src/modules/reviews/index.ts`: Module exports.

### Posts Module (`src/modules/posts/`)
33. `src/modules/posts/dto/create-draft.dto.ts` & `transition-post.dto.ts`: Post command DTOs.
34. `src/modules/posts/posts.repository.ts`: OCC update mechanism (`updateWithOcc`), soft-delete filter, and draft creation.
35. `src/modules/posts/post-workflow.service.ts`: 10-status post state machine with transition matrix, atomic database transaction (`prisma.$transaction`), and post-commit event publishing.
36. `src/modules/posts/posts.service.ts`: Draft creation, autosave with silent notification rule, media attachment, and soft deletion.
37. `src/modules/posts/posts.module.ts`: NestJS module exporting repository and services.
38. `src/modules/posts/index.ts`: Module exports.

### Application Wiring
39. `src/app.module.ts`: Registered `AuditModule`, `NotificationsModule`, `UsersModule`, `AuthModule`, `ChannelsModule`, `ReviewsModule`, `PostsModule`.

### Unit Tests (`tests/unit/`)
40. `tests/unit/auth.spec.ts`: 10 unit tests for authentication, BigInt parsing, deactivation, and user lifecycle.
41. `tests/unit/permissions.spec.ts`: 11 unit tests for RBAC, SUPER_ADMIN bypass, channel flags, and post edit ownership rules.
42. `tests/unit/channels-timezone.spec.ts`: 9 unit tests for Luxon timezone parsing, past-date rejection, and `autoSkipSingleChannel`.
43. `tests/unit/occ-state-machine.spec.ts`: 9 unit tests for OCC concurrency checks, 10-status state machine transitions, and silent autosave.
44. `tests/unit/audit-reviews.spec.ts`: 11 unit tests for append-only audit logging, payload sanitization, and mandatory review comments.

---

## 3. Verification Commands & Results

1. **Build Verification**:
   ```bash
   npm run build
   ```
   *Result*: Exited with code 0.
   ```bash
   npx tsc --project tsconfig.build.json --noEmit
   ```
   *Result*: Exited with code 0, 0 errors.

2. **Unit Test Verification**:
   ```bash
   npm test
   ```
   *Result*: 8 passed test suites, 111 passed tests, 0 failed.

3. **End-to-End Test Verification**:
   ```bash
   npm run test:e2e
   ```
   *Result*: 34 passed tests across all 4 tiers (Tier 1-4), 0 failed.
