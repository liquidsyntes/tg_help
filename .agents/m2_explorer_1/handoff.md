# Milestone 2 Handoff: Auth, Users, Channels, and RBAC

**Agent**: `m2_explorer_1` (Teamwork Explorer)  
**Task**: Milestone 2 Investigation & Architectural Design  
**Date**: 2026-09-21  

---

## 1. Observation

1. **Database Schema & Models** (`prisma/schema.prisma`):
   - Model `User` (`lines 64-82`): `telegramId BigInt @unique @map("telegram_id")`, `systemRole SystemRole @default(USER)`, `isActive Boolean @default(true)`.
   - Model `Channel` (`lines 85-101`): `telegramChatId String @unique`, `title String`, `timezone String @default("Europe/Kyiv")`, `publicationMode String @default("DIRECT")`, `isActive Boolean @default(true)`.
   - Model `ChannelMember` (`lines 104-121`): `role ChannelRole @default(AUTHOR)`, `canPublish Boolean @default(false)`, `canApprove Boolean @default(false)`, `@@unique([channelId, userId])`.
   - Enums: `SystemRole` (`SUPER_ADMIN`, `USER`), `ChannelRole` (`EDITOR`, `AUTHOR`, `VIEWER`).

2. **BigInt Handling** (`src/infrastructure/database/prisma.service.ts`):
   - Lines 9-18:
     ```ts
     if (!('toJSON' in BigInt.prototype)) {
       Object.defineProperty(BigInt.prototype, 'toJSON', {
         value: function () {
           return this.toString();
         },
         configurable: true,
         writable: true,
       });
     }
     ```
     `BigInt` serialization polyfill is already in place.

3. **Domain Requirements & Specifications**:
   - `tasks.md` § 4, § 5, § 7:
     - Authentication by Telegram ID; unknown user receives message: *"У вас пока нет доступа к редакции. Обратитесь к администратору."*
     - Global role `users.system_role` (`SUPER_ADMIN`, `USER`) + channel rights in `channel_members` (`role`, `can_publish`, `can_approve`).
   - `tasks.md` § 9 (Wizard Step 1):
     - *"Шаг 1: Выбор канала. Если доступен только один канал — шаг пропускается."* (`autoSkipSingleChannel` requirement F-05).
   - `tasks.md` § 19, `AGENTS.md` § 24, § 47:
     - User enters datetime in channel timezone (e.g. `'21.09.2026 18:30'` in `Europe/Kyiv`).
     - Must be converted to UTC `TIMESTAMPTZ` before scheduling.
     - Scheduled dates in the past must be rejected: *"Нельзя планировать публикацию в прошлом."*

4. **Installed Dependencies** (`package.json`):
   - Lines 42-45: `luxon` (`^3.5.0`) and `@types/luxon` (`^3.4.2`) are installed and ready for timezone operations.

5. **Test Harness & Existing Test Invariants**:
   - `tests/fixtures/test-data.ts`: Defines `TEST_USERS` (`superAdmin`, `editor`, `author`, `deactivatedUser`, `unauthorizedUser`), `TEST_CHANNELS` (`production`, `staging`, `archived`).
   - `tests/harness/test-harness.ts`: Lines 228-271 implement `resolveUser`, `authenticate`, and `checkPermission`.
   - `tests/e2e/tier1-feature-coverage.spec.ts`: Lines 35-91 verify authentication rejection of unregistered Telegram IDs (`UnauthorizedUserException`), rejection of deactivated users (`UserDeactivatedException`), and author/editor permission resolution.
   - `tests/e2e/tier2-boundary-cases.spec.ts`: Lines 84-109 verify rejection of past scheduling dates.
   - `tests/e2e/tier4-application-scenarios.spec.ts`: Lines 180-230 verify prevention of author self-approving or publishing without permissions.
   - Command `npm test`: Exited with code 0 (61 passed).
   - Command `npm run test:e2e`: Exited with code 0 (34 passed).

---

## 2. Logic Chain

1. **Authentication Logic**:
   - From Observation 1 and 3, authentication must rely exclusively on `telegramId` (`BigInt`).
   - Querying `User` with `telegramId`:
     - If user record does not exist $\rightarrow$ throw `UnauthorizedUserException` (Observation 5).
     - If user record exists but `isActive === false` $\rightarrow$ throw `UserDeactivatedException` (Observation 5).
     - If user record exists and `isActive === true` $\rightarrow$ return clean `AuthUser` domain object.

2. **RBAC Logic & Super Admin Bypass**:
   - From Observation 1, 3, and 5:
     - If `user.isActive === false` $\rightarrow$ deny all actions (`false`).
     - If `user.systemRole === 'SUPER_ADMIN'` $\rightarrow$ allow all actions (`true`), bypassing channel restrictions.
     - For regular `USER`:
       - Verify target channel exists and `channel.isActive === true`. Inactive channels cannot be published to or edited.
       - Verify `ChannelMember` exists for `(userId, channelId)`.
       - For `APPROVE_POST`, `REJECT_POST`, `REQUEST_REVISION`: requires `member.role === 'EDITOR'` and `member.canApprove === true`.
       - For `PUBLISH_POST`: requires `(member.role === 'EDITOR' || member.role === 'AUTHOR')` and `member.canPublish === true`.
       - For `CREATE_POST`, `SUBMIT_REVIEW`: requires `member.role === 'EDITOR' || member.role === 'AUTHOR'`.
       - For `EDIT_POST`: Authors can only edit their own posts (`post.authorId === actorId`) in `DRAFT` or `NEEDS_REVISION`; Editors can edit any post in their channel.

3. **Channels & Wizard Auto-Skip Logic**:
   - From Observation 1 and 3:
     - `getUserAuthorizedChannels(userId)` resolves all active channels the user has permission to post in (for `SUPER_ADMIN`, all active channels; for regular users, channels where `ChannelMember` exists).
     - If `channels.length === 1`, `autoSkipSingleChannel` returns `{ singleChannel: channels[0], channels, mustChoose: false }`, allowing the wizard to jump directly to Step 2.
     - If `channels.length > 1`, user must select from inline buttons (`mustChoose: true`).

4. **Timezone & Scheduling Invariant Logic**:
   - From Observation 3 and 4:
     - User inputs string `dd.MM.yyyy HH:mm` in channel timezone (e.g., `Europe/Kyiv`).
     - `luxon` parses input with zone `channel.timezone`.
     - Output is converted to UTC `Date`.
     - Preflight invariant check: `date.getTime() <= Date.now()` $\rightarrow$ throw `ValidationException('Нельзя планировать публикацию в прошлом.')`.

---

## 3. Caveats

1. **State Machine & OCC Integration**:
   - Milestone 2 also encompasses post status transitions (`PostWorkflowService`) and Optimistic Concurrency Control (`version` column). While this report focuses on Auth, Users, Channels, and RBAC, `PermissionService` has been designed with explicit hooks (`canEditPost`, `enforceChannelPermission`) to seamlessly plug into `PostWorkflowService`.
2. **GrammY Bot Middleware**:
   - The bot transport layer itself belongs to Milestone 5, but `AuthService` and `AuthGuard` are architected to be completely decoupled from grammY update types (per AGENTS.md § 3 and § 5). Handlers will extract `ctx.from.id` and pass `BigInt` to `AuthService`.
3. **Database Connectivity**:
   - Unit tests must mock `PrismaService` or use standard NestJS testing utilities (`@nestjs/testing`) to maintain hermetic test isolation without requiring a live PostgreSQL instance during `npm test`.

---

## 4. Conclusion

The architectural design for Milestone 2 (Auth, Users, Channels, and RBAC) is fully formulated, documented in `c:/TgHelp/.agents/m2_explorer_1/report.md`, and completely compatible with existing contracts:
1. `AuthService` validates Telegram ID (`BigInt`), enforces `isActive`, and rejects unauthenticated users with domain exceptions mapped to user-friendly messages.
2. `PermissionService` provides robust dual-tier RBAC (`SUPER_ADMIN` override, channel roles `EDITOR`/`AUTHOR`/`VIEWER`, granular flags `canPublish`/`canApprove`).
3. `ChannelsService` provides multi-channel resolution, wizard `autoSkipSingleChannel` bypass, and `luxon`-based timezone scheduling with past date validation.
4. Complete interfaces, DTOs, and concrete implementation steps are prepared for the Worker.

---

## 5. Verification Method

To independently verify this design and subsequent implementation:

1. **Inspect Design Documentation**:
   - Review `c:/TgHelp/.agents/m2_explorer_1/report.md` for full DTOs, service signatures, and implementation phases.

2. **Run Existing Test Suite**:
   ```bash
   npm test
   npm run test:e2e
   ```
   - Invalidation condition: If any existing test fails or regressions occur, the implementation violates existing contracts.

3. **Verify Worker Unit Test Coverage (post-implementation)**:
   - Run `npm test -- tests/unit/auth.service.spec.ts`
   - Run `npm test -- tests/unit/permission.service.spec.ts`
   - Run `npm test -- tests/unit/channels.service.spec.ts`
   - Invalidation condition: Any failure to reject unknown Telegram IDs, deactivated users, unauthorized actions, or past dates indicates an invariant breach.
