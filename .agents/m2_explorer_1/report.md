# Milestone 2 Design Report: Auth, Users, Channels, and RBAC

**Author**: `m2_explorer_1` (Teamwork Explorer)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 2 (Domain Models, RBAC & State Machine)  
**Scope**: Authentication by Telegram ID, Multi-Tier RBAC, Channel Management, Wizard Auto-Skip, and Timezone-Aware Publication Scheduling.

---

## 1. Executive Summary & Context

Milestone 2 establishes the core security boundary and domain foundations of the Telegram Content Publisher Bot. According to **AGENTS.md** (§ 3, § 5, § 8, § 9, § 24, § 47), **tasks.md** (§ 3, § 4, § 5, § 7, § 19), and **PROJECT.md** (Features F-01, F-02, F-05, F-06):
1. **Telegram is purely a transport layer**: Handlers must not contain authorization or business logic. All authorization decisions are strictly evaluated server-side by application domain services.
2. **Identity**: Authentication is strictly anchored on Telegram ID (`BigInt`). Display names, usernames, and first/last names are mutable and never used for authentication.
3. **Dual-Tier Permission Model**: Permissions consist of global system roles (`SUPER_ADMIN`, `USER`), channel-scoped roles (`EDITOR`, `AUTHOR`, `VIEWER`), and granular channel permission flags (`canPublish`, `canApprove`).
4. **Channel Isolation & Ergonomics**: Channels represent distinct publication targets with their own timezones (default `Europe/Kyiv`). For UX efficiency, if a user has access to exactly one channel, the channel selection step in the post creation wizard is automatically bypassed (`autoSkipSingleChannel`).
5. **Timezone Invariants**: Publication times are entered in the channel's local timezone, converted to UTC `TIMESTAMPTZ`, and strictly validated to prevent scheduling in the past.

---

## 2. AuthService & UsersService Design (`src/modules/auth/`, `src/modules/users/`)

### 2.1 Telegram ID Authentication (`BigInt`)
In PostgreSQL, `users.telegram_id` is defined as `BigInt` with a unique index:
```prisma
model User {
  id         String     @id @default(uuid())
  telegramId BigInt     @unique @map("telegram_id")
  username   String?    @map("username")
  firstName  String?    @map("first_name")
  lastName   String?    @map("last_name")
  systemRole SystemRole @default(USER) @map("system_role")
  isActive   Boolean    @default(true) @map("is_active")
  ...
}
```

#### Serialization & Domain Type Safety
JavaScript/Node.js does not serialize `BigInt` into JSON by default. `PrismaService` already provides a global `BigInt.prototype.toJSON` polyfill (`src/infrastructure/database/prisma.service.ts`: lines 10-18). However, for application code:
- Define explicit domain type: `export type TelegramUserId = bigint;`
- Create utility `toBigIntTelegramId(val: bigint | number | string): bigint` to parse incoming IDs from grammY context (`ctx.from.id`).

### 2.2 Authentication Flow & Error Semantics
The authentication flow follows a 2-tier resolution pattern:
1. `resolveUser(telegramId: bigint): Promise<AuthUser | null>`:
   - Queries Prisma: `prisma.user.findUnique({ where: { telegramId }, include: { channelMembers: { include: { channel: true } } } })`.
   - If not found: returns `null`.
   - If found and `isActive === false`: throws `UserDeactivatedException(telegramId)`.
   - If found and `isActive === true`: maps Prisma user to clean `AuthUser` interface.
2. `authenticate(telegramId: bigint): Promise<AuthUser>`:
   - Calls `resolveUser(telegramId)`.
   - If `null`: throws `UnauthorizedUserException(telegramId)`.
   - Returns authenticated `AuthUser`.

### 2.3 User Rejection & Transport Mapping
When an incoming update arrives at the Telegram transport layer:
- **Unregistered user** (`UnauthorizedUserException`):
  Reject immediately. Reply with Russian UI message specified in **tasks.md** § 7:
  > *"У вас пока нет доступа к редакции. Обратитесь к администратору."*
- **Deactivated user** (`UserDeactivatedException`):
  Reject immediately. Reply:
  > *"Ваш аккаунт деактивирован. Обратитесь к администратору."*
- **Protected Callbacks**:
  Inline keyboard callbacks verify the actor's session via `AuthGuard` or `authenticate(telegramId)`. If unauthorized, answer callback query with alert: *"Доступ запрещен."*

### 2.4 UsersService Operations
`UsersService` (`src/modules/users/users.service.ts`) provides user lifecycle management:
- `findById(id: string): Promise<User | null>`
- `findByTelegramId(telegramId: bigint): Promise<User | null>`
- `createUser(dto: CreateUserDto, actorId?: string): Promise<User>`
- `updateUser(id: string, dto: UpdateUserDto, actorId?: string): Promise<User>`
- `deactivateUser(id: string, actorId: string): Promise<User>` (sets `isActive: false`, logs audit event `user_deactivated`)
- `reactivateUser(id: string, actorId: string): Promise<User>` (sets `isActive: true`, logs audit event `user_reactivated`)
- `listUsers(query: PaginationQueryDto): Promise<PaginatedResult<User>>`

---

## 3. RBAC & PermissionService Design (`src/modules/auth/permissions/`)

### 3.1 Role Hierarchy & Granular Flags
The system implements a hybrid System-Role / Channel-Role permission model:

| Role Category | Enums | Description |
|---|---|---|
| **System Role** | `SUPER_ADMIN`<br>`USER` | System-wide scope. `SUPER_ADMIN` has absolute administrative override. |
| **Channel Role** | `EDITOR`<br>`AUTHOR`<br>`VIEWER` | Channel-scoped role assigned in `channel_members`. |
| **Granular Flags** | `canPublish`<br>`canApprove` | Channel-level flags defining fine-grained capabilities. |

### 3.2 Channel Permissions Enum
```ts
export enum ChannelPermission {
  CREATE_POST = 'CREATE_POST',
  EDIT_POST = 'EDIT_POST',
  SUBMIT_REVIEW = 'SUBMIT_REVIEW',
  APPROVE_POST = 'APPROVE_POST',
  REJECT_POST = 'REJECT_POST',
  REQUEST_REVISION = 'REQUEST_REVISION',
  PUBLISH_POST = 'PUBLISH_POST',
  SCHEDULE_POST = 'SCHEDULE_POST',
  CANCEL_SCHEDULE = 'CANCEL_SCHEDULE',
  DELETE_POST = 'DELETE_POST',
  VIEW_POST = 'VIEW_POST',
}

export enum SystemPermission {
  MANAGE_USERS = 'MANAGE_USERS',
  MANAGE_CHANNELS = 'MANAGE_CHANNELS',
  MANAGE_TEMPLATES = 'MANAGE_TEMPLATES',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
}
```

### 3.3 RBAC Evaluation Logic & SUPER_ADMIN Bypass
The permission evaluation flow in `PermissionService.checkPermission` follows strict priority order:

```text
1. Actor Active Check:
   Is actor active in DB?
   NO  ──> Return FALSE (or throw UserDeactivatedException)
   YES ──> Continue

2. System Role Check (SUPER_ADMIN Bypass):
   Is actor systemRole === 'SUPER_ADMIN'?
   YES ──> Return TRUE (bypasses all channel checks)
   NO  ──> Continue

3. Channel Active Check:
   Does channel exist and is channel.isActive === true?
   NO  ──> Return FALSE (inactive channel cannot be operated on)
   YES ──> Continue

4. Channel Membership Check:
   Does ChannelMember exist for (channelId, actorId)?
   NO  ──> Return FALSE (no access to channel)
   YES ──> Continue

5. Granular Action Evaluation:
   Evaluate member.role, canPublish, canApprove against requested permission.
```

### 3.4 Action Permission Matrix

| Permission | Required Channel Role | Required Flags | Notes / Conditions |
|---|---|---|---|
| `CREATE_POST` | `EDITOR` or `AUTHOR` | none | Allowed to create drafts in channel. |
| `SUBMIT_REVIEW`| `EDITOR` or `AUTHOR` | none | Allowed to transition `DRAFT -> PENDING_REVIEW`. |
| `APPROVE_POST` | `EDITOR` | `canApprove === true` | Author cannot approve (even if own post). |
| `REJECT_POST`  | `EDITOR` | `canApprove === true` | Author cannot reject. |
| `REQUEST_REVISION` | `EDITOR` | `canApprove === true` | Author cannot request revision. Comment mandatory. |
| `PUBLISH_POST` | `EDITOR` or `AUTHOR` | `canPublish === true` | Direct publish / enqueue publication job. |
| `SCHEDULE_POST`| `EDITOR` | `canPublish || canApprove` | Enqueue delayed publication job. |
| `CANCEL_SCHEDULE`| `EDITOR` | `canPublish || canApprove` | Cancel delayed job and update status. |
| `DELETE_POST`  | `EDITOR` or `AUTHOR` | - | Authors can soft-delete their own drafts; Editors can delete any channel draft. |
| `VIEW_POST`    | `EDITOR`, `AUTHOR`, `VIEWER` | none | Authors see own posts; Editors/Viewers see all channel posts. |

### 3.5 Post Ownership & Granular Editing Rule (`canEditPost`)
Editing post fields (`autosaveStep`) has special ownership rules:
1. `SUPER_ADMIN` can edit any post in any channel.
2. `EDITOR` can edit any post in their assigned channel.
3. `AUTHOR` can **only** edit their own post (`post.authorId === actorId`) and **only** while the post is in editable status (`DRAFT` or `NEEDS_REVISION`).
4. Any attempt by another user to edit post fields fails with `PermissionDeniedException`.

---

## 4. ChannelsService Design (`src/modules/channels/`)

### 4.1 Multi-Channel Support
The system supports multiple channels with dedicated settings:
- `telegramChatId`: Telegram channel chat ID (e.g. `-1001987654321`).
- `title`: Channel display name.
- `username`: Telegram channel @username.
- `timezone`: IANA timezone name (default: `Europe/Kyiv`).
- `publicationMode`: Default `DIRECT`.
- `isActive`: Boolean flag for archiving channels.

### 4.2 User Authorized Channels Resolution
`getUserAuthorizedChannels(userId: string): Promise<Channel[]>`:
- If user is `SUPER_ADMIN`: returns all channels where `isActive === true`.
- If user is regular `USER`: returns channels where `isActive === true` and a `ChannelMember` record exists for `(channelId, userId)`.

### 4.3 Wizard Auto-Skip Single Channel Helper (`F-05`)
In the post creation wizard Step 1, the user must select a target channel:
- If the user has access to **multiple channels**, display selection buttons.
- If the user has access to **exactly one channel**, automatically skip Step 1 and proceed to Step 2 (Template selection).
- If the user has access to **zero channels**, reject with error *"У вас нет доступа ни к одному активному каналу."*

Implementation in `ChannelsService`:
```ts
export interface AutoSkipChannelResult {
  singleChannel: Channel | null;
  channels: Channel[];
  mustChoose: boolean;
}

async autoSkipSingleChannel(userId: string): Promise<AutoSkipChannelResult> {
  const channels = await this.getUserAuthorizedChannels(userId);
  if (channels.length === 1) {
    return { singleChannel: channels[0], channels, mustChoose: false };
  }
  return { singleChannel: null, channels, mustChoose: channels.length > 1 };
}
```

### 4.4 Timezone Parsing & Scheduling Conversion (`F-06`)
Per **AGENTS.md** § 24 and § 47, dates are entered by users in the channel's local timezone (e.g. `Europe/Kyiv`), converted to UTC, and stored as PostgreSQL `TIMESTAMPTZ`.

#### Invariants:
1. **Never use local server time** without explicit timezone conversion.
2. **Never allow dates in the past**: `scheduledAt.getTime() <= Date.now()` must be rejected with `ValidationException('Нельзя планировать публикацию в прошлом.')`.
3. **Format Support**:
   - Primary format (per **tasks.md** § 19): `dd.MM.yyyy HH:mm` (e.g. `21.09.2026 18:30`).
   - Secondary formats: `yyyy-MM-dd HH:mm`, ISO-8601 strings.

#### Implementation with `luxon`:
```ts
import { DateTime, IANAZone } from 'luxon';
import { ValidationException } from '../../common/exceptions/domain.exceptions';

export function parseAndValidateScheduledDate(
  input: string,
  channelTimezone = 'Europe/Kyiv',
): Date {
  const trimmed = input.trim();
  const zone = IANAZone.isValidZone(channelTimezone) ? channelTimezone : 'Europe/Kyiv';

  let dt = DateTime.fromFormat(trimmed, 'dd.MM.yyyy HH:mm', { zone });
  if (!dt.isValid) {
    dt = DateTime.fromFormat(trimmed, 'yyyy-MM-dd HH:mm', { zone });
  }
  if (!dt.isValid) {
    dt = DateTime.fromISO(trimmed, { zone });
  }

  if (!dt.isValid) {
    throw new ValidationException(
      `Некорректный формат даты: "${input}". Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ (например: 21.09.2026 18:30)`,
    );
  }

  const date = dt.toJSDate();
  if (date.getTime() <= Date.now()) {
    throw new ValidationException('Нельзя планировать публикацию в прошлом.');
  }

  return date;
}

export function formatChannelDate(date: Date, channelTimezone = 'Europe/Kyiv'): string {
  const zone = IANAZone.isValidZone(channelTimezone) ? channelTimezone : 'Europe/Kyiv';
  return DateTime.fromJSDate(date).setZone(zone).toFormat('dd.MM.yyyy HH:mm');
}
```

---

## 5. Exact Interfaces, DTOs & Domain Contracts

### 5.1 Auth Module Interfaces & DTOs
```ts
// src/modules/auth/interfaces/auth-user.interface.ts
import { SystemRole, ChannelRole } from '@prisma/client';

export interface AuthChannelMembership {
  id: string;
  channelId: string;
  channelTitle: string;
  role: ChannelRole;
  canPublish: boolean;
  canApprove: boolean;
}

export interface AuthUser {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  systemRole: SystemRole;
  isActive: boolean;
  channelMemberships: AuthChannelMembership[];
}
```

```ts
// src/modules/auth/interfaces/auth-service.interface.ts
import { AuthUser } from './auth-user.interface';

export interface IAuthService {
  resolveUser(telegramId: bigint): Promise<AuthUser | null>;
  authenticate(telegramId: bigint): Promise<AuthUser>;
  validateActive(user: AuthUser): void;
}
```

### 5.2 Permission Module Interfaces
```ts
// src/modules/auth/permissions/permission.service.interface.ts
import { ChannelPermission, SystemPermission } from './permission.enum';
import { PostStatus } from '@prisma/client';

export interface IPermissionService {
  checkChannelPermission(actorId: string, channelId: string, permission: ChannelPermission): Promise<boolean>;
  enforceChannelPermission(actorId: string, channelId: string, permission: ChannelPermission): Promise<void>;
  
  checkPostEditPermission(actorId: string, post: { authorId: string; channelId: string; status: PostStatus }): Promise<boolean>;
  enforcePostEditPermission(actorId: string, post: { authorId: string; channelId: string; status: PostStatus }): Promise<void>;
  
  checkSystemPermission(actorId: string, permission: SystemPermission): Promise<boolean>;
  enforceSystemPermission(actorId: string, permission: SystemPermission): Promise<void>;
}
```

### 5.3 Channels Module DTOs & Interfaces
```ts
// src/modules/channels/dto/create-channel.dto.ts
import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class CreateChannelDto {
  @IsString()
  @IsNotEmpty()
  telegramChatId: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  @IsOptional()
  timezone?: string = 'Europe/Kyiv';

  @IsString()
  @IsOptional()
  publicationMode?: string = 'DIRECT';
}
```

```ts
// src/modules/channels/interfaces/channels-service.interface.ts
import { Channel, ChannelMember, ChannelRole } from '@prisma/client';
import { CreateChannelDto } from '../dto/create-channel.dto';

export interface AutoSkipResult {
  singleChannel: Channel | null;
  channels: Channel[];
  mustChoose: boolean;
}

export interface IChannelsService {
  getById(id: string): Promise<Channel>;
  getByChatId(telegramChatId: string): Promise<Channel>;
  getUserAuthorizedChannels(userId: string): Promise<Channel[]>;
  autoSkipSingleChannel(userId: string): Promise<AutoSkipResult>;
  createChannel(dto: CreateChannelDto, actorId: string): Promise<Channel>;
  parseAndValidateDate(input: string, channelId: string): Promise<Date>;
  formatDate(date: Date, channelId: string): Promise<string>;
}
```

---

## 6. Implementation Plan for Worker

The Worker should follow this strict step-by-step sequence:

### Phase 1: Shared Domain Utilities & Exceptions Compatibility
1. **Exceptions Check** (`src/common/exceptions/domain.exceptions.ts`):
   - Export alias `export { ValidationException as ValidationError };` to maintain compatibility with tests.
   - Verify `UnauthorizedUserException`, `UserDeactivatedException`, `PermissionDeniedException`, `ChannelNotFoundException`.

### Phase 2: Users Module (`src/modules/users/`)
1. Create `src/modules/users/dto/`:
   - `create-user.dto.ts`
   - `update-user.dto.ts`
2. Create `src/modules/users/users.service.ts`:
   - Implement `findById`, `findByTelegramId`, `createUser`, `updateUser`, `deactivateUser`, `reactivateUser`, `listUsers`.
3. Create `src/modules/users/users.module.ts`.

### Phase 3: Auth & RBAC Module (`src/modules/auth/`)
1. Create `src/modules/auth/permissions/permission.enum.ts`:
   - Define `ChannelPermission` and `SystemPermission`.
2. Create `src/modules/auth/interfaces/`:
   - `auth-user.interface.ts`
   - `auth-service.interface.ts`
3. Create `src/modules/auth/permissions/permission.service.ts`:
   - Implement active checks, `SUPER_ADMIN` bypass, channel membership evaluation, post ownership rules.
4. Create `src/modules/auth/auth.service.ts`:
   - Implement `resolveUser(telegramId: bigint)` and `authenticate(telegramId: bigint)`.
5. Create `src/modules/auth/auth.guard.ts` (transport-agnostic authentication guard).
6. Create `src/modules/auth/auth.module.ts`.

### Phase 4: Channels Module (`src/modules/channels/`)
1. Create `src/modules/channels/dto/`:
   - `create-channel.dto.ts`
   - `update-channel.dto.ts`
   - `channel-member.dto.ts`
2. Create `src/modules/channels/utils/timezone.util.ts`:
   - Implement `parseAndValidateScheduledDate` and `formatChannelDate` using `luxon`.
3. Create `src/modules/channels/channels.service.ts`:
   - Implement `getUserAuthorizedChannels`, `autoSkipSingleChannel`, `parseAndValidateDate`, channel CRUD.
4. Create `src/modules/channels/channel-members.service.ts`:
   - Implement member addition, role updates, permission flag toggles.
5. Create `src/modules/channels/channels.module.ts`.

### Phase 5: Audit Log Module (`src/modules/audit/`)
1. Create `src/modules/audit/audit-log.service.ts`:
   - Persist append-only audit records to PostgreSQL (`prisma.auditLog.create`).
2. Create `src/modules/audit/audit.module.ts`.

### Phase 6: App Wiring & Comprehensive Testing
1. Register `UsersModule`, `AuthModule`, `ChannelsModule`, `AuditModule` in `src/app.module.ts`.
2. Write targeted unit tests in `tests/unit/`:
   - `auth.service.spec.ts`: test Telegram ID `BigInt` auth, unknown ID rejection, deactivated user rejection.
   - `permission.service.spec.ts`: test `SUPER_ADMIN` bypass, channel role permissions (`canPublish`, `canApprove`), inactive channel denial, post ownership rules.
   - `channels.service.spec.ts`: test `autoSkipSingleChannel` (1 channel vs multiple vs 0), timezone parsing from `Europe/Kyiv` to UTC, past date rejection.
3. Run verification commands:
   - `npm test` (all unit tests must pass)
   - `npm run test:e2e` (all 34 e2e tests must continue to pass 100%)
