# Milestone 4 Architectural Investigation & Design Report: Scheduling, Preflight Validation & Partial Publication Resume

**Agent**: `m4_explorer_3` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Target Milestone**: M4 — Publishing Engine & BullMQ Idempotency  
**Authoritative References**:
- `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`
- `c:/TgHelp/.agents/PROJECT.md`
- `c:/TgHelp/AGENTS.md` (§10, §13, §15, §16, §20, §21, §22, §23, §24, §25, §26, §27, §31, §39, §47)
- `c:/TgHelp/tasks.md` (§6, §12, §13, §15, §16, §19, §20, §21, §22, §23, §24, §25, §26)
- `c:/TgHelp/.agents/TEST_READY.md` (34/34 passing E2E tests)

---

## 1. Executive Summary

Milestone 4 establishes the core publication engine of the Telegram Content Publisher Bot. This report details the architectural investigation and comprehensive technical specification for three interrelated subsystems:
1. **Timezone-Aware Scheduling**: Channel-aware datetime parsing (default `Europe/Kyiv` via Luxon), strict future-date validation, optimistic concurrency control (OCC) state transition (`APPROVED -> SCHEDULED`), append-only audit logging, delayed BullMQ job enqueueing, and robust schedule cancellation (`cancelSchedule`).
2. **Two-Stage Preflight Validation**:
   - **Stage 1 (Pre-Enqueue / Pre-Schedule)**: Synchronous pre-validation of post status, author permissions, template validity, media invariants, and dry-run rendering before any database state modification or queue enqueue.
   - **Stage 2 (Worker Pre-Publish)**: Immediate pre-execution validation inside the BullMQ worker before any Telegram Bot API calls, verifying post existence, active status, soft-delete invariants, channel active state, bot channel administrative rights, and media validity.
3. **Partial Publication Resume (AGENTS.md §23)**: Safe multi-message publication (e.g. Media Group + overflow long text message). Each successful Telegram API call atomically persists Telegram message IDs into `PublicationJob.telegramMessageIds` in PostgreSQL. On worker retry, previously sent parts are skipped using an exact cumulative ID matching algorithm, guaranteeing zero message duplication in the Telegram channel.
4. **Editorial Notifications**: Decoupled event dispatching via `DomainEventBus` on `PUBLISHED` and `PUBLISH_FAILED`, delivering structured notifications to authors and editors while strictly preserving the Autosave Silent Rule (F-40).

All designs strictly comply with repository architectural invariants, strict TypeScript conventions, Prisma schema models, and existing E2E test assertions in `tests/e2e/tier3-cross-feature.spec.ts`.

---

## 2. Timezone-Aware Scheduling Architecture

### 2.1 Context & Invariants
- **Database Storage**: Publication time is stored as an absolute UTC instant in PostgreSQL using `scheduled_at TIMESTAMPTZ` (`post.scheduledAt`).
- **Channel Timezone Interpretation**: User-entered datetimes must be parsed in the context of the target channel's configured timezone (`channel.timezone`, default `'Europe/Kyiv'`).
- **No Ambiguous Local Time**: The server local timezone must never influence business calculations (AGENTS.md §47: *“Never assume server local timezone is the publication timezone”*).
- **Future Date Constraint**: Scheduled dates must be strictly in the future (`scheduledAt.getTime() > Date.now()`). Scheduling in the past is rejected immediately with a domain `ValidationException`.
- **State Machine Compliance**: Scheduling requires the post to be in `APPROVED` status and transitions it to `SCHEDULED` with an OCC version increment (`version + 1`).

### 2.2 Integration with Existing Codebase
The repository already provides `src/modules/channels/utils/timezone.util.ts`, which leverages Luxon `DateTime` and `IANAZone`:
- `parseAndValidateScheduledDate(input: string, channelTimezone = 'Europe/Kyiv', nowMs = Date.now()): Date`
  Supports `'dd.MM.yyyy HH:mm'`, `'yyyy-MM-dd HH:mm'`, and ISO 8601 strings. Throws `ValidationException` if invalid or if `date.getTime() <= nowMs`.
- `formatChannelDate(date: Date, channelTimezone = 'Europe/Kyiv'): string`
  Formats UTC `Date` back into channel localized string `'dd.MM.yyyy HH:mm'`.

### 2.3 SchedulingService Design
The new `SchedulingService` lives in `src/modules/scheduling/scheduling.service.ts` within `SchedulingModule`.

#### Dependencies:
```ts
@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postWorkflow: PostWorkflowService,
    private readonly channelsService: ChannelsService,
    private readonly preflightService: PreflightService,
    private readonly auditService: AuditService,
    private readonly logger: StructuredLoggerService,
    @InjectQueue(PUBLICATION_QUEUE_NAME)
    private readonly publicationQueue: Queue<PublicationJobData>,
  ) {}
}
```

#### Method 1: `schedulePost(dto: SchedulePostDto, actorId: string): Promise<SchedulePostResult>`

```text
User / Handler Request
    ↓
1. Resolve Post & Target Channel (Timezone: channel.timezone || 'Europe/Kyiv')
    ↓
2. Parse & Validate Scheduled Date (Luxon, date > now)
    ↓
3. Stage 1 Preflight Validation (PreflightService.validateStage1)
    ↓
4. PostWorkflowService.transition({
     postId,
     expectedVersion,
     actorId,
     targetStatus: PostStatus.SCHEDULED,
     scheduledAt: targetDate
   }) -> OCC atomic update, audit log (action: scheduled), emits PostScheduledEvent
    ↓
5. Create Prisma PublicationJob record:
     idempotencyKey: `publish:${updatedPost.id}:${updatedPost.version}`
     status: PENDING
     scheduledFor: targetDate
    ↓
6. Enqueue delayed BullMQ job:
     queue.add(JOB_NAMES.PUBLISH_POST, jobData, {
       jobId: publicationJob.id,
       delay: targetDate.getTime() - Date.now(),
       attempts: 3,
       backoff: { type: 'exponential', delay: 2000 }
     })
    ↓
7. Return updated post & publicationJob metadata
```

**Step Details**:
1. **Timezone Conversion & Validation**:
   ```ts
   const channel = await this.channelsService.getById(post.channelId);
   const scheduledDate = typeof dto.scheduledAt === 'string'
     ? parseAndValidateScheduledDate(dto.scheduledAt, channel.timezone)
     : dto.scheduledAt;

   if (scheduledDate.getTime() <= Date.now()) {
     throw new ValidationException('Нельзя планировать публикацию в прошлом.');
   }
   ```
2. **Stage 1 Preflight Validation**:
   ```ts
   await this.preflightService.validateStage1(post.id, post.channelId, actorId);
   ```
3. **Atomic State Transition & OCC**:
   `PostWorkflowService.transition` atomically checks `post.status === APPROVED`, `post.version === dto.expectedVersion`, checks `ChannelPermission.PUBLISH_POST`, increments version, sets `scheduledAt`, creates an `AuditLog` entry (`action: AuditAction.SCHEDULED`), and publishes `PostScheduledEvent`.
4. **Durable PublicationJob Record**:
   ```ts
   const publicationJob = await this.prisma.publicationJob.create({
     data: {
       postId: updatedPost.id,
       postVersion: updatedPost.version,
       idempotencyKey: `publish:${updatedPost.id}:${updatedPost.version}`,
       channelId: updatedPost.channelId,
       status: PublicationJobStatus.PENDING,
       attempts: 0,
       maxAttempts: 3,
       scheduledFor: scheduledDate,
       telegramMessageIds: [],
     },
   });
   ```
5. **Delayed Queue Enqueue**:
   ```ts
   const delayMs = scheduledDate.getTime() - Date.now();
   await this.publicationQueue.add(
     JOB_NAMES.PUBLISH_POST,
     {
       publicationJobId: publicationJob.id,
       postId: updatedPost.id,
       postVersion: updatedPost.version,
       channelId: updatedPost.channelId,
       actorId,
       isScheduled: true,
     },
     {
       jobId: publicationJob.id,
       delay: delayMs,
       attempts: 3,
       backoff: { type: 'exponential', delay: 2000 },
     },
   );
   ```

#### Method 2: `cancelSchedule(dto: CancelScheduleDto, actorId: string): Promise<Post>`

```text
User / Handler Request
    ↓
1. Verify post exists, deletedAt === null, status === SCHEDULED
    ↓
2. Verify actor has ChannelPermission.CANCEL_SCHEDULE
    ↓
3. Find active PublicationJob in DB (status: PENDING)
    ↓
4. Remove delayed job from BullMQ:
     bullJob = await queue.getJob(publicationJob.id)
     if (bullJob) await bullJob.remove()
    ↓
5. Update PublicationJob status in Prisma -> CANCELLED
    ↓
6. State Machine Transition:
     Default: PostStatus.CANCELLED (AuditAction.SCHEDULE_CANCELLED)
     Optional: PostStatus.APPROVED (if dto.returnToApproved === true)
    ↓
7. Return updated post
```

**Implementation Details**:
```ts
async cancelSchedule(dto: CancelScheduleDto, actorId: string): Promise<Post> {
  const post = await this.prisma.post.findUnique({
    where: { id: dto.postId },
  });

  if (!post || post.deletedAt !== null) {
    throw new ValidationException(`Post "${dto.postId}" not found or deleted.`);
  }

  if (post.status !== PostStatus.SCHEDULED) {
    throw new InvalidPostStateTransitionException(
      post.status,
      PostStatus.CANCELLED,
    );
  }

  // 1. Find pending publication job in DB
  const pendingJob = await this.prisma.publicationJob.findFirst({
    where: {
      postId: post.id,
      status: PublicationJobStatus.PENDING,
    },
  });

  // 2. Remove delayed BullMQ job if present
  if (pendingJob) {
    const bullJob = await this.publicationQueue.getJob(pendingJob.id);
    if (bullJob) {
      await bullJob.remove();
    }
    await this.prisma.publicationJob.update({
      where: { id: pendingJob.id },
      data: { status: PublicationJobStatus.CANCELLED },
    });
  }

  // 3. Transition post state via PostWorkflowService
  const targetStatus = dto.returnToApproved ? PostStatus.APPROVED : PostStatus.CANCELLED;
  return this.postWorkflow.transition({
    postId: post.id,
    expectedVersion: dto.expectedVersion,
    actorId,
    targetStatus,
    action: dto.returnToApproved ? PostAction.APPROVE : PostAction.CANCEL,
  });
}
```

---

## 3. Two-Stage Preflight Validation Design

Preflight validation safeguards publication integrity by verifying system invariants at two distinct points in the post lifecycle (AGENTS.md §25, tasks.md §19):
1. **Stage 1**: When scheduling or immediate publication is initiated.
2. **Stage 2**: Immediately before actual API dispatch inside the worker.

```text
[ Author/Editor Action ]
         ↓
  [ Preflight Stage 1 ] ──(Fails)──> Synchronous Domain Exception (No DB change, No Job)
         ↓ (Passes)
  [ DB OCC + BullMQ Enqueue ]
         ↓
   [ Queue Delay / Wait ]
         ↓
  [ BullMQ Worker Pickup ]
         ↓
  [ Preflight Stage 2 ] ──(Fails)──> Permanent Failure / CANCELLED / PUBLISH_FAILED (Audit + Alert)
         ↓ (Passes)
  [ Multi-Part Publishing ]
```

### 3.1 PreflightService Structure
Location: `src/modules/publishing/preflight.service.ts`

```ts
@Injectable()
export class PreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templatesService: TemplatesService,
    private readonly renderer: TelegramRenderer,
    private readonly permissionService: PermissionService,
    private readonly logger: StructuredLoggerService,
    @Optional()
    @Inject('ITelegramPublisher')
    private readonly publisher?: ITelegramPublisher,
  ) {}
}
```

### 3.2 Stage 1: Pre-Schedule / Pre-Enqueue Validation
Triggered by: `SchedulingService.schedulePost` and `PublishingService.enqueuePublish`.

**Validation Rules & Invariants**:
1. **Post State & Soft-Delete**:
   - `post.deletedAt === null` (throws `ValidationException`).
   - `post.status === PostStatus.APPROVED` (or `PUBLISH_FAILED` for manual retry; throws `InvalidPostStateTransitionException`).
2. **Target Channel**:
   - Channel exists in DB and `channel.isActive === true`.
   - `channel.telegramChatId` is non-empty and formatted correctly.
3. **Actor Permissions**:
   - Actor holds `ChannelPermission.PUBLISH_POST` (or `systemRole === SUPER_ADMIN`).
4. **Template Content Validation**:
   - Post `templateId` refers to an active template.
   - Post `contentJson` is validated against `template.schemaJson` via `TemplatesService.validatePostContent(template.id, post.contentJson)`.
   - All required fields must be populated, within `minLength`/`maxLength`, and conform to field regexes.
5. **Media Invariants**:
   - If post has media attachments, verify all media types are in `template.supportedMediaTypes`.
   - Media count invariants: if $\ge 2$ items, count must be $\le 10$ (Telegram media group limit); if 1 item, must be supported single media.
   - All media items must possess non-empty `telegramFileId` and `telegramFileUniqueId`.
6. **Dry-Run Canonical Rendering**:
   - Executes `TelegramRenderer.render(post, template, media)`.
   - Validates that rendered payload contains at least 1 message and that each message satisfies Telegram length constraints (caption $\le 1024$, message text $\le 4096$).

### 3.3 Stage 2: Immediate Worker Pre-Publish Validation
Triggered by: `PublishingWorker.process()` inside the worker process immediately before any external network calls.

**Validation Rules & Invariants**:
1. **Fresh Database Inspection**:
   - Re-fetch post with latest state (`include: { channel: true, template: true, media: true }`).
   - Verify post exists and `post.deletedAt === null`. (If deleted: abort, mark job `FAILED`).
   - Verify post status is still eligible: `APPROVED`, `SCHEDULED`, or `PUBLISHING`.
     If status changed to `CANCELLED` (e.g. schedule was cancelled while job was in flight) or `DRAFT`: abort immediately, do NOT call Telegram API.
2. **Channel Active State**:
   - Verify `channel.isActive === true`. If deactivated: abort, mark job `FAILED`.
3. **Bot Channel Rights (Pre-Flight Bot API Check)**:
   - Worker verifies that the bot is still an administrator in the channel:
     Calls `getChatMember(channel.telegramChatId, botId)` via publisher double or Telegram API wrapper.
     Verifies `status === 'administrator'` or `'creator'` and `can_post_messages === true`.
     *(Note: In mock environment or test runs, the mock double verifies this check automatically).*
4. **Media Usability**:
   - Verifies media records are intact and `telegramFileId` references are present.
5. **Fresh Payload Rendering**:
   - Executes `TelegramRenderer.render(post, post.template, post.media)` to generate the authoritative `TelegramPayload`.

**Stage 2 Failure Handling**:
- **Permanent Failures** (post soft-deleted, schedule cancelled, channel deactivated, bot removed from channel):
  - Do NOT retry.
  - Set `PublicationJob.status = FAILED` or `CANCELLED`.
  - If post status allows, set `post.status = PUBLISH_FAILED`.
  - Record audit log with failure reason.
  - Dispatch `PostPublicationFailedEvent` to alert editors.
- **Transient Failures** (e.g. Telegram network timeout during bot admin check):
  - Let error propagate to BullMQ for automatic exponential backoff retry.

---

## 4. Partial Publication Resume Architecture (AGENTS.md §23)

### 4.1 The Problem
A single logical publication often requires multiple distinct Telegram Bot API calls. Examples:
- **Media Group + Overflow Text**: Post has 2 photos and a 2,000-character description. Telegram limits media group captions to 1,024 characters.
  - Call 1: `sendMediaGroup(chatId, [photo1, photo2])` with caption $\le 1024$. Returns `[1001, 1002]`.
  - Call 2: `sendMessage(chatId, remainingText)`. Returns `1003`.
- **Large Text Post**: 6,000 characters split into two text chunks (4,000 + 2,000 chars).
  - Call 1: `sendMessage(chatId, chunk1)`. Returns `2001`.
  - Call 2: `sendMessage(chatId, chunk2)`. Returns `2002`.

If Call 1 succeeds and Call 2 fails (e.g. network timeout, 500 error, 429 rate limit, or worker crash), the media group is **already published in the public channel**.
If the worker restarts from scratch on retry, the channel will receive a duplicate media group!

### 4.2 Durable State Persistence per Step
In accordance with AGENTS.md §23:
> *"If the first succeeds and the second fails, do not blindly restart everything. Store Telegram message IDs after each successful step. Retries should resume safely where technically possible. Never duplicate already-published messages just because the final step failed."*

The database schema provides:
```prisma
model PublicationJob {
  ...
  telegramMessageIds Json @default("[]") @map("telegram_message_ids")
}
```
`telegramMessageIds` stores an array of integer Telegram message IDs: `number[]`.

### 4.3 Step-by-Step Partial Resume Algorithm

```text
Worker Job Started (Attempt N)
    ↓
Load PublicationJob from DB:
  savedMessageIds = job.telegramMessageIds as number[] (e.g. [1001, 1002])
    ↓
Render canonical TelegramPayload:
  payload.messages: [Part 0 (media_group), Part 1 (text)]
    ↓
accumulatedCount = 0
For each Part in payload.messages:
    ↓
  expectedIds = (Part is media_group) ? Part.items.length : 1
    ↓
  Is savedMessageIds.length >= (accumulatedCount + expectedIds)?
         ├── YES ──> [SKIP THIS PART] (Already sent in previous attempt!)
         │
         └── NO  ──> [EXECUTE TELEGRAM API CALL]
                         ↓
                     Save newIds to array:
                     savedMessageIds.push(...newIds)
                         ↓
                     ATOMIC POSTGRESQL UPDATE:
                     UPDATE publication_jobs
                     SET telegram_message_ids = savedMessageIds
                     WHERE id = job.id
                         ↓
                     (Proceed to next Part)
    ↓
accumulatedCount += expectedIds
    ↓
All Parts Completed -> Update Post to PUBLISHED, Job to COMPLETED
```

### 4.4 Algorithmic Verification Trace
Let's trace the exact scenario from `tests/e2e/tier3-cross-feature.spec.ts` (test 3.3):
- **Post**: Media group (2 photos) + overflow text message.
- **Rendered Payload**:
  - `Part 0`: `type: 'media_group'`, `items: 2`. `expectedIds = 2`.
  - `Part 1`: `type: 'text'`. `expectedIds = 1`.
  - Total expected IDs: 3.

**Attempt 1**:
1. Initial DB state: `telegramMessageIds = []`. `savedMessageIds = []`.
2. `Part 0`:
   - `accumulatedCount = 0`, `expectedIds = 2`.
   - Check: `savedMessageIds.length (0) >= 2` -> `FALSE`.
   - API Call: `publisher.sendMediaGroup(chatId, media)`.
   - Telegram returns: `[1001, 1002]`.
   - `savedMessageIds` becomes `[1001, 1002]`.
   - **Immediately persist to DB**: `publication_jobs.telegram_message_ids = [1001, 1002]`.
   - `accumulatedCount` updated to 2.
3. `Part 1`:
   - `accumulatedCount = 2`, `expectedIds = 1`.
   - Check: `savedMessageIds.length (2) >= 3` -> `FALSE`.
   - API Call: `publisher.sendMessage(chatId, text)`.
   - **Network Failure occurs!** (e.g. `ETIMEDOUT: Connection lost`).
   - Worker catches error. BullMQ marks attempt 1 failed, schedules Attempt 2.
   - Note: In PostgreSQL, `PublicationJob.telegramMessageIds` remains `[1001, 1002]`.

**Attempt 2 (Retry)**:
1. Load DB state: `savedMessageIds = [1001, 1002]`.
2. `Part 0`:
   - `accumulatedCount = 0`, `expectedIds = 2`.
   - Check: `savedMessageIds.length (2) >= 2` -> **`TRUE`**.
   - **`Part 0` is SKIPPED!** No Telegram API call is made for the media group.
   - `accumulatedCount` updated to 2.
3. `Part 1`:
   - `accumulatedCount = 2`, `expectedIds = 1`.
   - Check: `savedMessageIds.length (2) >= 3` -> **`FALSE`**.
   - API Call: `publisher.sendMessage(chatId, text)`.
   - Telegram returns: `1003`.
   - `savedMessageIds` becomes `[1001, 1002, 1003]`.
   - **Immediately persist to DB**: `publication_jobs.telegram_message_ids = [1001, 1002, 1003]`.
   - `accumulatedCount` updated to 3.
4. Loop completes successfully.
   - Post status updated to `PUBLISHED`, `publishedAt = new Date()`.
   - `PublicationJob.status = COMPLETED`.
   - Audit log recorded with `telegramMessageIds: [1001, 1002, 1003]`.
   - Result: **Zero duplicate messages in Telegram channel!** Exactly matches Tier 3 E2E test.

---

## 5. Editorial Notifications Architecture

### 5.1 Decoupled Event-Driven Flow (AGENTS.md §27, tasks.md §24)
Notifications are strictly side effects of domain events. In accordance with AGENTS.md §27:
- Business transactions do NOT invoke Telegram messaging APIs directly.
- The publishing worker and domain services publish events via `DomainEventBus`.
- `NotificationService` subscribes to these events and executes dispatches.
- If sending a notification fails (e.g. user blocked bot), the core database state and publication status remain unaffected.

```text
Worker Event (PostPublishedEvent / PostPublicationFailedEvent)
    ↓
DomainEventBus.publish(event)
    ↓
NotificationService (RxJS Subscription)
    ↓
Lookup Recipient Users & Channels in DB
    ↓
Deliver Notification / Log Delivery
```

### 5.2 Event Definitions & Delivery Rules
1. **Publication Success (`PostPublishedEvent`)**:
   - Triggered when all message parts are published and post status becomes `PUBLISHED`.
   - **Recipient**: Post Author.
   - **Payload**:
     ```ts
     new PostPublishedEvent(
       post.id,
       post.channelId,
       post.authorId,
       postTitle,
       sentMessageIds,
     )
     ```
   - **Message Format**:
     ```text
     🚀 Пост успешно опубликован в канале!

     Заголовок: {postTitle}
     ```
   - **Metadata**: Details record `{ telegramMessageIds: sentMessageIds }`.

2. **Publication Terminal Failure (`PostPublicationFailedEvent`)**:
   - Triggered when retries are exhausted (`attempts >= maxAttempts`) or upon a permanent error.
   - Post status becomes `PUBLISH_FAILED`.
   - **Recipients**:
     - All active channel `EDITOR`s.
     - The post `AUTHOR`.
   - **Payload**:
     ```ts
     new PostPublicationFailedEvent(
       post.id,
       post.channelId,
       post.authorId,
       postTitle,
       attempts,
       errorMessage,
     )
     ```
   - **Message Format for Editors**:
     ```text
     🚨 ОШИБКА ПУБЛИКАЦИИ ПОСТА!

     Заголовок: {postTitle}
     Попыток: {attempts}
     Причина: {errorMessage}

     Используйте меню управления для повторной публикации.
     ```
   - **Action Button / Follow-up**: Posts in `PUBLISH_FAILED` expose the button `🔁 Повторить публикацию` to permit manual re-enqueueing (F-36, AGENTS.md §10).

3. **Scheduled Publication Alert (`PostScheduledEvent`)**:
   - Triggered when post transitions `APPROVED -> SCHEDULED`.
   - **Recipient**: Post Author.
   - **Message Format**:
     ```text
     🕒 Пост запланирован на публикацию

     Заголовок: {postTitle}
     Время: {scheduledAt in channel timezone}
     ```

4. **Autosave Silent Rule (F-40, tasks.md §24)**:
   - Routine draft autosaves (`autosaveStep`) must **never** emit any notification to authors or editors. The existing test suite explicitly verifies this rule in `tests/mocks/mock-notification-service.ts`.

---

## 6. Contracts, Interfaces & DTO Specifications

### 6.1 DTOs (`src/modules/scheduling/dto/` & `src/modules/publishing/dto/`)

```ts
import { IsUUID, IsInt, Min, IsNotEmpty, IsOptional, IsString, IsBoolean } from 'class-validator';

export class SchedulePostDto {
  @IsUUID()
  postId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /**
   * Publication datetime string in channel timezone (e.g. '21.09.2026 18:30')
   * or ISO 8601 string or Date object.
   */
  @IsNotEmpty()
  scheduledAt!: string | Date;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class CancelScheduleDto {
  @IsUUID()
  postId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /**
   * If true, transitions post back to APPROVED instead of CANCELLED.
   * Default: false (transitions to CANCELLED per AGENTS.md §10).
   */
  @IsOptional()
  @IsBoolean()
  returnToApproved?: boolean;
}

export class EnqueuePublishDto {
  @IsUUID()
  postId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

### 6.2 BullMQ Queue Job Data (`PublicationJobData`)

```ts
export interface PublicationJobData {
  /** UUID of the publication_jobs table record */
  publicationJobId: string;
  postId: string;
  postVersion: number;
  channelId: string;
  actorId: string;
  isScheduled: boolean;
}
```

### 6.3 Preflight Result Interfaces

```ts
import { Post, Channel, PostTemplate, PostMedia } from '@prisma/client';
import { TelegramPayload } from '../rendering/interfaces/telegram-payload.interface';

export interface Stage1PreflightResult {
  isValid: boolean;
  post: Post;
  channel: Channel;
  template: PostTemplate;
  media: PostMedia[];
  renderedPayload: TelegramPayload;
}

export interface Stage2PreflightResult {
  isValid: boolean;
  post: Post;
  channel: Channel;
  template: PostTemplate;
  media: PostMedia[];
  renderedPayload: TelegramPayload;
  isRetry: boolean;
  persistedMessageIds: number[];
}
```

### 6.4 Schedule Result Interface

```ts
import { Post, PublicationJob } from '@prisma/client';

export interface SchedulePostResult {
  post: Post;
  publicationJob: PublicationJob;
  scheduledAtUtc: Date;
  delayMs: number;
}
```

---

## 7. Step-by-Step Implementation Roadmap for the Worker

This roadmap specifies the ordered build sequence for Milestone 4 builders:

```text
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Module Scaffolding & Shared Enums / Queue Setup    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Phase 2: PreflightService (Stage 1 & Stage 2 Validation)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Phase 3: SchedulingService (Timezone, Delayed Job, Cancel)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Phase 4: PublishingService (Immediate Enqueue, Idempotency) │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Phase 5: PublishingWorker (Stage 2 Preflight, Resume Loop)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Phase 6: Unit & E2E Verification (34/34 Tests Passing)      │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Module Scaffolding & Queue Wiring
- Create `src/modules/scheduling/`:
  - `dto/schedule-post.dto.ts`
  - `dto/cancel-schedule.dto.ts`
  - `scheduling.module.ts` (imports `QueueModule`, `PrismaModule`, `PostsModule`, `ChannelsModule`, `AuditModule`, `LoggerModule`)
- Create `src/modules/publishing/`:
  - `dto/enqueue-publish.dto.ts`
  - `interfaces/publication-job-data.interface.ts`
  - `publishing.module.ts` (imports `BullModule.registerQueue({ name: PUBLICATION_QUEUE_NAME })`, `RenderingModule`, `TemplatesModule`, `AuditModule`, `NotificationsModule`)

### Phase 2: PreflightService Implementation
- Implement `validateStage1(postId, channelId, actorId)`:
  - Check post `APPROVED`, `deletedAt === null`.
  - Check channel active.
  - Check `ChannelPermission.PUBLISH_POST`.
  - Validate content against template schema via `TemplatesService.validatePostContent`.
  - Verify media invariants (count 2-10 for groups, valid file IDs).
  - Dry-run `TelegramRenderer.render`.
- Implement `validateStage2(jobData)`:
  - Fresh load with relations.
  - Verify post not deleted and status in `[APPROVED, SCHEDULED, PUBLISHING]`.
  - Verify channel active.
  - Query bot channel rights (`can_post_messages`).
  - Render fresh payload.

### Phase 3: SchedulingService Implementation
- Implement `schedulePost(dto, actorId)`:
  - Parse date in channel timezone via `parseAndValidateScheduledDate`.
  - Execute Stage 1 preflight.
  - Transition post `APPROVED -> SCHEDULED` via `PostWorkflowService` (OCC increment).
  - Create `PublicationJob` in DB (`idempotencyKey: publish:${id}:${version}`).
  - Add delayed BullMQ job (`delay = scheduledAt - Date.now()`, `jobId = publicationJob.id`).
- Implement `cancelSchedule(dto, actorId)`:
  - Check `ChannelPermission.CANCEL_SCHEDULE`.
  - Remove BullMQ delayed job.
  - Update `PublicationJob.status = CANCELLED`.
  - Transition post `SCHEDULED -> CANCELLED` via `PostWorkflowService`.

### Phase 4: PublishingService Implementation
- Implement `enqueuePublish(dto, actorId)`:
  - Execute Stage 1 preflight.
  - Compute idempotency key: `publish:${post.id}:${post.version}`.
  - Atomic DB check/create for `PublicationJob` (prevent duplicates on repeated clicks).
  - Add immediate BullMQ job (`delay = 0`).

### Phase 5: PublishingWorker Implementation
- Implement `@Processor(PUBLICATION_QUEUE_NAME) class PublishingWorker extends WorkerHost`:
  - Worker process method:
    1. Extract `PublicationJobData`.
    2. Execute Stage 2 Preflight (`validateStage2`).
    3. If post status not yet `PUBLISHING`, transition to `PUBLISHING` (OCC increment, audit log).
    4. Fetch `savedMessageIds` from `PublicationJob.telegramMessageIds`.
    5. Execute multi-part publication loop:
       - Skip parts whose expected message IDs are already in `savedMessageIds`.
       - Execute Telegram API call for unsent part.
       - Append `newIds` to `savedMessageIds`.
       - Atomically update `publication_jobs.telegram_message_ids = savedMessageIds` in PostgreSQL.
    6. On completion:
       - Update post to `PUBLISHED` (`publishedAt = new Date()`).
       - Update `PublicationJob.status = COMPLETED`.
       - Audit log `published`.
       - Publish `PostPublishedEvent` to `DomainEventBus`.
    7. On catch:
       - If retryable (`publisher.isRetryable(err)`) and `attempts < maxAttempts`:
         Update job error message, re-throw to trigger BullMQ exponential backoff.
       - If permanent or retries exhausted:
         Update post to `PUBLISH_FAILED`, update job to `FAILED`, audit log `publication_failed`, publish `PostPublicationFailedEvent`.

### Phase 6: Verification & Testing Gates
- **Unit Tests**:
  - `scheduling.service.spec.ts`: Test future date parsing, past date rejection, delayed job delay computation, cancel schedule queue removal.
  - `preflight.service.spec.ts`: Test Stage 1 invalid template rejection, media group bounds check, Stage 2 soft-delete rejection, cancelled schedule abort.
  - `publishing.worker.spec.ts`: Test partial publication resume on mock transient 500 error, ensuring message 1 is never re-sent.
- **E2E Tests**:
  - Run `node --experimental-strip-types tests/e2e/run-all-e2e.ts`.
  - Ensure all 34 tests in Tiers 1-4 pass with 100% success rate.

---

## 8. Conclusion
The proposed architecture provides a completely unified, deterministic, and idempotent publishing pipeline for Milestone 4. By coupling timezone-aware scheduling, two-stage preflight validation, and database-persisted partial publication resumption, the system prevents duplicate posts, eliminates unverified channel dispatches, and provides resilient recovery under network and process failures.
