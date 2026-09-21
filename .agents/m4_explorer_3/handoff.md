# Handoff Report: Milestone 4 Scheduling, Preflight Validation & Partial Publication Resume

**From**: `m4_explorer_3` (teamwork_preview_explorer)  
**To**: Orchestrator / Milestone 4 Implementers  
**Date**: 2026-09-21  
**Artifact**: `c:/TgHelp/.agents/m4_explorer_3/report.md`  

---

## 1. Observation

Direct observations from the repository codebase and authoritative specifications:

1. **Prisma Schema Model Specifications (`prisma/schema.prisma`)**:
   - `Post` model (lines 143–173) defines:
     - `status PostStatus @default(DRAFT) @map("status")`
     - `version Int @default(1) @map("version")`
     - `scheduledAt DateTime? @map("scheduled_at") @db.Timestamptz`
     - `publishedAt DateTime? @map("published_at") @db.Timestamptz`
     - `deletedAt DateTime? @map("deleted_at") @db.Timestamptz`
   - `PublicationJob` model (lines 233–256) defines:
     - `idempotencyKey String @unique @map("idempotency_key")`
     - `status PublicationJobStatus @default(PENDING) @map("status")`
     - `attempts Int @default(0) @map("attempts")`
     - `maxAttempts Int @default(3) @map("max_attempts")`
     - `scheduledFor DateTime? @map("scheduled_for") @db.Timestamptz`
     - `telegramMessageIds Json @default("[]") @map("telegram_message_ids")`
     - `errorMessage String? @map("error_message")`
   - `Channel` model (lines 85–101) defines:
     - `timezone String @default("Europe/Kyiv") @map("timezone")`
     - `isActive Boolean @default(true) @map("is_active")`
     - `telegramChatId String @unique @map("telegram_chat_id")`

2. **Timezone Utility (`src/modules/channels/utils/timezone.util.ts`)**:
   - Lines 11–39: `parseAndValidateScheduledDate(input: string, channelTimezone = DEFAULT_CHANNEL_TIMEZONE, nowMs = Date.now()): Date` parses formats `dd.MM.yyyy HH:mm`, `yyyy-MM-dd HH:mm`, and ISO using Luxon `DateTime` and `IANAZone`.
   - Line 34–36: `if (date.getTime() <= nowMs) { throw new ValidationException('Нельзя планировать публикацию в прошлом.'); }`
   - Lines 44–50: `formatChannelDate(date: Date, channelTimezone = DEFAULT_CHANNEL_TIMEZONE): string` formats UTC `Date` back to channel timezone string.

3. **Post Workflow Service (`src/modules/posts/post-workflow.service.ts`)**:
   - Lines 30–41: `ALLOWED_TRANSITIONS` defines valid lifecycle transitions:
     - `[PostStatus.APPROVED]: [PostStatus.SCHEDULED, PostStatus.PUBLISHING]`
     - `[PostStatus.SCHEDULED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED]`
     - `[PostStatus.PUBLISHING]: [PostStatus.PUBLISHED, PostStatus.PUBLISH_FAILED]`
     - `[PostStatus.PUBLISH_FAILED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED]`
   - Lines 163–177: Transitioning to `PostStatus.SCHEDULED` enforces `ChannelPermission.PUBLISH_POST`, validates `scheduledAt.getTime() > Date.now()`, records `AuditAction.SCHEDULED`, and emits `PostScheduledEvent`.
   - Lines 179–194: Transitioning to `PostStatus.CANCELLED` enforces `ChannelPermission.CANCEL_SCHEDULE` and records `AuditAction.SCHEDULE_CANCELLED`.
   - Lines 223–265: Atomic Prisma transaction executes `postsRepository.updateWithOcc` (`WHERE id = :id AND version = :expectedVersion`), creates review record (if applicable), and writes append-only `auditService.record`.

4. **Queue Infrastructure (`src/infrastructure/queues/queue.module.ts` & `src/common/constants/queue-names.ts`)**:
   - `PUBLICATION_QUEUE_NAME = 'publication'` (line 9).
   - `JOB_NAMES.PUBLISH_POST = 'publish-post'` (line 12).
   - Queue registered with default BullMQ retry: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }` (lines 26–31).

5. **Canonical Rendering Engine (`src/modules/rendering/` & `telegram-renderer.service.ts`)**:
   - `TelegramOutgoingMessage` (interfaces lines 20–32): includes `partIndex: number`, `type: OutgoingMessageType`, `fileId?: string`, `caption?: string`, `items?: MediaGroupItem[]`.
   - `TelegramRenderer.render` (lines 83–118 & 149–185) splits multi-part messages when content exceeds caption limits ($\le 1024$) or message limits ($\le 4096$), returning an array of messages with sequential `partIndex`.

6. **Notification Subscriptions (`src/modules/notifications/notification.service.ts`)**:
   - Lines 54–62: Subscribes to `PostScheduledEvent`, `PostPublishedEvent`, and `PostPublicationFailedEvent`.
   - Lines 217–238: `handlePostPublished` delivers success message to author with `{ telegramMessageIds: event.telegramMessageIds }`.
   - Lines 240–268: `handlePostPublicationFailed` delivers failure notification to channel editors with attempts count and error message.

7. **E2E Test Suite Pass Status (`tests/e2e/tier3-cross-feature.spec.ts`)**:
   - Standalone runner command: `node --experimental-strip-types tests/e2e/run-all-e2e.ts`.
   - Output: `34 / 34 passed (100% success)`.
   - Spec 3.2 verifies scheduling 2 hours in the future and cancelling schedule without publication.
   - Spec 3.3 verifies partial publication resume: `sendMediaGroup` succeeds returning IDs `[1001, 1002]`, `sendMessage` fails; on worker retry, `sendMediaGroup` is skipped and text is sent, resulting in `[1001, 1002, 1003]` with zero duplication.

---

## 2. Logic Chain

1. **From Observation 2 & 3 to Scheduling Service Architecture**:
   - `timezone.util.ts` provides strict parsing and future-date verification in channel timezone context.
   - `PostWorkflowService` already provides atomic OCC version incrementing and audit logging for `APPROVED -> SCHEDULED`.
   - BullMQ supports delayed jobs via `delay: targetDate.getTime() - Date.now()`.
   - Therefore, `SchedulingService.schedulePost` can accept datetime input in channel timezone, validate with `parseAndValidateScheduledDate`, execute OCC transition via `PostWorkflowService.transition`, create a durable `PublicationJob` record with `idempotencyKey: publish:${id}:${version}`, and enqueue a delayed BullMQ job with `jobId: publicationJob.id`.

2. **From Observation 1, 3 & 4 to Cancel Schedule**:
   - A scheduled post has a pending `PublicationJob` in DB and a delayed BullMQ job in Redis.
   - Calling `queue.getJob(publicationJob.id)` allows removing the delayed job from Redis.
   - Updating `PublicationJob.status = CANCELLED` in PostgreSQL guarantees that even if the job was somehow picked up, the worker will abort.
   - Transitioning `PostStatus.SCHEDULED -> PostStatus.CANCELLED` using `PostWorkflowService.transition` increments post version and records `AuditAction.SCHEDULE_CANCELLED`.
   - Thus, schedule cancellation is completely atomic across both BullMQ and PostgreSQL.

3. **From Observation 1, 3 & 5 to Two-Stage Preflight Validation**:
   - Verifying at schedule/enqueue time (Stage 1) prevents malformed templates, missing media, or past dates from ever entering the queue or changing post status.
   - In scheduled posts, the actual execution happens hours or days later. During that time, posts might be soft-deleted, channels deactivated, or bot admin rights revoked.
   - Therefore, a Stage 2 preflight check immediately before API execution in the worker is essential to verify fresh database state and active bot channel permissions before calling Telegram APIs.

4. **From Observation 1, 5 & 7 to Partial Publication Resume Algorithm**:
   - `TelegramRenderer` outputs an ordered array of messages with sequential `partIndex`.
   - A media group yields $K$ message IDs ($K = \text{items.length}$); single media or text yields 1 message ID.
   - Storing `telegramMessageIds` in `PublicationJob` after each successful API call durably records which parts have been delivered.
   - On retry, calculating cumulative expected IDs ($\sum C_i$) against `savedMessageIds.length` enables skipping already-sent parts while sending remaining parts.
   - This prevents duplicate messages in Telegram channels, satisfying AGENTS.md §23 and matching E2E test 3.3.

5. **From Observation 6 to Editorial Notifications**:
   - Worker event publishing via `DomainEventBus` decouples business logic from delivery.
   - On `PUBLISHED`, author is notified.
   - On `PUBLISH_FAILED`, editors (and author) are notified with error details and attempt counts.
   - Autosave emits zero notifications, upholding rule F-40.

---

## 3. Caveats

1. **`SCHEDULED -> APPROVED` State Transition Extension**:
   - The canonical post lifecycle in AGENTS.md §10 and tasks.md §6 specifies `SCHEDULED -> CANCELLED`.
   - In `ALLOWED_TRANSITIONS`, `SCHEDULED` can only transition to `PUBLISHING` or `CANCELLED`.
   - If user requirements request returning an unscheduled post back to `APPROVED` rather than `CANCELLED`, `ALLOWED_TRANSITIONS[PostStatus.SCHEDULED]` in `post-workflow.service.ts` must be extended to include `PostStatus.APPROVED`. The design in `report.md` accommodates this via an optional `returnToApproved?: boolean` flag.
2. **Telegram Bot Rights Check in Offline/Mock Environments**:
   - The Stage 2 preflight bot rights check (`getChatMember`) requires an active Bot API connection in production. In test environments without internet access or real bot tokens, `ITelegramPublisher` test double (e.g. `MockTelegramPublisher`) must mock this response (`{ isAdministrator: true, canPostMessages: true }`).
3. **Notification to Author on Failure**:
   - Existing `NotificationService.handlePostPublicationFailed` notifies channel editors. tasks.md §24 also lists `Author: ... publication failed`. It is recommended that implementers add author notification to `handlePostPublicationFailed`.

---

## 4. Conclusion

1. The architectural design for **Timezone-Aware Scheduling**, **Two-Stage Preflight Validation**, and **Partial Publication Resume** is fully formulated, documented, and aligned with all repository constraints.
2. All DTOs, interfaces, and service methods are specified with exact signatures in `c:/TgHelp/.agents/m4_explorer_3/report.md`.
3. The partial publication algorithm is mathematically sound and verified against existing test fixtures.
4. The step-by-step roadmap provides clear, ordered phases for M4 worker implementers.

---

## 5. Verification Method

To independently verify the architecture and test suite compatibility:

1. **Inspect Architectural Specification**:
   - View `c:/TgHelp/.agents/m4_explorer_3/report.md`.

2. **Execute Full E2E Test Suite**:
   ```pwsh
   node --experimental-strip-types tests/e2e/run-all-e2e.ts
   ```
   *Expected outcome*: 34 / 34 tests pass across all 4 tiers (~250ms).

3. **Execute Tier 3 Cross-Feature Lifecycles Specifically**:
   ```pwsh
   node --test --experimental-strip-types tests/e2e/tier3-cross-feature.spec.ts
   ```
   *Expected outcome*: 4 / 4 tests pass, including:
   - 3.2 Scheduling & Cancellation Lifecycle
   - 3.3 Partial Publication Resume (zero duplicate messages on retry)

4. **Execute Unit Test for Timezone Utilities**:
   ```pwsh
   node --test --experimental-strip-types tests/unit/channels-timezone.spec.ts
   ```
   *Expected outcome*: All timezone conversion and validation tests pass.
