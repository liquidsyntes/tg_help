# Project: Telegram Content Publisher Bot MVP

## Architecture
The system is an editorial publishing platform inside Telegram, engineered with strict architectural separation between transport and business domains.

### Stack:
- **Runtime**: Node.js 22+ (v24 LTS installed)
- **Language**: TypeScript strict mode (no `any`, domain-typed IDs)
- **Framework**: NestJS
- **Telegram Transport**: grammY
- **Database & ORM**: PostgreSQL with Prisma (10 models, optimistic concurrency, transactions)
- **Queue & Async Processing**: Redis & BullMQ (idempotent workers, retries with exponential backoff)
- **Containerization**: Docker Compose (`app`, `worker`, `postgres`, `redis`)

### Flow:
```text
Telegram Update -> Telegram Handler (transport only)
   ↓
Application Service / Command DTO
   ↓
Domain Rules (State machine, OCC check, permissions)
   ↓
Database Transaction (Prisma) + Audit Log
   ↓
BullMQ Job Enqueue (idempotency key publish:{postId}:{version})
   ↓
Background Worker -> TelegramPublisher (records message IDs) -> PUBLISHED
```

---

## Feature Inventory
Every feature identified during the Survey Phase is assigned to an implementation milestone.

| # | Feature | Category | Description | Milestone | Source |
|---|---|---|---|:---:|---|
| F-01 | Telegram ID Auth | Auth & RBAC | Authenticate incoming Telegram user using Telegram ID; verify existence and active flag. | M2 | tasks.md §4, §7; AGENTS.md §8 |
| F-02 | Role & Permission Check | Auth & RBAC | Evaluate system role (`SUPER_ADMIN`, `USER`) and channel role (`EDITOR`, `AUTHOR`, `VIEWER`) + flags. | M2 | tasks.md §4, §5; AGENTS.md §9 |
| F-03 | Dynamic Role-Based Menu | Auth & RBAC | Render role-tailored bot menu (Author menu vs Editor/Admin menu). | M5 | tasks.md §8 |
| F-04 | Multi-Channel Data Model | Channels | Support multiple channels in DB with chat ID, title, timezone, and active state. | M1 | tasks.md §3; AGENTS.md §30 |
| F-05 | Auto-Skip Single Channel | Channels | Automatically select channel in wizard if user has access to exactly one channel. | M2 | tasks.md §9 |
| F-06 | Timezone Conversion | Channels | Parse user datetime in channel timezone (default `Europe/Kyiv`) and persist as UTC `TIMESTAMPTZ`. | M2 | tasks.md §3, §19; AGENTS.md §24, §47 |
| F-07 | Wizard Channel Step | Wizard & Drafts | Step 1 of post creation: Display buttons for authorized channels. | M5 | tasks.md §9 |
| F-08 | Wizard Template Step | Wizard & Drafts | Step 2: Choose post template (Long-read, Announcement, Photo, etc.); init draft in DB. | M5 | tasks.md §9, §14 |
| F-09 | Wizard Field Input | Wizard & Drafts | Step 3: Prompt user sequentially for fields defined in template schema. | M5 | tasks.md §9, §14; AGENTS.md §14 |
| F-10 | Step-by-Step Autosave | Wizard & Drafts | Persist draft data to PostgreSQL immediately after each step/field; zero in-memory dependence. | M5 | tasks.md §9, §10; AGENTS.md §11, §12 |
| F-11 | Wizard Media Upload | Wizard & Drafts | Step 4: Accept photo, video, document, animation, media group; store Telegram `file_id`. | M5 | tasks.md §9, §18; AGENTS.md §19 |
| F-12 | Wizard Metadata Input | Wizard & Drafts | Step 5: Input rubric, tags, CTA, links, priority, editorial comment, schedule time. | M5 | tasks.md §9 |
| F-13 | Preview & Control Panel | Wizard & Drafts | Step 6: Render exact post preview using canonical renderer with contextual action buttons. | M5 | tasks.md §9, §15, §16; AGENTS.md §15, §16 |
| F-14 | Granular Field Editing | Wizard & Drafts | Allow editing individual fields without restarting entire wizard. | M5 | tasks.md §11 |
| F-15 | Soft Delete Draft | Wizard & Drafts | Author/Editor can soft-delete draft with confirmation (`deleted_at = NOW()`). | M2 | AGENTS.md §31, §54 |
| F-16 | Optimistic Concurrency Control | OCC | Ensure safe concurrent editing via `version INTEGER` and `WHERE id = :id AND version = :v`. | M2 | tasks.md §12; AGENTS.md §13 |
| F-17 | Dynamic Schema & Validation | Templates | Validate field content against template `schema_json` (type, required, length). | M3 | tasks.md §14; AGENTS.md §14 |
| F-18 | Canonical TelegramRenderer | Templates | Unified formatting engine converting Post + Template + Media into `TelegramPayload`. | M3 | tasks.md §15, §16; AGENTS.md §15, §16 |
| F-19 | HTML Sanitization | Formatting | Sanitize and escape HTML before persistence; allow only Telegram supported tags. | M3 | tasks.md §17; AGENTS.md §17 |
| F-20 | Multi-Message Splitting | Formatting | Split publications into multiple messages (media group + long text >1024 chars). | M3 | tasks.md §16; AGENTS.md §16 |
| F-21 | Telegram file_id Reuse | Media | Store and reuse Telegram `file_id` for publishing without re-downloading/uploading. | M3 | tasks.md §18; AGENTS.md §19 |
| F-22 | Document-as-Video Handling | Media | Gracefully detect and handle video files sent as uncompressed documents. | M3 | tasks.md §18; AGENTS.md §19 |
| F-23 | Submit for Review | Review | Author submits draft; transitions `DRAFT -> PENDING_REVIEW`; notifies editors. | M2 | tasks.md §6, §13; AGENTS.md §10 |
| F-24 | Editor Review Card | Review | Present incoming review queue card with Author, Channel, Type, Preview, and Action buttons. | M5 | tasks.md §13 |
| F-25 | Approve Post | Review | Editor approves publication; transitions `PENDING_REVIEW -> APPROVED`; notifies Author. | M2 | tasks.md §6, §13; AGENTS.md §10 |
| F-26 | Request Revision with Feedback | Review | Editor requests changes with mandatory comment; transitions `PENDING_REVIEW -> NEEDS_REVISION`. | M2 | tasks.md §6, §13; AGENTS.md §10 |
| F-27 | Reject Post | Review | Editor rejects publication; transitions `PENDING_REVIEW -> REJECTED`; notifies Author. | M2 | tasks.md §6, §13; AGENTS.md §10 |
| F-28 | Revision & Resubmission | Review | Author edits post in `NEEDS_REVISION`, sees feedback, and resubmits (`NEEDS_REVISION -> PENDING_REVIEW`). | M2 | tasks.md §6, §13; AGENTS.md §10 |
| F-29 | Review Queue Navigation | Review | Editors browse posts awaiting review via paginated menu. | M5 | tasks.md §8, §13 |
| F-30 | Async Queued Publishing | Publishing | Publish action creates `publication_jobs` and enqueues BullMQ job; no direct API calls in handler. | M4 | tasks.md §20; AGENTS.md §3, §20 |
| F-31 | Publication Idempotency Key | Publishing | Enforce single publication via database unique key `publish:{post_id}:{post_version}`. | M4 | tasks.md §21; AGENTS.md §21 |
| F-32 | Preflight Validation | Publishing | Validate channel active, bot admin rights, chat ID existence, and payload before publish. | M4 | tasks.md §19; AGENTS.md §25 |
| F-33 | Worker Execution & Message Recording | Publishing | Worker executes calls via `TelegramPublisher` and records `telegram_message_ids` in DB. | M4 | tasks.md §20, §23; AGENTS.md §23, §48 |
| F-34 | Partial Publishing Resume | Publishing | On retry, worker inspects `telegram_message_ids` and resumes sending without duplicates. | M4 | tasks.md §23; AGENTS.md §23 |
| F-35 | Exponential Backoff & Retry | Publishing | BullMQ retries transient errors (429, 5xx) with backoff; transitions to `PUBLISH_FAILED` if exhausted. | M4 | tasks.md §22; AGENTS.md §22, §49, §50 |
| F-36 | Manual Retry of Failed Post | Publishing | Failed post provides button `🔁 Повторить публикацию` to re-enqueue. | M4 | tasks.md §22; AGENTS.md §10 |
| F-37 | Schedule Approved Post | Scheduling | Set future publication time; transitions `APPROVED -> SCHEDULED`; enqueues delayed BullMQ job. | M4 | tasks.md §6, §19; AGENTS.md §24 |
| F-38 | Cancel Schedule | Scheduling | Editor/Admin cancels schedule; transitions `SCHEDULED -> CANCELLED`; removes queue job. | M2 | tasks.md §6; AGENTS.md §10 |
| F-39 | Domain Event Notifications | Notifications | Decoupled notification service delivers alerts on status changes. | M2 | tasks.md §24; AGENTS.md §27 |
| F-40 | Autosave Silent Rule | Notifications | Guarantee zero notifications emitted during routine draft autosaves. | M2 | tasks.md §24 |
| F-41 | Append-Only Audit Logging | Audit | Record all status transitions, media modifications, and user changes in `audit_logs`. | M2 | tasks.md §26; AGENTS.md §26 |
| F-42 | Stale UI & Replay Protection | UI & Safety | Handlers check current DB post status before executing; reject stale buttons. | M5 | AGENTS.md §51, §52 |
| F-43 | Destructive Action Confirmation | UI & Safety | Require explicit confirmation dialog for delete draft, cancel publication, or user removal. | M5 | AGENTS.md §54 |
| F-44 | Health & Readiness Probes | Observability | Expose `GET /health` (liveness) and `GET /ready` (PostgreSQL, Redis, Queue). | M1 | tasks.md §29, §31; AGENTS.md §37, §38 |
| F-45 | Structured JSON Logging | Observability | Output structured JSON logs with `user_id`, `post_id`, `job_id`, redacting secrets. | M1 | tasks.md §31; AGENTS.md §33, §34 |
| F-46 | Environment Validation | Infrastructure | Validate required env vars at startup (`BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, etc.); fail fast. | M1 | AGENTS.md §35 |
| F-47 | Dual Transport Mode | Infrastructure | Support both Webhook (`POST /telegram/webhook`) and Polling mode. | M1 | tasks.md §28, §29; AGENTS.md §36 |
| F-48 | Worker / App Process Separation | Infrastructure | Architecture & Docker Compose support running `app` and `worker` as separate processes. | M1 | AGENTS.md §65 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | Foundation, Database & Infra | NestJS setup, Prisma 10 models & initial migration, Redis & BullMQ config, Docker Compose, Env validation, Health endpoints | none | DONE |
| M2 | Domain Models, RBAC & State Machine | User/Channel services, RBAC, Post State Machine with OCC versioning, Audit Logging, Reviews, Notifications | M1 | DONE |
| M3 | Templates, Canonical Rendering & Media | Post templates, Dynamic schema validation, HTML Sanitizer, Canonical TelegramRenderer, Media handling | M2 | PLANNED |
| M4 | Publishing Engine & BullMQ Idempotency | BullMQ Worker, TelegramPublisher abstraction, Idempotency key, Retries & Exponential backoff, Partial publish resume | M3 | PLANNED |
| M5 | Telegram Transport & Interactive Wizard UI | grammY bot setup, Auth middleware, Step-by-step wizard with PostgreSQL autosave, Preview & Review cards | M4 | PLANNED |
| M6 | E2E Testing & Adversarial Hardening | E2E test suite (Tiers 1-4: 100% pass) + Adversarial Tier 5 coverage hardening | M5 | PLANNED |

---

## Interface Contracts

### 1. Auth & RBAC ↔ Telegram Transport
- `AuthService.resolveUser(telegramId: bigint): Promise<UserEntity | null>`
- `PermissionService.checkPermission(actorId: string, channelId: string, permission: Permission): Promise<boolean>`
- Guards return standard domain exceptions: `UnauthorizedUserException`, `PermissionDeniedException`, `UserDeactivatedException`.

### 2. Workflow ↔ Publishing Engine
- `PostWorkflowService.transition(command: TransitionCommand): Promise<PostEntity>`
- `PublishingService.enqueuePublish(postId: string, actorId: string): Promise<PublicationJob>`
- Idempotency key format: `publish:{postId}:{version}`.
- Concurrency exception: `PostConflictException` on OCC version mismatch.

### 3. Template / Renderer ↔ Publishing & Preview
- `TelegramRenderer.render(post: Post, template: PostTemplate, media: PostMedia[]): Promise<TelegramPayload>`
- `TelegramPayload`: `{ messages: TelegramOutgoingMessage[] }`
- Output conforms to Telegram limits (caption $\le$ 1024, text $\le$ 4096, media group 2-10 items).

### 4. Publishing Worker ↔ Telegram API Abstraction
- `ITelegramPublisher.sendMediaGroup(chatId: string, media: OutgoingMedia[]): Promise<number[]>` (returns message IDs)
- `ITelegramPublisher.sendMessage(chatId: string, text: string, options: SendOptions): Promise<number>`
- Error classification: `isRetryable(error: Error): boolean`, `getRetryDelay(error: Error): number | null`.

---

## Code Layout
```text
src/
  common/
    constants/telegram-limits.ts
    dto/
    enums/
    exceptions/
    guards/
    utils/
  infrastructure/
    database/ (PrismaService, PrismaModule)
    redis/ (RedisService, RedisModule)
    queues/ (BullMQ config, QueueModule)
    logger/ (StructuredLoggerService)
    config/ (EnvironmentConfigService, validation)
    telegram-api/ (ITelegramPublisher, TelegramPublisherService)
  modules/
    auth/ (AuthService, AuthGuard)
    users/ (UsersService, UsersRepository)
    channels/ (ChannelsService, ChannelMembersService)
    posts/ (PostsService, PostWorkflowService, OCC repository)
    templates/ (TemplatesService, TemplateValidator)
    rendering/ (TelegramRenderer, HtmlSanitizer)
    media/ (MediaService)
    reviews/ (ReviewsService)
    publishing/ (PublishingService, PublishingWorker)
    scheduling/ (SchedulingService)
    notifications/ (NotificationService)
    audit/ (AuditLogService)
    telegram/ (BotModule, BotService, Handlers, Wizard)
    health/ (HealthController)
tests/
  unit/
  integration/
  e2e/
docker-compose.yml
```
