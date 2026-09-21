# Telegram Content Publisher Bot MVP — Architectural & Technical Specification Report

**Author**: `spec_miner_2` (Specification Miner)  
**Date**: 2026-09-21  
**Authoritative Sources**: `AGENTS.md`, `tasks.md`, `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`

---

## 1. Executive Summary

This report establishes the authoritative architectural constraints, domain patterns, database schemas, queue processing rules, concurrency controls, and validation requirements for the Telegram Content Publisher Bot MVP.

The system is designed as an editorial publishing desk running directly inside Telegram. Its architecture strictly separates the Telegram transport layer from core business logic, relying on **PostgreSQL (via Prisma)** as the durable source of truth, **Redis and BullMQ** for resilient asynchronous job scheduling and publication, and **Optimistic Concurrency Control (OCC)** to eliminate race conditions and conflicting edits.

---

## 2. Architectural Layers & Dependency Direction

### 2.1 The Core Principle: Telegram as a Transport Layer
Per **AGENTS.md § 3**: *"Telegram is a transport layer. Telegram handlers must NOT contain core business logic."*

- **Strict Dependency Direction (AGENTS.md § 5)**:
  $$\text{Transport (grammY)} \longrightarrow \text{Application (Services/Commands)} \longrightarrow \text{Domain (Rules/Entities)} \longrightarrow \text{Infrastructure Interfaces} \longrightarrow \text{Concrete Infrastructure (Prisma, Redis, BullMQ)}$$
- **Forbidden Antipattern**: Handlers directly calling Prisma, mutating database state, invoking Telegram Bot API publication methods, or querying Redis directly (`Telegram Handler -> Prisma -> Telegram API -> Redis`).
- **Handler Scope**:
  - Parse and normalize Telegram updates (messages, callback queries, media uploads).
  - Perform boundary input validation and shape assertions.
  - Identify and extract the actor's stable identity (`TelegramUserId = bigint`).
  - Convert transport types into domain command objects (e.g., `ApprovePostCommand`, `AutosaveStepCommand`). Handlers must never pass `ctx: Context` into application or domain services.
  - Invoke application/domain services.
  - Render user feedback and map domain/application exceptions into clear, localized user-facing responses.

### 2.2 Module Boundaries & Directory Layout
Per **AGENTS.md § 4** and **tasks.md § 28**, the NestJS project structure is partitioned to prevent god services:

```text
src/
  modules/
    auth/           # Telegram ID resolution, active checks, session authentication
    users/          # User lifecycle, role management, user queries
    channels/       # Channel registration, chat ID mapping, timezone config, channel members
    posts/          # Post domain entity, lifecycle management, versioning, wizard state
    templates/      # Template registry, schema validation, field configurations
    media/          # Media attachment metadata, Telegram file_id mapping, media groups
    reviews/        # Editorial review workflow, revision notes, approval decisions
    publishing/     # Publication job coordination, preflight verification, worker execution
    scheduling/     # Timezone conversion (Europe/Kyiv to UTC), delayed job dispatch
    notifications/  # Asynchronous Telegram notification dispatch (side-effects)
    audit/          # Append-only audit logging for all significant state changes
    telegram/       # Transport layer: grammY bot setup, handlers, callback routers, UI keyboards
    admin/          # System-level management commands and configuration

  infrastructure/
    database/       # PrismaService, transaction managers, database repositories
    redis/          # Redis connection provider, locking utilities
    queues/         # BullMQ queue definitions, job producer services, worker consumers
    logger/         # Structured JSON logger with request/post/user correlation
    config/         # Environment variable loading, schema validation at startup
    telegram-api/   # Abstracted Telegram API clients (TelegramPublisher, TelegramMediaService)

  common/
    guards/         # Permission guards, channel-membership guards
    decorators/     # CurrentUser, Roles, Transactional decorators
    enums/          # PostStatus, Role, MediaCategory, AuditAction enums
    dto/            # Strongly-typed input DTOs, command shapes
    utils/          # Timezone helpers, HTML escaping, string truncators
    exceptions/     # DomainException hierarchy (Conflict, Forbidden, NotFound, ValidationError)
    constants/      # telegram-limits.ts, queue-names.ts
```

### 2.3 Process Separation
Per **AGENTS.md § 65** and **tasks.md § 32**:
- The main **Web/Bot Process (`app`)** and the **Publication Worker Process (`worker`)** must be logically and physically separable.
- The `app` process receives updates (via webhook in production or polling in development), handles user interaction, autosaves drafts to PostgreSQL, and enqueues publication jobs to BullMQ.
- The `worker` process processes BullMQ publication queues, executes Telegram publishing API calls, manages retry backoff, records results, and emits notification events.
- Crash resilience: If the `app` process terminates or restarts, scheduled and enqueued publications must continue to execute without disruption via the independent `worker`.

---

## 3. Technology Stack Requirements

Per **AGENTS.md § 1, 6, 29, 36, 67** and **tasks.md § 27**:

1. **Node.js 22+**: Core server execution environment using modern LTS features.
2. **TypeScript (Strict Mode)**:
   - Zero tolerance for `any` unless an external untyped library boundary requires it (documented explicitly).
   - Use `unknown` at untrusted boundaries followed by runtime validation (Zod / class-validator).
   - No unsafe casts (`value as SomeType`) without prior type-guard verification.
   - Branded/explicit domain types for IDs: `type TelegramUserId = bigint;`, `type PostId = string;`, `type ChannelId = string;`.
   - Discriminated unions for multi-state workflows and heterogeneous message payloads.
3. **NestJS**: Modular application architecture, dependency injection, lifecycle management, and clean separation between transport and service providers.
4. **grammY**: High-performance Telegram Bot framework utilized exclusively inside `src/modules/telegram` as transport adapters.
5. **PostgreSQL & Prisma**:
   - PostgreSQL as the sole source of truth for persistent data.
   - Strict migration discipline via `prisma migrate` — zero manual DB alterations in production.
6. **Redis & BullMQ**:
   - Redis for BullMQ queue state, short-lived locks, and distributed rate limiting.
   - BullMQ for queued publishing, delayed scheduled jobs, and exponential backoff retries.
7. **Docker & Docker Compose**:
   - `docker-compose.yml` defining services: `app`, `worker`, `postgres`, `redis`.
   - Must execute cleanly across development, staging, and production environments without OS-specific path dependencies.
8. **Startup Configuration Validation (AGENTS.md § 35)**:
   - Application must fail fast at startup if mandatory environment variables (`BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `DEFAULT_TIMEZONE`) are missing or malformed.

---

## 4. Database Design & Single Source of Truth

Per **AGENTS.md § 8, 9, 11, 28, 29, 30, 31, 61, 63** and **tasks.md § 3, 4, 5, 25, 26**:

Critical application state must never reside solely in volatile memory or Redis. The database must enforce data invariants via primary keys, unique constraints, foreign keys, and indexes.

### 4.1 Schema Specification

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum SystemRole {
  SUPER_ADMIN
  USER
}

enum ChannelRole {
  EDITOR
  AUTHOR
  VIEWER
}

enum PostStatus {
  DRAFT
  PENDING_REVIEW
  NEEDS_REVISION
  APPROVED
  SCHEDULED
  PUBLISHING
  PUBLISHED
  REJECTED
  CANCELLED
  PUBLISH_FAILED
}

enum MediaType {
  PHOTO
  VIDEO
  DOCUMENT
  ANIMATION
}

enum ReviewAction {
  APPROVE
  REQUEST_REVISION
  REJECT
}

enum PublicationJobStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}

model User {
  id              String          @id @default(uuid())
  telegramId      BigInt          @unique @map("telegram_id")
  username        String?         @map("username")
  firstName       String?         @map("first_name")
  lastName        String?         @map("last_name")
  systemRole      SystemRole      @default(USER) @map("system_role")
  isActive        Boolean         @default(true) @map("is_active")
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  channelMembers  ChannelMember[]
  authoredPosts   Post[]          @relation("PostAuthor")
  reviews         PostReview[]    @relation("Reviewer")
  postVersions    PostVersion[]   @relation("VersionAuthor")
  auditLogs       AuditLog[]      @relation("AuditActor")

  @@map("users")
}

model Channel {
  id              String          @id @default(uuid())
  telegramChatId  BigInt          @unique @map("telegram_chat_id")
  title           String          @map("title")
  username        String?         @map("username")
  timezone        String          @default("Europe/Kyiv") @map("timezone")
  publicationMode String          @default("queue") @map("publication_mode")
  isActive        Boolean         @default(true) @map("is_active")
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  members         ChannelMember[]
  posts           Post[]

  @@map("channels")
}

model ChannelMember {
  id          String      @id @default(uuid())
  userId      String      @map("user_id")
  channelId   String      @map("channel_id")
  role        ChannelRole @default(AUTHOR) @map("role")
  canPublish  Boolean     @default(false) @map("can_publish")
  canApprove  Boolean     @default(false) @map("can_approve")
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime    @updatedAt @map("updated_at") @db.Timestamptz

  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel     Channel     @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([userId, channelId])
  @@index([userId])
  @@index([channelId])
  @@map("channel_members")
}

model PostTemplate {
  id                  String      @id @default(uuid())
  key                 String      @unique @map("key")
  name                String      @map("name")
  description         String?     @map("description")
  schemaJson          Json        @map("schema_json")
  renderConfig        Json        @map("render_config")
  supportedMediaTypes String[]    @map("supported_media_types")
  version             Int         @default(1) @map("version")
  isActive            Boolean     @default(true) @map("is_active")
  createdAt           DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime    @updatedAt @map("updated_at") @db.Timestamptz

  posts               Post[]

  @@map("post_templates")
}

model Post {
  id              String           @id @default(uuid())
  channelId       String           @map("channel_id")
  authorId        String           @map("author_id")
  templateId      String?          @map("template_id")
  templateVersion Int              @default(1) @map("template_version")
  status          PostStatus       @default(DRAFT) @map("status")
  contentJson     Json             @default("{}") @map("content_json")
  version         Int              @default(1) @map("version")
  scheduledAt     DateTime?        @map("scheduled_at") @db.Timestamptz
  publishedAt     DateTime?        @map("published_at") @db.Timestamptz
  deletedAt       DateTime?        @map("deleted_at") @db.Timestamptz
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime         @updatedAt @map("updated_at") @db.Timestamptz

  channel         Channel          @relation(fields: [channelId], references: [id], onDelete: Restrict)
  author          User             @relation("PostAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  template        PostTemplate?    @relation(fields: [templateId], references: [id], onDelete: SetNull)
  media           PostMedia[]
  reviews         PostReview[]
  versions        PostVersion[]
  publicationJobs PublicationJob[]

  @@index([status])
  @@index([authorId])
  @@index([channelId])
  @@index([scheduledAt])
  @@map("posts")
}

model PostMedia {
  id                   String     @id @default(uuid())
  postId               String     @map("post_id")
  telegramFileId       String     @map("telegram_file_id")
  telegramFileUniqueId String     @map("telegram_file_unique_id")
  mediaType            MediaType  @map("media_type")
  fileName             String?    @map("file_name")
  mimeType             String?    @map("mime_type")
  fileSize             Int?       @map("file_size")
  caption              String?    @map("caption")
  sortOrder            Int        @default(0) @map("sort_order")
  createdAt            DateTime   @default(now()) @map("created_at") @db.Timestamptz

  post                 Post       @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId])
  @@map("post_media")
}

model PostReview {
  id         String       @id @default(uuid())
  postId     String       @map("post_id")
  reviewerId String       @map("reviewer_id")
  action     ReviewAction @map("action")
  comment    String?      @map("comment")
  createdAt  DateTime     @default(now()) @map("created_at") @db.Timestamptz

  post       Post         @relation(fields: [postId], references: [id], onDelete: Cascade)
  reviewer   User         @relation("Reviewer", fields: [reviewerId], references: [id], onDelete: Restrict)

  @@index([postId])
  @@map("post_reviews")
}

model PostVersion {
  id           String     @id @default(uuid())
  postId       String     @map("post_id")
  version      Int        @map("version")
  contentJson  Json       @map("content_json")
  renderedText String?    @map("rendered_text")
  changedById  String     @map("changed_by")
  createdAt    DateTime   @default(now()) @map("created_at") @db.Timestamptz

  post         Post       @relation(fields: [postId], references: [id], onDelete: Cascade)
  changedBy    User       @relation("VersionAuthor", fields: [changedById], references: [id], onDelete: Restrict)

  @@unique([postId, version])
  @@index([postId])
  @@map("post_versions")
}

model PublicationJob {
  id                 String               @id @default(uuid())
  postId             String               @map("post_id")
  postVersion        Int                  @map("post_version")
  idempotencyKey     String               @unique @map("idempotency_key")
  status             PublicationJobStatus @default(PENDING) @map("status")
  scheduledFor       DateTime?            @map("scheduled_for") @db.Timestamptz
  attempts           Int                  @default(0) @map("attempts")
  lastError          String?              @map("last_error")
  telegramMessageIds Json                 @default("[]") @map("telegram_message_ids")
  createdAt          DateTime             @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime             @updatedAt @map("updated_at") @db.Timestamptz

  post               Post                 @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([status])
  @@index([scheduledFor])
  @@index([idempotencyKey])
  @@map("publication_jobs")
}

model AuditLog {
  id         String     @id @default(uuid())
  action     String     @map("action")
  entityType String     @map("entity_type")
  entityId   String     @map("entity_id")
  actorId    String?    @map("actor_id")
  metadata   Json       @default("{}") @map("metadata")
  createdAt  DateTime   @default(now()) @map("created_at") @db.Timestamptz

  actor      User?      @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)

  @@index([entityId])
  @@index([entityType, entityId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### 4.2 Permission Hierarchy & Identity Rules
- **Authorization Identity (AGENTS.md § 8)**: Must strictly use `User.telegramId` (`BigInt`). Username, first name, last name, and display names are transient and never trusted for authentication.
- **Dual Layer Access Control (AGENTS.md § 9 & tasks.md § 5)**:
  1. `users.system_role = SUPER_ADMIN`: Global override across all administrative operations and channels.
  2. `channel_members` scoped checks for all other users:
     - `EDITOR`: Can create, edit any post in channel, approve, request revisions, reject, publish directly, or schedule.
     - `AUTHOR`: Can create, edit own drafts, submit for review, modify returned drafts. Cannot publish or approve unless explicitly granted `can_publish = true` or `can_approve = true`.
     - `VIEWER`: Read-only access to channel materials.
- **Server-Side Enforcement**: UI button visibility in Telegram is purely aesthetic; every incoming command and callback payload must re-authenticate user status and channel-level permissions in PostgreSQL.

---

## 5. Concurrency Control & State Machine Safety

### 5.1 Controlled State Transitions
Per **AGENTS.md § 10** and **tasks.md § 6**, the post lifecycle is strictly governed by a domain transition service. Direct ad-hoc updates to `post.status` are prohibited.

```text
       [ DRAFT ]
           │
           ▼ (submit_for_review)
   [ PENDING_REVIEW ] ◄──────────────────────┐
      │         │     │                       │
      │         │     ▼ (request_revision)    │ (submit_again)
      │         │   [ NEEDS_REVISION ] ───────┘
      │         ▼ (reject)
      │     [ REJECTED ]
      ▼ (approve)
   [ APPROVED ]
      │      │
      │      ▼ (schedule)
      │   [ SCHEDULED ]
      │      │        │
      │      │        ▼ (cancel_schedule)
      │      │     [ CANCELLED ]
      ▼      ▼
   [ PUBLISHING ] ◄───────────────────────────┐
      │        │                              │
      │        ▼ (retry_exhausted / error)    │ (retry_publish)
      │     [ PUBLISH_FAILED ] ───────────────┘
      │        │
      │        ▼ (cancel)
      │     [ CANCELLED ]
      ▼ (success)
   [ PUBLISHED ]
```

**Permitted Transitions Matrix**:
- `DRAFT` $\to$ `PENDING_REVIEW`
- `PENDING_REVIEW` $\to$ `APPROVED`, `NEEDS_REVISION`, `REJECTED`
- `NEEDS_REVISION` $\to$ `PENDING_REVIEW`
- `APPROVED` $\to$ `SCHEDULED`, `PUBLISHING`
- `SCHEDULED` $\to$ `PUBLISHING`, `CANCELLED`
- `PUBLISHING` $\to$ `PUBLISHED`, `PUBLISH_FAILED`
- `PUBLISH_FAILED` $\to$ `PUBLISHING`, `CANCELLED`

### 5.2 Optimistic Concurrency Control (OCC)
Per **AGENTS.md § 13** and **tasks.md § 12**:
- Multiple editors or authors may concurrently access the same publication.
- Every `Post` entity includes `version Int @default(1)`.
- When mutating content, metadata, or status, the update must execute an atomic conditional query:
  ```sql
  UPDATE posts
  SET
    content_json = :newContentJson,
    version = version + 1,
    updated_at = NOW()
  WHERE
    id = :postId
    AND version = :expectedVersion;
  ```
- If the affected row count is zero, an OCC conflict has occurred.
- The service throws `PostConflictException`. The user receives a clear explanation:
  > *"Публикация была изменена другим пользователем. Откройте актуальную версию и повторите изменение."*
- Silent overwriting of edits is strictly prevented.

### 5.3 Database Transactions & Side-Effect Boundaries
Per **AGENTS.md § 28**:
- Multi-entity writes (e.g. status transition + post_reviews record + audit_log entry) must run within a single database transaction (`prisma.$transaction`).
- **Critical Invariant**: Long-running or external calls (especially Telegram Bot API invocations) must **NEVER** occur inside a database transaction. The transaction commits state changes first; queue enqueuing or external HTTP calls happen post-commit.

---

## 6. Wizard Autosave Architecture

Per **AGENTS.md § 11, 12** and **tasks.md § 9, 10**:

- Creating a post operates as a progressive wizard:
  1. **Step 1 — Channel Selection**: Choose destination channel (skipped if only one channel is accessible).
  2. **Step 2 — Template Selection**: Choose post archetype (Long-read, Announcement, Photo, Video, News, Free-form).
  3. **Step 3 — Field Input**: Sequentially input title, body, links, and structured fields.
  4. **Step 4 — Media Attachment**: Upload photos, videos, documents, or create media groups.
  5. **Step 5 — Editorial Metadata**: Rubrics, tags, call-to-action (CTA), editor notes, scheduled publication time.
  6. **Step 6 — Preview & Action Dashboard**: Render full post preview with actionable buttons.
- **Autosave Implementation**:
  - Immediately upon selecting the channel/template, an initial `Post` record is inserted with `status = DRAFT`.
  - When the user submits each individual field or media item, the application immediately executes a database update against `posts` (updating `content_json` and incrementing `version`) or `post_media`.
  - **No reliance on in-memory wizard state**: In-memory sessions or Redis wizard states are purely transient caches for UI navigation pointers (e.g. `currentStep: "ENTER_BODY"`). All draft data itself resides durably in PostgreSQL.
  - If the bot restarts or crashes mid-wizard, the author can resume editing directly from their saved draft in PostgreSQL.
  - Ordinary autosave updates do not trigger audit logs or Telegram notifications to other team members.

---

## 7. Publishing Architecture & Reliability

Per **AGENTS.md § 15, 16, 20, 21, 22, 23, 24, 25, 48, 49, 50, 65** and **tasks.md § 15, 16, 20, 21, 22, 23**:

```text
[User clicks "Publish" or Schedule Fires]
               │
               ▼
   [Application Service: Preflight & Permission Check]
               │
               ▼
   [DB: Insert publication_jobs (idempotency_key) & Update Post to PUBLISHING]
               │
               ▼
   [BullMQ: Enqueue job in "publication" queue]
               │
               ▼
   [BullMQ Worker: Pick up job]
         │
         ├── 1. Preflight Verification (Post exists, not deleted, channel valid)
         ├── 2. Shared TelegramRenderer creates canonical TelegramPayload
         ├── 3. Execute Telegram API message-by-message
         │        │
         │        ├── On Message Success: Immediately persist telegram_message_id to DB
         │        └── On Failure: 
         │              ├── Retryable (429 rate limit, 5xx): BullMQ exponential backoff
         │              └── Fatal (400, bot kicked, retries exhausted): Mark PUBLISH_FAILED
         │
         ▼
   [DB Transaction: Post -> PUBLISHED, publication_jobs -> COMPLETED, AuditLog]
         │
         ▼
   [Async Event: Dispatch notifications to Author/Editor]
```

### 7.1 Absolute Separation of Publishing from Handlers
- Telegram callback handlers are **strictly prohibited** from invoking Telegram publication methods directly.
- The handler delegates to an Application Service, which validates permissions, records a `publication_jobs` row, and enqueues a BullMQ task.

### 7.2 Idempotency Key Specification
- Every publication attempt is assigned a globally unique idempotency identity:
  $$\text{idempotency\_key} = \text{publish}:\{\text{post\_id}\}:\{\text{post\_version}\}$$
- The `publication_jobs` table enforces `idempotency_key` as a `UNIQUE` database constraint.
- When an editor repeatedly clicks "Publish" or Telegram retries a callback, subsequent requests trigger a unique constraint violation or an existing active job check, safely discarding duplicate requests.

### 7.3 Canonical Rendering Pipeline
- Preview and actual publication **must use the exact same rendering engine** (`TelegramRenderer`).
- Input: `Post` + `PostTemplate` + `PostMedia`.
- Output: `TelegramPayload` containing a list of `TelegramOutgoingMessage` entities:
  - Text message (with strict HTML entities, max 4096 chars).
  - Single photo/video/document (with caption max 1024 chars).
  - Media group (2–10 items).
  - Multi-part message: Media group + separate overflow text message.

### 7.4 Partial Publication Recovery
A logical post publication often requires multiple sequential Telegram Bot API calls (e.g. `sendMediaGroup` followed by `sendMessage` for extensive commentary).
- **Rule (AGENTS.md § 23)**: If step 1 succeeds and step 2 fails, the worker must **NOT** replay step 1 upon retry.
- The worker updates `publication_jobs.telegramMessageIds` in PostgreSQL after each successful API call.
- Upon job retry, the worker inspects `telegramMessageIds` and resumes execution from the first unsent message.

### 7.5 Retry Strategy & Error Classification
- **Retryable Errors**: HTTP 429 (Rate Limit / Too Many Requests), HTTP 5xx (Telegram server errors), transient network timeouts.
  - BullMQ retry configuration: 3 to 5 attempts, exponential backoff (e.g. 2s, 8s, 32s).
  - If Telegram provides `retry_after`, the worker delays the retry by the specified interval.
- **Fatal Errors**: Bot blocked/kicked from channel, invalid chat ID, chat migrated, permanent payload validation failure (HTTP 400).
  - Immediate failure without retry.
- **Retry Exhaustion**: When all attempts are depleted, the post status transitions to `PUBLISH_FAILED`, the error is recorded, and an alert is sent to Editors with a manual retry button ("🔁 Повторить публикацию").

### 7.6 Scheduling & Timezone Discipline
- All schedule datetimes are persisted in PostgreSQL as **`TIMESTAMPTZ` in UTC**.
- Authors and editors input publication dates in the channel's designated timezone (default: `Europe/Kyiv`).
- The application parses and converts local channel time to absolute UTC before persisting and enqueuing delayed BullMQ jobs.
- Preflight validation verifies that the scheduled date is strictly in the future.
- Dual preflight validation: Runs at schedule creation time, and re-executes immediately prior to actual publication in the worker.

---

## 8. HTML Sanitization & Centralized Telegram Limits

### 8.1 HTML Sanitization Engine
Per **AGENTS.md § 17** and **tasks.md § 17**:
- Telegram HTML parse mode is enforced. Arbitrary raw HTML input is strictly rejected.
- **Allowed Tag Whitelist**:
  - `<b>`, `<strong>`
  - `<i>`, `<em>`
  - `<u>`, `<ins>`
  - `<s>`, `<strike>`, `<del>`
  - `<code>`
  - `<pre>`
  - `<a href="...">` (with validated `http://` or `https://` protocols)
  - `<blockquote>`
- **Sanitization Pipeline**:
  1. Escape raw entities: `&` $\to$ `&amp;`, `<` $\to$ `&lt;`, `>` $\to$ `&gt;` (for unformatted text).
  2. Parse and validate HTML tree: strip disallowed attributes, strip disallowed tags, verify balanced closing tags.
  3. Validate link formats (`href` must not contain javascript or arbitrary protocols).
  4. If user-entered HTML is structurally broken, return an explicit, friendly validation error before saving or publishing.

### 8.2 Centralized Telegram Constraints
Per **AGENTS.md § 18**, limits must be centralized in `src/common/constants/telegram-limits.ts`:

```typescript
export const TELEGRAM_LIMITS = {
  MESSAGE_TEXT_MAX_LENGTH: 4096,
  CAPTION_MAX_LENGTH: 1024,
  MEDIA_GROUP_MIN_ITEMS: 2,
  MEDIA_GROUP_MAX_ITEMS: 10,
  CALLBACK_DATA_MAX_BYTES: 64,
  FILE_UPLOAD_MAX_BYTES: 50 * 1024 * 1024, // 50 MB
  SUPPORTED_IMAGE_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  SUPPORTED_VIDEO_MIME_TYPES: ['video/mp4'],
  SUPPORTED_DOCUMENT_MIME_TYPES: ['application/pdf', 'application/zip', 'text/plain'],
} as const;
```

---

## 9. Testing Specifications

Per **AGENTS.md § 39, 40** and **tasks.md § 34**:

### 9.1 Unit Testing
- **Permission & Role Rules**:
  - SuperAdmin bypasses channel-level restrictions.
  - Editor can approve, reject, request revision, publish, schedule.
  - Author cannot publish or approve without explicit boolean flags.
  - Non-member / deactivated user access rejection.
- **State Machine Transitions**:
  - All valid transitions succeed and record audit logs.
  - Disallowed transitions (e.g. `DRAFT` $\to$ `PUBLISHED`, `REJECTED` $\to$ `APPROVED`) throw `InvalidStateTransitionException`.
- **Template & Schema Validation**:
  - Validation against `schema_json` (required fields, string lengths, regex patterns).
- **Canonical Renderer**:
  - Verifies that post content formats into compliant HTML and proper `TelegramPayload` blocks.
  - Caption overflow splits into separate text messages.
- **HTML Sanitization**:
  - Malformed HTML, script injection, unclosed tags, and disallowed tags.
- **Idempotency Key Formulation**:
  - Verifies key construction and determinism across versions.
- **Date & Timezone Calculations**:
  - `Europe/Kyiv` to UTC conversion across daylight saving boundaries.
  - Past date rejection.

### 9.2 Integration Testing
- **Prisma & Database**:
  - Unique constraint enforcement (`telegramId`, `telegramChatId`, `idempotencyKey`).
  - Foreign key cascading and deletion constraints.
  - Optimistic Concurrency Control: concurrent update simulations causing `version` mismatch.
- **BullMQ & Redis**:
  - Enqueuing publication jobs, delayed scheduling, and worker message consumption.
- **Worker Execution & Telegram API Simulation**:
  - Successful multi-message publication flow.
  - Simulated network failure with BullMQ backoff retry.
  - Simulated fatal failure transitioning post to `PUBLISH_FAILED`.
  - Partial publication resume: verify already sent message IDs are preserved and not re-sent.

### 9.3 End-to-End (E2E) Testing
- **Full Editorial Lifecycle Scenario**:
  1. Unauthorized user runs `/start` $\to$ rejected with access denied message.
  2. Author `/start` $\to$ Author dashboard loaded.
  3. Author initiates post wizard $\to$ Channel chosen $\to$ Template chosen $\to$ Title & Body entered $\to$ Intermediate state verified in PostgreSQL.
  4. Author submits for review $\to$ Status `PENDING_REVIEW` $\to$ Editor receives notification event.
  5. Editor reviews draft $\to$ Requests revision with mandatory comment $\to$ Status `NEEDS_REVISION` $\to$ Author notified.
  6. Author updates draft $\to$ Submits again $\to$ Status `PENDING_REVIEW`.
  7. Editor reviews draft $\to$ Approves $\to$ Status `APPROVED`.
  8. Editor publishes $\to$ Worker processes job $\to$ Telegram API called $\to$ Status `PUBLISHED`.
  9. Duplicate publish check $\to$ Rapid double-click on "Publish" yields single publication execution.
  10. Application restart test $\to$ Enqueued/scheduled jobs and draft data survive server reboot.

---

## 10. Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Architecture | Transport Isolation Layer | Strictly isolates grammY Telegram handlers from business domain logic; handlers convert updates into typed domain commands. | Telegram Update (`ctx`) | Domain Command DTO | Drops invalid updates, maps domain errors to friendly UI text | AGENTS.md § 3, 5; tasks.md § 28 |
| 2 | Architecture | Modular NestJS Boundaries | Modular structure separating auth, users, channels, posts, templates, media, reviews, publishing, scheduling, notifications, audit. | NestJS DI Container | Injected Services | Circular dependency or missing provider compile error | AGENTS.md § 4; tasks.md § 28 |
| 3 | Architecture | Process Separation (App vs Worker) | Independent `app` (bot transport/API) and `worker` (BullMQ publishing processor) running in Docker. | Docker Compose services | Scalable independent runtimes | Independent failure isolation | AGENTS.md § 65; tasks.md § 32 |
| 4 | Security | Telegram ID Authorization | Authorizes users strictly via persistent `BigInt` Telegram ID; rejects usernames/display names for auth. | `telegram_user_id: bigint` | Verified `User` record | Rejects with access denied message | AGENTS.md § 8; tasks.md § 4, 7 |
| 5 | Security | Dual-Layer Permission Matrix | Evaluates both system role (`SUPER_ADMIN`, `USER`) and channel-level permissions (`EDITOR`, `AUTHOR`, `VIEWER`, `can_publish`, `can_approve`). | `userId`, `channelId`, `action` | Boolean access decision | Throws `ForbiddenException` | AGENTS.md § 9; tasks.md § 5 |
| 6 | Security | Server-Side Callback Verification | Validates user role and post status on backend for every callback query; ignores client button claims. | `callback_data`, `actorId` | Verified action execution | Rejects stale/unauthorized callback | AGENTS.md § 7, 51, 52 |
| 7 | Security | Webhook Secret Verification | Validates Telegram `X-Telegram-Bot-Api-Secret-Token` header in production webhook mode. | HTTP Request Header | HTTP 200 OK | HTTP 401/403 Forbidden | AGENTS.md § 36; tasks.md § 30 |
| 8 | Security | Startup Config Validation | Fails fast at startup if critical environment variables (`BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`) are missing. | `process.env` | Validated ConfigService | Process exit with clear diagnostic error | AGENTS.md § 35 |
| 9 | Persistence | PostgreSQL Single Source of Truth | Durable relational storage for all users, channels, posts, media, reviews, templates, jobs, and audit logs. | Prisma Client Commands | Persisted SQL records | DB query/connection error | AGENTS.md § 11; tasks.md § 25 |
| 10 | Persistence | Optimistic Concurrency Control (OCC) | Atomic update checking expected post version (`WHERE id = :id AND version = :version`) preventing overwrite collisions. | `postId`, `expectedVersion`, `data` | Updated post (`version + 1`) | Throws `PostConflictException` | AGENTS.md § 13; tasks.md § 12 |
| 11 | Persistence | Atomic Database Transactions | Wraps multi-entity state mutations (status + review + audit) in `prisma.$transaction`. | Transactional operations list | Committed transaction | Rolls back completely on failure | AGENTS.md § 28 |
| 12 | Persistence | Soft Delete for Posts | Marks deleted posts via `deleted_at TIMESTAMPTZ` while preserving audit logs and foreign keys. | `postId`, `actorId` | Post marked deleted | Excluded from active queries and publication | AGENTS.md § 31, 54 |
| 13 | Persistence | Append-Only Audit Logging | Persists immutable history of all editorial actions, state changes, media adjustments, and user additions. | `action`, `entityType`, `entityId`, `metadata` | New `AuditLog` row | Write failure logged without leaking secrets | AGENTS.md § 26; tasks.md § 26 |
| 14 | Post Wizard | Incremental Step Autosave | Immediately persists intermediate wizard field entries and media uploads to PostgreSQL `posts` and `post_media`. | Wizard step input | Updated DB record | Preserves draft across server reboots | AGENTS.md § 12; tasks.md § 9, 10 |
| 15 | Post Wizard | Template Registry & Schema Validation | Dynamic template definitions with JSON schemas defining fields, required constraints, and input types. | Template Key, Field Values | Validated content JSON | Rejects invalid field input | AGENTS.md § 14; tasks.md § 14 |
| 16 | Post Wizard | Telegram Media Re-use | Persists Telegram `file_id` and `file_unique_id`, allowing re-publishing without re-uploading file bytes. | Telegram File Object | Stored `PostMedia` record | Media type/size limit validation error | AGENTS.md § 19; tasks.md § 18 |
| 17 | Review Workflow | Controlled State Machine | Manages post transitions (`DRAFT` $\to$ `PENDING_REVIEW` $\to$ `APPROVED` $\to$ `PUBLISHING` $\to$ `PUBLISHED`, etc.). | `postId`, `action`, `actorId` | Updated Post Status | Throws `InvalidTransitionException` | AGENTS.md § 10; tasks.md § 6 |
| 18 | Review Workflow | Editorial Revision Request | Allows editors to return draft with a mandatory editorial note, transitioning status to `NEEDS_REVISION`. | `postId`, `comment`, `editorId` | Post in `NEEDS_REVISION`, Author notified | Fails if comment is empty | tasks.md § 13, 35 |
| 19 | Publishing | Queued Job Enqueuing | Dispatches publication requests to BullMQ queue instead of calling Telegram API in request context. | `postId`, `version` | Created `publication_jobs` record + BullMQ Job | Fails preflight if post invalid | AGENTS.md § 20; tasks.md § 20 |
| 20 | Publishing | Durable Idempotency Key | Prevents duplicate publications via database unique key `publish:{postId}:{version}`. | `postId`, `version` | Unique publication execution | Duplicate request safely dropped | AGENTS.md § 21; tasks.md § 21 |
| 21 | Publishing | Canonical Telegram Renderer | Unified rendering engine for both UI preview and actual publication, returning structured `TelegramPayload`. | Post, Template, Media | `TelegramPayload` (messages array) | Throws formatting error | AGENTS.md § 15, 16; tasks.md § 15, 16 |
| 22 | Publishing | Partial Publication Recovery | Tracks successfully sent Telegram message IDs; resumes multi-part publishing without resending sent parts. | `publicationJobId`, sent IDs | Resumed publication | Skips already sent parts on retry | AGENTS.md § 23; tasks.md § 23 |
| 23 | Publishing | Exponential Backoff Retries | Retries transient errors (429, 5xx, network timeouts) via BullMQ with exponential delay. | Failed Job Attempt | Delayed retry execution | Transitions to `PUBLISH_FAILED` when exhausted | AGENTS.md § 22, 49, 50; tasks.md § 22 |
| 24 | Publishing | Dual Preflight Verification | Verifies post existence, non-deletion, active channel, and bot permissions at schedule time and publish time. | `postId`, `channelId` | Preflight pass | Aborts publication with diagnostic error | AGENTS.md § 25 |
| 25 | Scheduling | Timezone-Aware Scheduling | Accepts dates in channel timezone (default `Europe/Kyiv`), validates future constraint, persists as UTC `TIMESTAMPTZ`. | Local Datetime String, Timezone | UTC Timestamp + Delayed Job | Rejects dates in the past | AGENTS.md § 24, 47; tasks.md § 19 |
| 26 | Formatting | HTML Sanitizer & Whitelist Validator | Enforces allowed Telegram HTML tags, escapes special characters, and validates tag nesting. | User HTML / Markdown text | Safe sanitized HTML | Rejects malformed HTML with user error | AGENTS.md § 17; tasks.md § 17 |
| 27 | Formatting | Centralized Telegram Limits | Central repository of Telegram constraints (4096 text limit, 1024 caption limit, 2-10 media groups). | Payload components | Validated payload bounds | Splits or rejects overflowing components | AGENTS.md § 18 |
| 28 | Observability | Structured JSON Logging | Structured logging with contextual correlation IDs (`request_id`, `user_id`, `channel_id`, `post_id`, `job_id`). | Log Event + Context | Formatted JSON Log | Masks secrets and tokens | AGENTS.md § 33; tasks.md § 31 |
| 29 | Observability | Health & Readiness Endpoints | Lightweight `GET /health` (process liveness) and `GET /ready` (Postgres, Redis, Queue availability). | HTTP GET | HTTP 200 / 503 JSON | Diagnostic dependency failure status | AGENTS.md § 37, 38; tasks.md § 29 |
| 30 | Operations | Graceful Shutdown | Intercepts SIGTERM/SIGINT, closes queue listeners, finishes active jobs, and drains database pools. | OS Shutdown Signal | Clean process exit | Enforces timeout to prevent hang | AGENTS.md § 66 |

---

## 11. Edge Cases

| # | Feature | Input / Scenario | Observed Behavior |
|---|---------|------------------|-------------------|
| 1 | Authorization | User not present in `users` table issues `/start` | Bot immediately responds with access denied message; no menu or actions exposed; no unauthorized database records created. |
| 2 | Authorization | User changes Telegram username, first name, or display name | System correctly authenticates user based exclusively on immutable `telegram_id`; new username is updated in user record for display without altering permissions. |
| 3 | Permissions | Author clicks inline button for "Publish" or manipulates callback payload | Server-side permission check rejects the request with `ForbiddenException`; action is blocked regardless of UI button state. |
| 4 | Permissions | User removed from `channel_members` while having open draft | Server-side check rejects any subsequent wizard or review transition for that channel. |
| 5 | Concurrency | Two editors simultaneously click "Approve" or edit post content | First request commits with `version = N + 1`; second request matches `version = N` where row has `version = N + 1`, updates 0 rows, and fails with `PostConflictException`. |
| 6 | State Machine | User attempts direct transition from `DRAFT` to `APPROVED` or `REJECTED` to `APPROVED` | Domain workflow service validates transition against permitted matrix; throws `InvalidStateTransitionException`; database remains unchanged. |
| 7 | Review Workflow | Editor submits revision request with an empty comment string | Validation error thrown: revision requests strictly require an editorial explanation; transition to `NEEDS_REVISION` is rejected. |
| 8 | Autosave | Server process or container crashes after step 3 (body entered) | Draft remains intact in PostgreSQL with current step data; on reboot, author can view "Мои материалы" and continue editing. |
| 9 | Publishing | Editor double-clicks "Publish Now" button within 100 milliseconds | Two requests hit server; first inserts `publication_jobs` with `publish:{postId}:{version}`; second encounters unique constraint violation and returns idempotent acknowledgement without queuing second job. |
| 10 | Publishing | Telegram returns HTTP 429 Too Many Requests with `retry_after: 45` | BullMQ worker intercepts rate limit error, sets job delay to 45 seconds, and reschedules without incrementing error count towards fatal failure. |
| 11 | Publishing | Network fails during multi-message publication after media group is sent | Worker saves sent Telegram message IDs in `publication_jobs.telegramMessageIds`; on retry, worker reads existing IDs, skips media group, and sends only the remaining text message. |
| 12 | Publishing | Bot was kicked from channel before scheduled publication executes | Worker preflight or Telegram API call fails with fatal "Chat not found" / "Forbidden: bot is not a member"; job aborts retries immediately and marks post as `PUBLISH_FAILED`. |
| 13 | Scheduling | User submits schedule time in past (e.g. earlier today in `Europe/Kyiv`) | Preflight validation fails with error: "Scheduled publication time must be in the future"; post remains in `APPROVED` status. |
| 14 | Scheduling | Daylight saving time transition occurs between schedule time and execution | Channel timezone `Europe/Kyiv` is converted to absolute UTC `TIMESTAMPTZ` at creation time, ensuring exact physical execution time regardless of local clock shifts. |
| 15 | Formatting | Post body contains raw unescaped `<` or `>` or unclosed `<b>` tag | HTML sanitizer detects unclosed tags; returns validation error to author rather than sending malformed HTML that triggers Telegram 400 Bad Request. |
| 16 | Formatting | Caption on a single photo post exceeds 1024 characters | Canonical renderer splits the post: photo sent with empty or truncated summary caption, followed immediately by full text message (up to 4096 characters). |
| 17 | Media | User attaches document containing a video file | Media module detects file mime-type and metadata; records as `DOCUMENT` or `VIDEO` according to Telegram API transmission format, preserving `file_id`. |
| 18 | UI Consistency | User clicks button on stale Telegram message from 3 days ago | Handler retrieves fresh post state from PostgreSQL; if status no longer allows action, user is notified that the action is no longer valid, and keyboard is removed/refreshed. |
