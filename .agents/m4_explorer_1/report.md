# Architectural Investigation & Design Report: Publishing Queue & BullMQ Worker (Milestone 4)

**Document**: `report.md`  
**Author**: `m4_explorer_1` (Teamwork Explorer)  
**Date**: 2026-09-21  
**Target Milestone**: M4 — Publishing Engine & BullMQ Idempotency  
**Authoritative References**: `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`, `c:/TgHelp/.agents/PROJECT.md`, `c:/TgHelp/AGENTS.md` (§20, §21, §22, §23, §28, §30), `c:/TgHelp/tasks.md` (§20, §21, §22, §23, §26), `c:/TgHelp/.agents/TEST_READY.md`

---

## 1. Executive Summary

Milestone 4 delivers the core asynchronous publication engine of the Telegram Content Publisher Bot. In strict adherence to **AGENTS.md §3 & §20**, Telegram callback handlers must never invoke external Telegram publication APIs directly. All publishing actions must transition through a decoupled, queue-backed architecture managed by **BullMQ** on Redis, backed by durable PostgreSQL state persistence, and enforced by unique database-level idempotency keys.

This report establishes the complete structural design for:
1. **BullMQ Queue & Worker Architecture**: Distributed queue configuration (`src/infrastructure/queues/queue.module.ts`), serialized job payloads (`PublishJobData`), worker concurrency, exponential backoff, stalled job detection, and graceful shutdown hooks (`onModuleDestroy`).
2. **Database-Enforced Idempotency Key**: Immutable key format `publish:{postId}:{postVersion}` with database uniqueness constraint on `PublicationJob.idempotencyKey` preventing duplicate publications even under rapid double-clicks, network retries, or worker restarts.
3. **State Machine & OCC Integration**: Flawless coordination with `PostWorkflowService` and `PostsRepository.updateWithOcc()`, transitioning `APPROVED/SCHEDULED -> PUBLISHING -> PUBLISHED` (or `PUBLISH_FAILED` upon retry exhaustion).
4. **PublishingService Enqueueing**: Atomic verification, channel authorization, preflight validation, DB job provisioning, and BullMQ queue dispatch.
5. **Partial Publication Resume**: Granular tracking and incremental database persistence of `telegramMessageIds` across multi-message split deliveries (media group + overflow text).
6. **Telegram Publisher Abstraction**: Isolated `ITelegramPublisher` interface with intelligent transient error classification (429 rate limits, 5xx server errors, network timeouts).

---

## 2. Existing Codebase & Infrastructure State

An in-depth inspection of the current repository revealed the following foundational assets and contracts:

| Component | Path | Status | Key Characteristics |
|---|---|---|---|
| **Queue Module** | `src/infrastructure/queues/queue.module.ts` | Complete | `BullModule.forRootAsync` configured with Redis URL, `maxRetriesPerRequest: null`, queue `PUBLICATION_QUEUE_NAME` (`publication`), default 3 attempts with 2000ms exponential backoff. |
| **Worker Bootstrap** | `src/worker.main.ts` & `src/worker.module.ts` | Complete | Independent worker entry point with shutdown hook registration and SIGTERM/SIGINT listeners. |
| **Prisma Schema** | `prisma/schema.prisma` | Complete | Model `PublicationJob` with `@unique @map("idempotency_key")`, `attempts`, `maxAttempts`, `status`, `telegramMessageIds Json`, and relations to `Post` and `Channel`. |
| **Workflow Service** | `src/modules/posts/post-workflow.service.ts` | Complete | `PostWorkflowService.transition()` manages state transitions with OCC checks (`version + 1`), review records, append-only audit logging, and decoupled domain event dispatch. |
| **Canonical Renderer** | `src/modules/rendering/telegram-renderer.service.ts` | Complete | `TelegramRenderer.render()` converts `Post + Template + Media` into `TelegramPayload` containing ordered `TelegramOutgoingMessage[]` with `partIndex`. |
| **E2E Test Suites** | `tests/e2e/*.spec.ts` | Complete (34/34 passing) | Authoritative tests specifying behavior for idempotency (Tier 1.5), rate limits & retries (Tier 2.6), partial publish resume (Tier 3.3), and outage recovery with manual retry (Tier 4.3). |

---

## 3. BullMQ Queue & Worker Architecture

### 3.1 Queue Definition (`src/infrastructure/queues/`)

The queue is registered in `src/infrastructure/queues/queue.module.ts` under constant name `PUBLICATION_QUEUE_NAME = 'publication'`.

```ts
// Existing Queue Module Registration:
BullModule.registerQueue({
  name: PUBLICATION_QUEUE_NAME,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // Attempt 1: immediate; Attempt 2: +2s; Attempt 3: +4s
    },
    removeOnComplete: {
      age: 3600 * 24, // 24 hours retention
      count: 1000,
    },
    removeOnFail: {
      age: 3600 * 24 * 7, // 7 days retention for manual investigation
      count: 5000,
    },
  },
})
```

### 3.2 Job Payload Specification (`PublishJobData`)

The job payload must be purely serializable JSON (no `BigInt`, `Date`, or cyclical class instances).

```ts
// src/modules/publishing/interfaces/publish-job-data.interface.ts
export interface PublishJobData {
  /** Post primary key */
  postId: string;
  /** Expected post version at time of enqueueing (for OCC check & idempotency) */
  postVersion: number;
  /** Target channel identifier */
  channelId: string;
  /** User/Actor ID who initiated publication */
  actorId: string;
  /** ISO timestamp when job was enqueued */
  enqueuedAt?: string;
}
```

### 3.3 Worker Processor Design (`PublishingProcessor`)

The worker processor is declared using `@nestjs/bullmq` decorators:

```ts
@Processor(PUBLICATION_QUEUE_NAME, {
  concurrency: 5,
  lockDuration: 30000, // 30s lock duration before considered stalled
  stalledInterval: 30000, // check for stalled jobs every 30s
  maxStalledCount: 2, // max recoveries before failing stalled job
  limiter: {
    max: 20, // Telegram global safety limit: max 20 messages per second
    duration: 1000,
  },
})
export class PublishingProcessor extends WorkerHost implements OnModuleDestroy {
  // Implementation details below
}
```

#### Key Worker Configuration Rationale:
- **`concurrency: 5`**: Sufficient for editorial workloads while preventing burst flooding that triggers Telegram channel rate limits (1 message/second per channel).
- **`lockDuration: 30000` (30s)**: Generous window for large media group uploads without falsely declaring active jobs stalled.
- **`limiter: { max: 20, duration: 1000 }`**: Built-in BullMQ token bucket preventing the worker from exceeding Telegram's 30 msg/sec global API throttle.
- **Graceful Shutdown (`onModuleDestroy`)**:
  ```ts
  async onModuleDestroy(): Promise<void> {
    this.logger.log({ event: 'publishing_worker_closing' });
    if (this.worker) {
      await this.worker.close(); // Waits for current jobs to finish processing
    }
  }
  ```
  When the process receives `SIGTERM` or `SIGINT`, NestJS calls `onModuleDestroy()`, allowing in-flight publication HTTP requests to complete and update database state cleanly rather than severing mid-flight.

---

## 4. Database-Enforced Idempotency Key & Atomic Creation/Claim

### 4.1 Key Format & Mechanics (Rule F-31, AGENTS.md §21)

The canonical idempotency key is defined as:
$$\text{idempotencyKey} = \text{"publish:"} + \text{postId} + \text{":"} + \text{postVersion}$$

#### Why Version Inclusion is Essential:
1. **Double-Click Defense**: Two rapid clicks on the same approved post (e.g. at version 3) both produce `publish:post-123:3`. The second request hits the unique constraint and returns the existing job.
2. **Revision / Edit Isolation**: If an editor requests revisions on a post and the author updates it, the version increments to 4. When re-approved, publication produces `publish:post-123:4`, distinct from any prior attempt.
3. **Manual Retry of Failed Posts (Rule F-36, Scenario 4.3)**: When a post exhausts retries and transitions to `PUBLISH_FAILED`, its version is incremented (e.g. from 3 to 4). When the editor clicks `🔁 Повторить публикацию`, the new job receives `publish:post-123:4`. It does not collide with the failed job `publish:post-123:3`.

### 4.2 Database Uniqueness Constraint

In `prisma/schema.prisma`:
```prisma
model PublicationJob {
  id                 String               @id @default(uuid())
  postId             String               @map("post_id")
  postVersion        Int                  @map("post_version")
  idempotencyKey     String               @unique @map("idempotency_key")
  channelId          String               @map("channel_id")
  status             PublicationJobStatus @default(PENDING) @map("status")
  attempts           Int                  @default(0) @map("attempts")
  maxAttempts        Int                  @default(3) @map("max_attempts")
  scheduledFor       DateTime?            @map("scheduled_for") @db.Timestamptz
  telegramMessageIds Json                 @default("[]") @map("telegram_message_ids")
  errorMessage       String?              @map("error_message")
  createdAt          DateTime             @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime             @updatedAt @map("updated_at") @db.Timestamptz
  ...
}
```

The database unique constraint `@@unique([idempotencyKey])` is the **authoritative single source of truth** (AGENTS.md §21). Redis locks and BullMQ job ID deduplication are supplementary optimizations.

### 4.3 Atomic Creation & Claim Flow

```text
[Enqueue Request]
       ↓
Check if PublicationJob exists with idempotencyKey
       ├── Exists? ──────────> Return existing job (Idempotent 200)
       └── Not found:
             ↓
       Try Prisma create PublicationJob (status: PENDING)
             ├── Catch P2002 (Concurrent Race)? ──> Return existing job
             └── Created:
                   ↓
                   Add to BullMQ with jobId = idempotencyKey
                   Return new job
```

```text
[Worker Processing]
       ↓
Fetch PublicationJob from DB by idempotencyKey
       ├── Status == COMPLETED? ──> Early exit (No-Op, already published)
       ├── Status == FAILED?    ──> Early exit (Terminal, already failed)
       └── Status == PENDING or RUNNING:
             ↓
       Atomic DB update: status = RUNNING, attempts = attempts + 1
             ↓
       Proceed with State Machine transition & Telegram delivery
```

---

## 5. State Machine Integration (`PostWorkflowService`)

All status transitions must strictly invoke `PostWorkflowService.transition()` with OCC version checks (**AGENTS.md §10 & §13**). Casually updating `prisma.post.update({ data: { status: ... } })` is strictly prohibited.

### 5.1 Lifecycle Status Transitions

```text
                   [ APPROVED / SCHEDULED / PUBLISH_FAILED ]
                                      │
                                      ▼ (Worker Starts)
                                [ PUBLISHING ]
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼ (Success)                           ▼ (Retry Exhaustion / Permanent Error)
             [ PUBLISHED ]                        [ PUBLISH_FAILED ]
```

### 5.2 Transition Guards & Idempotent Worker Retries

| Step | Current Post Status | Target Status | Trigger | PostWorkflowService Action | Version Increment |
|---|---|---|---|---|:---:|
| **Start Processing** | `APPROVED`, `SCHEDULED`, or `PUBLISH_FAILED` | `PUBLISHING` | Worker takes job | `PostAction.START_PUBLISHING` | $+1$ |
| **Worker Retry Attempt** | `PUBLISHING` | `PUBLISHING` | Retry 2 or 3 | **GUARD**: Do NOT call transition! Post is already `PUBLISHING`. Calling `PUBLISHING -> PUBLISHING` violates `ALLOWED_TRANSITIONS`. | $0$ |
| **Publishing Succeeded** | `PUBLISHING` | `PUBLISHED` | All parts sent | `PostAction.MARK_PUBLISHED` | $+1$ |
| **Retry Exhaustion** | `PUBLISHING` | `PUBLISH_FAILED` | Max attempts reached or unrecoverable error | `PostAction.MARK_PUBLISH_FAILED` | $+1$ |

#### Critical Guard Code:
```ts
// If post is already PUBLISHING (e.g. BullMQ retry attempt 2 or 3), skip start transition
if (post.status !== PostStatus.PUBLISHING) {
  post = await this.postWorkflowService.transition({
    postId: post.id,
    expectedVersion: post.version,
    targetStatus: PostStatus.PUBLISHING,
    actorId: jobData.actorId,
  });
}
```

---

## 6. Partial Publication Resume (Rule F-34, AGENTS.md §23)

### 6.1 The Problem
A single logical publication often contains multiple Telegram messages (e.g., a media group followed by overflow text > 1024 characters). If `sendMediaGroup` succeeds but `sendMessage` fails due to a network timeout, a naive retry would re-send the media group, causing duplicate posts in the Telegram channel.

### 6.2 Partial Publication Solution
1. `PublicationJob.telegramMessageIds` (`Json`, default `[]`) stores an ordered array of Telegram message IDs.
2. After each message part succeeds, the worker **immediately persists** the returned message ID(s) to PostgreSQL.
3. Upon retry, the worker examines `PublicationJob.telegramMessageIds` and determines which parts have already been delivered.
4. Already-delivered parts are skipped; only the remaining parts are dispatched.

```ts
// Message Part Execution Loop
const sentMessageIds: number[] = Array.isArray(pubJob.telegramMessageIds)
  ? (pubJob.telegramMessageIds as number[])
  : [];

for (const message of payload.messages) {
  // Check if this part has already been sent
  // For single messages: 1 ID per part; for media group: items.length IDs
  const isPartAlreadySent = this.isMessagePartSent(message, sentMessageIds, payload.messages);
  if (isPartAlreadySent) {
    this.logger.log({ event: 'part_skipped_already_sent', partIndex: message.partIndex });
    continue;
  }

  // Dispatch to Telegram API
  const newIds = await this.dispatchTelegramPart(channel.telegramChatId, message);
  sentMessageIds.push(...newIds);

  // Immediately persist progress to database (short transaction)
  await this.prisma.publicationJob.update({
    where: { id: pubJob.id },
    data: {
      telegramMessageIds: sentMessageIds,
      updatedAt: new Date(),
    },
  });
}
```

---

## 7. Error Handling, Exponential Backoff & Retry Exhaustion

### 7.1 Error Categorization

| Error Category | Examples | Retryable? | Worker Action |
|---|---|:---:|---|
| **Rate Limit** | HTTP 429 `Too Many Requests`, `retry_after: 5` | **YES** | Read `retry_after`, log warning, update DB job attempts, throw error so BullMQ delays retry. |
| **Transient Server Error** | HTTP 500, 502, 504 Gateway Timeout | **YES** | Log warning, update DB job attempts, throw error for BullMQ exponential backoff. |
| **Network Failure** | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND` | **YES** | Log warning, update DB job attempts, throw error for BullMQ backoff. |
| **Permanent Client Error** | HTTP 400 Bad Request, invalid HTML, empty chat ID | **NO** | Throw `UnrecoverableError` immediately. Transition post to `PUBLISH_FAILED`. |
| **Authorization Error** | HTTP 403 Forbidden: bot blocked or kicked from channel | **NO** | Throw `UnrecoverableError` immediately. Transition post to `PUBLISH_FAILED`. |

### 7.2 BullMQ vs Database Retry Lifecycle

BullMQ configured with `attempts: 3` and `backoff: { type: 'exponential', delay: 2000 }`:
- **Attempt 1 (Immediate)**: If fails with retryable error:
  - Worker updates `PublicationJob`: `attempts = 1`, `errorMessage = error.message`.
  - Audit log: `publication_attempt_failed`.
  - Post remains in `PUBLISHING`. Zero notifications sent.
  - BullMQ schedules retry after $2000 \times 2^0 = 2000\text{ms}$ (2 seconds).
- **Attempt 2 (+2s)**: If fails:
  - Worker updates `PublicationJob`: `attempts = 2`, `errorMessage = error.message`.
  - BullMQ schedules retry after $2000 \times 2^1 = 4000\text{ms}$ (4 seconds).
- **Attempt 3 (+4s, Final Attempt)**: If fails:
  - `job.attemptsMade + 1 >= job.opts.attempts` $\implies$ **Retry Exhaustion**.
  - Worker updates `PublicationJob`: `status = FAILED`, `errorMessage = error.message`.
  - Worker calls `postWorkflowService.transition(..., targetStatus: PostStatus.PUBLISH_FAILED)`.
  - Domain event `PostPublicationFailedEvent` notifies the Editor (**Rule F-35, tasks.md §24**).
  - Worker throws `UnrecoverableError` to mark BullMQ job permanently failed.

---

## 8. Telegram API Abstraction (`ITelegramPublisher`)

To strictly satisfy **AGENTS.md §48**, direct Telegram API calls must be wrapped behind an abstraction in `src/infrastructure/telegram-api/`.

### 8.1 Interface Definition

```ts
// src/infrastructure/telegram-api/interfaces/telegram-publisher.interface.ts
export interface OutgoingMedia {
  type: 'photo' | 'video' | 'document' | 'animation';
  fileId: string;
  caption?: string;
}

export interface SendMessageOptions {
  parseMode?: 'HTML';
  disableWebPagePreview?: boolean;
}

export interface ITelegramPublisher {
  /** Sends a media group (2-10 items) to a Telegram channel */
  sendMediaGroup(chatId: string, media: OutgoingMedia[]): Promise<number[]>;

  /** Sends a text message to a Telegram channel */
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<number>;

  /** Sends a single photo message */
  sendPhoto(chatId: string, fileId: string, caption?: string, options?: SendMessageOptions): Promise<number>;

  /** Sends a single video message */
  sendVideo(chatId: string, fileId: string, caption?: string, options?: SendMessageOptions): Promise<number>;

  /** Sends a single document message */
  sendDocument(chatId: string, fileId: string, caption?: string, options?: SendMessageOptions): Promise<number>;

  /** Sends a single animation message */
  sendAnimation(chatId: string, fileId: string, caption?: string, options?: SendMessageOptions): Promise<number>;

  /** Determines if an error is transient and safe to retry */
  isRetryable(error: Error): boolean;

  /** Extracts retry delay in seconds if provided by Telegram (e.g. from 429) */
  getRetryDelay(error: Error): number | null;
}

export const TELEGRAM_PUBLISHER_TOKEN = Symbol('ITelegramPublisher');
```

### 8.2 TelegramPublisherService Implementation Details
- Uses `grammy`'s `Bot` API: `new Bot(botToken).api`.
- Normalizes Telegram API errors into `TelegramApiError` with `statusCode`, `retryAfter`, and `isPermanent` flags.
- Validates constraints before invoking grammY (`chatId` non-empty, media count between 2 and 10, caption length $\le 1024$, message text $\le 4096$).

---

## 9. PublishingService Enqueueing Flow

### 9.1 Method Signature
```ts
async enqueuePublish(postId: string, actorId: string): Promise<PublicationJob>
```

### 9.2 Execution Algorithm
```ts
async enqueuePublish(postId: string, actorId: string): Promise<PublicationJob> {
  // 1. Fetch Post with template and media
  const post = await this.postsRepository.findById(postId);
  if (!post || post.deletedAt !== null) {
    throw new PostNotFoundException(postId);
  }

  // 2. Validate Post Status
  const publishableStatuses: PostStatus[] = [
    PostStatus.APPROVED,
    PostStatus.SCHEDULED,
    PostStatus.PUBLISH_FAILED,
  ];
  if (!publishableStatuses.includes(post.status)) {
    throw new InvalidPostStateTransitionException(
      post.status,
      PostStatus.PUBLISHING,
    );
  }

  // 3. Evaluate Actor Permission
  await this.permissionService.enforceChannelPermission(
    actorId,
    post.channelId,
    ChannelPermission.PUBLISH_POST,
  );

  // 4. Preflight Channel Validation
  const channel = await this.prisma.channel.findUnique({
    where: { id: post.channelId },
  });
  if (!channel || !channel.isActive) {
    throw new ValidationException(`Target channel "${post.channelId}" is inactive or missing.`);
  }

  // 5. Preflight Render Validation
  await this.telegramRenderer.render(post, post.template, post.media);

  // 6. Compute Idempotency Key
  const idempotencyKey = `publish:${post.id}:${post.version}`;

  // 7. Check for existing PublicationJob in DB
  const existingJob = await this.prisma.publicationJob.findUnique({
    where: { idempotencyKey },
  });
  if (existingJob) {
    return existingJob; // Idempotent return without duplicate enqueue
  }

  // 8. Provision PublicationJob in DB (handle concurrent race gracefully)
  let publicationJob: PublicationJob;
  try {
    publicationJob = await this.prisma.publicationJob.create({
      data: {
        postId: post.id,
        postVersion: post.version,
        idempotencyKey,
        channelId: post.channelId,
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        telegramMessageIds: [],
      },
    });
  } catch (err: unknown) {
    // Catch P2002 unique constraint race condition
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return this.prisma.publicationJob.findUniqueOrThrow({
        where: { idempotencyKey },
      });
    }
    throw err;
  }

  // 9. Add Job to BullMQ Queue
  await this.publicationQueue.add(
    JOB_NAMES.PUBLISH_POST,
    {
      postId: post.id,
      postVersion: post.version,
      channelId: post.channelId,
      actorId,
      enqueuedAt: new Date().toISOString(),
    },
    {
      jobId: idempotencyKey, // Queue-level deduplication
    },
  );

  // 10. Audit Log Job Creation
  await this.auditService.record({
    action: AuditAction.PUBLICATION_JOB_CREATED,
    entityType: 'publication_job',
    entityId: publicationJob.id,
    actorId,
    payload: {
      postId: post.id,
      postVersion: post.version,
      idempotencyKey,
    },
  });

  return publicationJob;
}
```

---

## 10. Complete Step-by-Step Implementation Roadmap

| Step | Scope | Target Files to Create/Update | Description |
|:---:|---|---|---|
| **1** | **Telegram API Abstraction** | `src/infrastructure/telegram-api/` | Define `ITelegramPublisher`, implement `TelegramPublisherService` with grammY Bot API integration and error classifier, register `TelegramApiModule`. |
| **2** | **Publishing DTOs & Interfaces** | `src/modules/publishing/interfaces/` | Create `PublishJobData`, `PublicationResult`, `EnqueuePublishDto`. |
| **3** | **Publishing Service** | `src/modules/publishing/publishing.service.ts` | Implement `PublishingService.enqueuePublish()` with preflight checks, idempotency creation, OCC guards, and queue dispatch. |
| **4** | **Publishing Processor (Worker)** | `src/modules/publishing/publishing.processor.ts` | Implement `@Processor` extending `WorkerHost`: preflight checks, state transition to `PUBLISHING`, partial resume loop, error backoff handling, retry exhaustion to `PUBLISH_FAILED`, and graceful shutdown (`OnModuleDestroy`). |
| **5** | **Publishing Module Wiring** | `src/modules/publishing/publishing.module.ts` | Bundle `PublishingService`, `PublishingProcessor`, import `QueueModule`, `PostsModule`, `RenderingModule`, `TelegramApiModule`. Register in `AppModule` and `WorkerModule`. |
| **6** | **Unit & Integration Verification** | `tests/unit/`, `tests/integration/` | Write unit tests for `PublishingService` and `PublishingProcessor` verifying idempotency, retry exhaustion, OCC conflict handling, and partial resume. |
| **7** | **Authoritative E2E Verification** | Run `npm run test:e2e` | Verify that all 34 tests in Tiers 1-4 continue to pass with 100% success rate. |
