# Functional Specification & Feature Inventory: Telegram Content Publisher Bot MVP

**Author:** `spec_miner_1` (Teamwork Specification Miner)  
**Date:** 2026-09-21  
**Status:** Approved Specification  
**Authoritative Sources:**
- `tasks.md` (Product & Technical Specification)
- `AGENTS.md` (Engineering Rules, Invariants & Architectural Directives)
- `ORIGINAL_REQUEST.md` (User Acceptance Criteria & Prompt)

---

## 1. Executive Summary & Core Architectural Contract

The Telegram Content Publisher Bot is a Telegram-based editorial publishing system designed for newsrooms, editorial teams, and content managers. It functions as an internal editorial control room inside Telegram, enabling authors, editors, and administrators to create, review, schedule, and publish posts to Telegram channels with guaranteed idempotency, auditability, and resilience against system crashes.

### Key Architectural Invariants
1. **Telegram as Transport Layer Only:** Telegram handlers do not contain business logic. Handlers only parse incoming Telegram updates, extract caller identity, validate input schemas, call application/domain services, and render responses.
2. **PostgreSQL as Single Source of Truth:** In-memory sessions or Redis caches are never the source of truth for editorial state. All draft updates, steps, statuses, media attachments, and jobs are persisted in PostgreSQL.
3. **Optimistic Concurrency Control (OCC):** Posts carry a monotonically increasing `version INTEGER` column. Concurrent updates must supply `expected_version` and fail explicitly on conflicts.
4. **Idempotent Queue-Based Publishing:** Telegram publishing calls are never executed within Telegram callback handlers. An application service verifies permissions, preflight checks the post, inserts an idempotent `publication_jobs` record, and enqueues a BullMQ job. Workers execute the actual publication, handle rate limits, manage retries with exponential backoff, and record Telegram message IDs.
5. **Canonical Rendering Pipeline:** A single renderer (`TelegramRenderer`) produces the structured `TelegramPayload` for both user preview and final channel publication. Formatting and layout cannot diverge between preview and reality.

---

## 2. User Roles and Permissions Model

### 2.1. Dual-Tier Authorization Architecture
Authorization is strictly evaluated on the server at two levels: **System Role** and **Channel Membership**. Under no circumstances is a user authorized by Telegram `username`, `first_name`, or display name; authentication relies exclusively on Telegram `id` (represented as `bigint`).

```
+-------------------------------------------------------------+
|                      users table                            |
|  telegram_id (BIGINT, UNIQUE), system_role (SUPER_ADMIN|USER)|
+-------------------------------------------------------------+
                               |
                               | 1:N
                               v
+-------------------------------------------------------------+
|                  channel_members table                      |
|  user_id -> users.id, channel_id -> channels.id             |
|  role: EDITOR | AUTHOR | VIEWER                             |
|  can_publish: BOOLEAN                                       |
|  can_approve: BOOLEAN                                       |
+-------------------------------------------------------------+
```

### 2.2. Role Hierarchy & Matrix

| Capability / Action | SUPER_ADMIN (System) | EDITOR (Channel) | AUTHOR (Channel) | VIEWER (Channel) | Unregistered / Inactive |
|---|:---:|:---:|:---:|:---:|:---:|
| Run `/start` & Access Bot | Allowed | Allowed | Allowed | Allowed | Denied immediately |
| Manage Users (Add/Remove) | Full | Denied | Denied | Denied | Denied |
| Manage Channels & Settings | Full | Denied | Denied | Denied | Denied |
| Manage Post Templates | Full | Denied | Denied | Denied | Denied |
| View Global Audit Logs | Full | Denied | Denied | Denied | Denied |
| View Channel Materials/Posts | All channels | Assigned channels | Own drafts/materials | Read-only view | Denied |
| Create New Post Draft | Allowed | Allowed | Allowed | Denied | Denied |
| Edit Own Drafts | Allowed | Allowed | Allowed | Denied | Denied |
| Edit Others' Drafts/Posts | Allowed | Allowed (in channel) | Denied | Denied | Denied |
| Submit Post for Review | Allowed | Allowed | Allowed | Denied | Denied |
| Approve Post | Allowed | Allowed (if `can_approve`) | Denied | Denied | Denied |
| Request Revision (Feedback) | Allowed | Allowed | Denied | Denied | Denied |
| Reject Post | Allowed | Allowed | Denied | Denied | Denied |
| Direct Publish Now | Allowed | Allowed (if `can_publish`) | Denied (unless explicit `can_publish`) | Denied | Denied |
| Schedule Publication | Allowed | Allowed (if `can_publish`) | Denied (unless explicit `can_publish`) | Denied | Denied |
| Cancel Scheduled Post | Allowed | Allowed | Denied | Denied | Denied |
| Delete Draft (Soft Delete) | Allowed | Allowed | Own drafts only | Denied | Denied |
| Retry Failed Publication | Allowed | Allowed | Denied | Denied | Denied |

### 2.3. Permission Validation Rules
- **Server-Side Verification:** Hiding an inline button or menu entry does not constitute security. Every callback query or message action re-validates the user's active status, channel membership, and explicit flags (`can_publish`, `can_approve`).
- **Super Admin Bypass:** Users with `system_role = SUPER_ADMIN` bypass channel membership requirements for editorial operations.
- **Deactivated Users:** If `users.is_active = FALSE`, all operations return an authorization error and terminate immediately.

---

## 3. Channels Model & Timezone Handling

### 3.1. Channel Entity Attributes
The system supports multi-channel architecture while delivering full MVP capabilities for 1 Production Channel and 1 Staging/Test Channel.

- `id`: UUID (Primary Key)
- `telegram_chat_id`: `BIGINT` or `VARCHAR` (Unique Telegram Chat/Channel ID, e.g. `-1001234567890`)
- `title`: Channel Display Name
- `username`: Public username (e.g. `@my_news_channel`), optional/nullable
- `timezone`: IANA Timezone string (Default: `Europe/Kyiv`)
- `publication_mode`: Enum/String (`DIRECT`, `MODERATED`, `TEST`)
- `is_active`: Boolean flag indicating whether the channel is enabled for publication
- `created_at` / `updated_at`: Timestamps

### 3.2. Channel Wizard Logic
- When a user starts post creation, the bot queries channels where the user has membership with `AUTHOR` or `EDITOR` role (or all active channels for `SUPER_ADMIN`).
- If the user has access to **exactly 1 channel**, Step 1 (Channel Selection) is automatically skipped and the single channel is assigned.
- If the user has access to multiple channels, an inline selection list is displayed.

### 3.3. Timezone Semantics
- **Channel-Centric Input:** All user-facing dates and times (e.g. `21.09.2026 18:30`) are interpreted strictly within the selected channel's configured timezone (`timezone`, default `Europe/Kyiv`).
- **Durable UTC Storage:** Times are converted to UTC and stored in PostgreSQL using `scheduled_at TIMESTAMPTZ`.
- **Clock Independence:** The application never relies on local server system clocks or `new Date().getHours()` without explicit timezone conversion.
- **Past Date Validation:** Scheduled timestamps must be validated to be in the future relative to the channel's local time and current UTC time.

---

## 4. Post State Machine Lifecycle

### 4.1. Formal State Definitions
The system implements a strict, 10-state finite state machine (FSM). Casual status updates (e.g. direct Prisma update queries) are prohibited; all transitions pass through a dedicated `PostWorkflowService`.

1. `DRAFT`: Initial authoring state. The post is being created or edited.
2. `PENDING_REVIEW`: The post has been submitted by the author and is awaiting editor evaluation.
3. `APPROVED`: The post has passed editorial review and is authorized for scheduling or immediate publishing.
4. `NEEDS_REVISION`: The editor sent the post back to the author with mandatory feedback comments.
5. `REJECTED`: The post has been permanently or administratively declined by an editor.
6. `SCHEDULED`: The post is approved and assigned an absolute future publication timestamp (`scheduled_at`).
7. `PUBLISHING`: A publication job has been dequeued by BullMQ and is currently actively executing Telegram API calls.
8. `PUBLISHED`: All messages making up the post have been successfully posted to the Telegram channel.
9. `PUBLISH_FAILED`: Publication failed after exhausting all retry attempts, or suffered a non-recoverable error.
10. `CANCELLED`: A scheduled or failed post has been cancelled by an editor or admin.

### 4.2. State Transition Matrix

```
       +------------+
       |   DRAFT    |<-----------------------+
       +------------+                        |
             |                               |
             | submit_for_review             |
             v                               |
    +------------------+                     |
    |  PENDING_REVIEW  |                     |
    +------------------+                     |
      |        |       \                     |
approve   reject        request_revision     |
      |        |         \                   |
      v        v          v                  |
+----------+ +--------+ +----------------+   |
| APPROVED | |REJECTED| | NEEDS_REVISION |---+ (resubmit)
+----------+ +--------+ +----------------+
   |      \
publish_now schedule
   |        \
   |         v
   |    +-----------+
   |    | SCHEDULED |----+
   |    +-----------+    |
   |      |              |
   |      | due_time     | cancel
   |      v              |
   +--->+------------+   |
        | PUBLISHING |   |
        +------------+   |
          |        \     |
    success         fail |
          |        (exhaust)
          v          v   |
   +-----------+   +----------------+
   | PUBLISHED |   | PUBLISH_FAILED |
   +-----------+   +----------------+
                     |            |
                retry_publish   cancel
                     |            |
                     v            v
               +------------+ +-----------+
               | PUBLISHING | | CANCELLED |
               +------------+ +-----------+
```

| Current Status | Allowed Action / Trigger | Next Status | Actor / Guard | Side Effects & Audit Event |
|---|---|---|---|---|
| `DRAFT` | `submit_for_review` | `PENDING_REVIEW` | Author, Editor, Admin; post content valid | Audit `submitted`; Notify channel Editors |
| `PENDING_REVIEW` | `approve` | `APPROVED` | Editor, Admin (`can_approve`) | Audit `approved`; Notify Author |
| `PENDING_REVIEW` | `request_revision` | `NEEDS_REVISION` | Editor, Admin; **Comment mandatory** | Insert `post_reviews`; Audit `revision_requested`; Notify Author with feedback |
| `PENDING_REVIEW` | `reject` | `REJECTED` | Editor, Admin | Audit `rejected`; Notify Author |
| `NEEDS_REVISION` | `submit_for_review` | `PENDING_REVIEW` | Author, Editor; edits made | Audit `submitted`; Notify channel Editors |
| `APPROVED` | `publish_now` | `PUBLISHING` | Editor, Admin, Author (`can_publish`) | Create `publication_jobs`; Enqueue BullMQ job; Audit `publication_started` |
| `APPROVED` | `schedule` | `SCHEDULED` | Editor, Admin, Author (`can_publish`); `scheduled_at > NOW` | Enqueue delayed job / schedule; Audit `scheduled`; Notify Author |
| `SCHEDULED` | `due_trigger` | `PUBLISHING` | Scheduler worker when `scheduled_at` reached | Enqueue active BullMQ job; Audit `publication_started` |
| `SCHEDULED` | `cancel_schedule` | `CANCELLED` | Editor, Admin | Remove job from queue; Audit `schedule_cancelled` |
| `PUBLISHING` | `worker_success` | `PUBLISHED` | Publication Worker; all parts sent | Save `telegram_message_ids`, `published_at`; Audit `published`; Notify Author & Editor |
| `PUBLISHING` | `worker_exhausted` | `PUBLISH_FAILED` | Publication Worker; retries exhausted | Record error in `publication_jobs`; Audit `publication_failed`; Notify Editor |
| `PUBLISH_FAILED` | `retry_publish` | `PUBLISHING` | Editor, Admin | Reset attempts, re-enqueue BullMQ job; Audit `publication_started` |
| `PUBLISH_FAILED` | `cancel_publish` | `CANCELLED` | Editor, Admin | Audit `publication_cancelled` |

### 4.3. Transition Integrity Guarantees
- **Atomic Operations:** Status transitions, review records, and audit log writes must execute inside a single PostgreSQL transaction (`prisma.$transaction`).
- **No Direct Mutation:** Direct status assignments via Prisma or SQL without going through `PostWorkflowService` violate repository rules.
- **OCC Version Check:** When performing a transition, the query must verify `WHERE id = :id AND version = :expected_version` and increment `version`.

---

## 5. Post Creation Wizard Flow & Autosave Architecture

### 5.1. Wizard UX Philosophy
- Users are never expected to memorize slash-commands or internal state names.
- Interactions are guided by conversational inline keyboards and structured text input prompts.
- Clear contextual breadcrumbs show current draft title, step number, and channel.

### 5.2. Sequential Step-by-Step Flow

```
[Step 1: Channel Selection]
      | (Skipped if user has access to only 1 channel)
      v
[Step 2: Template Selection] (Long-read, Announcement, Photo, Video, News, Free Format)
      |
      v (Creates DRAFT record in PostgreSQL, status=DRAFT, version=1)
[Step 3: Template Fields Input]
      | -> Step 3.1: Title / Header (Autosaved to DB)
      | -> Step 3.2: Main Body / Rich Text (Autosaved to DB)
      | -> Step 3.N: Template-specific fields (Autosaved to DB)
      v
[Step 4: Media Upload]
      | -> Upload Photo / Video / Document / Media Group
      | -> Immediately persisted into post_media table
      v
[Step 5: Metadata Input]
      | -> Rubric, Tags (#tag1 #tag2), CTA, Link, Comment to Editor, Priority
      | -> Autosaved to DB
      v
[Step 6: Preview & Action Control Panel]
      | -> Canonical TelegramRenderer generates exact channel mockup
      +-> Action Buttons: Edit, Media, Schedule, Submit, Publish, Delete
```

### 5.3. Autosave Mechanics
- **Step-Level Persistence:** Draft state is written to PostgreSQL immediately after the user submits each step:
  - Step 2 completion: `INSERT INTO posts (status='DRAFT', template_id, channel_id, author_id, version=1, ...)`
  - Field completion: `UPDATE posts SET content_json = :updatedJson, version = version + 1 WHERE id = :id AND version = :v`
  - Media upload: `INSERT INTO post_media (post_id, telegram_file_id, media_type, ...)`
  - Metadata change: `UPDATE posts SET metadata_json = :metadata, version = version + 1 ...`
- **Zero In-Memory Dependence:** If the application process crashes or restarts, or if the user leaves Telegram for hours, the draft remains intact in PostgreSQL.
- **Draft Resumption:** Authors access ongoing work via the `📝 Мои материалы` menu item, which lists drafts with status `DRAFT` or `NEEDS_REVISION`.
- **Silent Autosave:** Autosave operations must NOT dispatch Telegram notifications to editors.

### 5.4. Granular Field-Level Editing (Post-Wizard)
Once a draft is created, the user does not need to re-enter the entire wizard sequentially to modify content. The `✏️ Редактировать` screen presents a modular field selector:
- 📌 Заголовок (Title)
- 📄 Основной текст (Body)
- 🖼 Медиа (Media Management)
- 🔗 Ссылки (Links / URL buttons)
- 🏷 Теги (Tags)
- 📣 CTA (Call-to-Action)
- ⏰ Время публикации (Publication Time)
- 💬 Комментарий редактору (Editorial Comment)

Selecting a field prompts only for that specific value, updates PostgreSQL via OCC, and redisplays the updated preview.

---

## 6. Post Templates Engine

### 6.1. Dynamic Template Definition
Templates decouple Telegram UI handlers from fixed post layouts. Templates are stored in the `post_templates` table:

```json
{
  "id": "tpl-uuid-001",
  "key": "longread",
  "name": "📝 Лонг-рид",
  "description": "Развёрнутая аналитическая статья с заголовком, подзаголовками и медиа",
  "version": 1,
  "is_active": true,
  "supported_media_types": ["photo", "video", "media_group"],
  "schema_json": {
    "fields": [
      {
        "key": "title",
        "label": "Заголовок публикации",
        "type": "text",
        "required": true,
        "maxLength": 256,
        "hint": "Введите броский заголовок статьи"
      },
      {
        "key": "lead",
        "label": "Лид (краткое введение)",
        "type": "text",
        "required": false,
        "maxLength": 500,
        "hint": "1-2 предложения, раскрывающие суть"
      },
      {
        "key": "body",
        "label": "Основной текст",
        "type": "rich_text",
        "required": true,
        "maxLength": 3500,
        "hint": "Поддерживается Telegram HTML (жирный, курсив, цитаты, код)"
      }
    ]
  },
  "render_config": {
    "layout": "{{title}}\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}",
    "header_tag": "b",
    "tags_prefix": "\n\n",
    "cta_button_mode": "inline_url"
  }
}
```

### 6.2. MVP Predefined Templates
1. **📝 Лонг-рид (Long-read):** Title, Lead, Rich Text Body, Media (photo/video/media group).
2. **📢 Анонс (Announcement):** Event title, Date/Time, Location/Platform, Description, CTA link.
3. **🖼 Фото (Photo Post):** Photo asset, descriptive caption (up to 1024 chars HTML).
4. **🎬 Видео (Video Post):** Video asset, title, descriptive caption (up to 1024 chars HTML).
5. **📰 Новость (News Flash):** Headline, Bullet points/details, Source citation link.
6. **✍️ Свободный формат (Free Format):** Freeform text with optional media attachments.

### 6.3. Template Versioning & Immutability
- Edits to a template must not retroactively mutate already published posts or corrupt in-flight drafts.
- Posts store `template_id` and the specific snapshot/version of template metadata or render configuration used during creation.

---

## 7. Media Types, Formatting & Payload Construction

### 7.1. Supported Media Types & Storage
Media is stored in the `post_media` table and references Telegram's CDN using persistent identifiers:
- `telegram_file_id`: Unique identifier for fast sending without re-upload.
- `telegram_file_unique_id`: Global immutable identifier used for deduplication.
- `media_type`: Enum (`PHOTO`, `VIDEO`, `DOCUMENT`, `ANIMATION`).
- `file_name`, `mime_type`, `file_size`: Metadata for auditing and UI display.
- `caption`: Optional per-item caption.
- `sort_order`: Sequential integer ordering items for media groups.

### 7.2. Critical Media Handling Rules
- **Document vs. Video Distinction:** Telegram clients often send videos without compression as `document`. The system must detect video MIME types (`video/mp4`, etc.) or preserve the original transport type without crashing.
- **Single Media vs. Media Group:**
  - Single media (photo, video, animation, document): Carries up to 1024 characters of HTML caption.
  - Media Group (`sendMediaGroup`): Contains between 2 and 10 items (photos and/or videos). Under Telegram API constraints, only one caption is attached to the media group (on the first item). Documents and animations cannot be mixed into standard photo/video media groups.
- **Telegram Limits Centralization (`telegram-limits.ts`):**
  - Text message maximum length: 4,096 characters.
  - Media caption maximum length: 1,024 characters.
  - Media group size: Minimum 2, Maximum 10 items.
  - Callback data payload: 64 bytes maximum.

### 7.3. HTML Sanitization
Only official Telegram HTML tags are permitted:
`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`.
- All user input is sanitized before persistence and before queue dispatch.
- Raw `<script>`, `<style>`, `<div>`, etc., are stripped or escaped.
- Special XML characters (`&`, `<`, `>`) outside of valid tags are strictly escaped to `&amp;`, `&lt;`, `&gt;`.
- Broken or unclosed HTML tags must result in a user-friendly validation error rather than a runtime Telegram API 400 rejection.

### 7.4. Canonical Rendering Pipeline & TelegramPayload
The renderer produces a canonical `TelegramPayload` structure:

```ts
interface TelegramOutgoingMessage {
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;               // HTML for text message
  caption?: string;            // HTML for media caption
  fileId?: string;
  items?: Array<{ type: 'photo' | 'video'; fileId: string; caption?: string }>;
  replyMarkup?: InlineKeyboardMarkup;
}

interface TelegramPayload {
  postId: string;
  channelId: string;
  messages: TelegramOutgoingMessage[];
}
```

#### Split Publication Logic (Media Group + Long Text)
When a post features a media group (or photo/video) AND an extensive article body exceeding 1,024 characters:
1. Message 1: `media_group` (or photo/video) sent with a short summary or title caption (<= 1024 chars).
2. Message 2: `text` message containing the full body text (<= 4096 chars).
Both messages are published sequentially as a single logical publication.

---

## 8. Editorial Review & Revision Workflow

```
[Author submits draft]
         |
         v
Status -> PENDING_REVIEW
Notification dispatched to channel Editors:
"📝 Новый материал на согласовании:
 Канал: Tech News | Автор: @ivan | Шаблон: Лонг-рид | Приоритет: Высокий
 Комментарий: Проверьте цитату в третьем абзаце"
         |
         v
[Editor opens Review Card via '✅ На согласовании']
--------------------------------------------------
[Full Rendered Preview]
--------------------------------------------------
[Actions]:
[ ✅ Одобрить ]          -> Post -> APPROVED; Author notified
[ ✏️ Редактировать ]     -> Editor modifies text/media in-place
[ ↩️ На доработку ]      -> Prompts Editor for MANDATORY comment
                            Post -> NEEDS_REVISION
                            Author notified with comment
[ ❌ Отклонить ]         -> Post -> REJECTED; Author notified
```

### 8.1. Mandatory Feedback on Revision Requests
- An editor **cannot** send a post to `NEEDS_REVISION` without entering an explanatory comment.
- The comment is persisted to `post_reviews` (`post_id`, `reviewer_id`, `status='NEEDS_REVISION'`, `comment`).
- The author receives a notification:  
  *"↩️ Публикация «{title}» возвращена на доработку.\nКомментарий редактора: {comment}"*.

### 8.2. Author Resubmission
- The author opens the post from `📝 Мои материалы`.
- The editor's feedback note is prominently displayed above the field editor.
- After making corrections, the author clicks `✅ Отправить на согласование`.
- The post transitions: `NEEDS_REVISION -> PENDING_REVIEW`.
- Editors receive a notification that the revised draft has been resubmitted.

---

## 9. Scheduling, Idempotency & Publication Engine

### 9.1. Publication Execution Architecture

```
[User clicks "🚀 Опубликовать" / Scheduled Time Arrives]
                         |
                         v
              [Application Service]
              1. Validate User Permission (can_publish)
              2. Preflight Validation (channel active, bot admin, payload valid)
              3. Check Post Status (APPROVED)
              4. Generate Idempotency Key: `publish:{post_id}:{post_version}`
              5. Insert DB record into `publication_jobs`
              6. Transition Post status: APPROVED -> PUBLISHING
                         |
                         v
               [BullMQ Redis Queue]
                         |
                         v
              [BullMQ Worker Process]
              1. Check DB `publication_jobs` record status & OCC version
              2. Call TelegramPublisher abstraction
              3. Execute messages sequentially:
                 - For each message in TelegramPayload:
                   a. Check if already in job.telegram_message_ids
                   b. If already sent, SKIP (partial publish safety)
                   c. Call Bot API (sendMediaGroup, sendMessage, etc.)
                   d. Append returned message_id to telegram_message_ids in DB
              4. Mark job COMPLETED in DB
              5. Transition Post status: PUBLISHING -> PUBLISHED
              6. Dispatched notifications to Author and Editor
```

### 9.2. Preflight Validation Checklist
Immediately before queueing and immediately before calling Telegram API:
1. Post exists, is not soft-deleted (`deleted_at IS NULL`).
2. Post status permits publishing (`APPROVED`, or `PUBLISH_FAILED` on retry).
3. Target channel exists, is active (`is_active = TRUE`), and has a valid `telegram_chat_id`.
4. Bot holds administrative rights in the target channel (`can_post_messages`).
5. All media `telegram_file_id` references are non-empty and well-formed.
6. Rendered HTML passes schema validation.

### 9.3. Idempotency & Concurrency Guarantees
- **Database-Level Unique Key:** `publication_jobs.idempotency_key` is declared with a `UNIQUE` database constraint.
  - Key format: `publish:{post_id}:{post_version}`
  - If a user rapidly taps "Publish" twice, the second transaction violates the unique constraint and is rejected immediately.
- **Worker Redelivery Safety:** If BullMQ redelivers a job due to a network glitch or worker restart, the worker queries `publication_jobs`. If status is already `COMPLETED`, the worker acknowledges the job and exits without repeating calls to Telegram.

### 9.4. Partial Publishing Fault Tolerance
When a logical post consists of multiple messages (e.g. `sendMediaGroup` followed by `sendMessage`):
- As each Telegram call succeeds, the returned Telegram message ID is appended to `publication_jobs.telegram_message_ids` inside PostgreSQL.
- If the first message succeeds and the second fails (e.g., temporary timeout), BullMQ retries the job.
- On retry, the worker inspects `telegram_message_ids`. It detects that Message 1 was already published and only executes Message 2.
- Under no circumstances does a retry duplicate already posted media or text in the Telegram channel.

### 9.5. Retries, Backoff & Failure Handling
- **BullMQ Retry Configuration:** 3 attempts with exponential backoff (e.g. initial delay 5s, exponential factor 2).
- **Error Classification:**
  - *Retryable Errors:* HTTP 429 (Rate Limit / Too Many Requests), HTTP 5xx, Network Socket Timeouts. When Telegram provides a `retry_after` parameter, the worker respects it.
  - *Permanent Errors:* HTTP 400 (Bad Request / Chat not found), HTTP 403 (Forbidden / Bot kicked or lacks post permission). Permanent errors fail immediately without pointless retries.
- **Exhaustion State (`PUBLISH_FAILED`):**
  - When retries are exhausted, the post status updates to `PUBLISH_FAILED`.
  - An audit log entry `publication_failed` is created with the exact error details.
  - Channel editors receive an alert: *"⚠️ Ошибка публикации поста «{title}»: {error_message}"*.
  - The review/post card offers two options:
    1. `🔁 Повторить публикацию` (re-triggers worker with new idempotency key).
    2. `🗑 Отменить публикацию` (transitions post to `CANCELLED`).

---

## 10. Audit Logging Specification

### 10.1. Append-Only Event Log
All significant domain actions are permanently recorded in the `audit_logs` table. Audit logs are append-only; updating or deleting audit records is strictly prohibited.

### 10.2. Mandatory Audit Event Types
1. `post_created`: Author initializes a new draft.
2. `post_updated`: Post title, body, or metadata modified.
3. `media_added`: Photo/video/document attached to draft.
4. `media_removed`: Media attachment removed from draft.
5. `submitted`: Post submitted for editorial review (`DRAFT -> PENDING_REVIEW`).
6. `approved`: Post approved by editor (`PENDING_REVIEW -> APPROVED`).
7. `revision_requested`: Editor requested changes (`PENDING_REVIEW -> NEEDS_REVISION`).
8. `rejected`: Editor declined post (`PENDING_REVIEW -> REJECTED`).
9. `scheduled`: Post scheduled for future time (`APPROVED -> SCHEDULED`).
10. `schedule_cancelled`: Post schedule revoked (`SCHEDULED -> CANCELLED`).
11. `publication_started`: Post handed to publishing queue (`APPROVED -> PUBLISHING`).
12. `published`: Post published to channel (`PUBLISHING -> PUBLISHED`).
13. `publication_failed`: Publication failed after retry exhaustion (`PUBLISHING -> PUBLISH_FAILED`).
14. `publication_cancelled`: Failed publication cancelled (`PUBLISH_FAILED -> CANCELLED`).
15. `user_added`: Admin created or registered a new user.
16. `permission_changed`: Admin altered system role or channel permissions.
17. `settings_changed`: System or channel settings modified.

### 10.3. Sensitive Data Sanitization
Audit payload JSON must be sanitized: tokens (`BOT_TOKEN`), database credentials, private keys, and passwords must never appear in audit logs.

---

## 11. Database Schema Specification (Prisma Models)

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
  APPROVED
  NEEDS_REVISION
  REJECTED
  SCHEDULED
  PUBLISHING
  PUBLISHED
  PUBLISH_FAILED
  CANCELLED
}

enum MediaType {
  PHOTO
  VIDEO
  DOCUMENT
  ANIMATION
}

enum PublicationJobStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
}

model User {
  id           String          @id @default(uuid())
  telegramId   BigInt          @unique @map("telegram_id")
  username     String?
  firstName    String?         @map("first_name")
  lastName     String?         @map("last_name")
  systemRole   SystemRole      @default(USER) @map("system_role")
  isActive     Boolean         @default(true) @map("is_active")
  createdAt    DateTime        @default(now()) @map("created_at")
  updatedAt    DateTime        @updatedAt @map("updated_at")

  memberships  ChannelMember[]
  posts        Post[]          @relation("AuthorPosts")
  reviews      PostReview[]
  auditLogs    AuditLog[]

  @@map("users")
}

model Channel {
  id              String          @id @default(uuid())
  telegramChatId  String          @unique @map("telegram_chat_id")
  title           String
  username        String?
  timezone        String          @default("Europe/Kyiv")
  publicationMode String          @default("DIRECT") @map("publication_mode")
  isActive        Boolean         @default(true) @map("is_active")
  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @updatedAt @map("updated_at")

  members         ChannelMember[]
  posts           Post[]
  publicationJobs PublicationJob[]

  @@map("channels")
}

model ChannelMember {
  id         String      @id @default(uuid())
  channelId  String      @map("channel_id")
  userId     String      @map("user_id")
  role       ChannelRole @default(AUTHOR)
  canPublish Boolean     @default(false) @map("can_publish")
  canApprove Boolean     @default(false) @map("can_approve")
  createdAt  DateTime    @default(now()) @map("created_at")
  updatedAt  DateTime    @updatedAt @map("updated_at")

  channel Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([channelId, userId])
  @@map("channel_members")
}

model PostTemplate {
  id                  String   @id @default(uuid())
  key                 String   @unique
  name                String
  description         String?
  schemaJson          Json     @map("schema_json")
  renderConfig        Json     @map("render_config")
  supportedMediaTypes Json     @map("supported_media_types")
  version             Int      @default(1)
  isActive            Boolean  @default(true) @map("is_active")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  posts Post[]

  @@map("post_templates")
}

model Post {
  id           String     @id @default(uuid())
  channelId    String     @map("channel_id")
  authorId     String     @map("author_id")
  templateId   String     @map("template_id")
  status       PostStatus @default(DRAFT)
  version      Int        @default(1)
  contentJson  Json       @default("{}") @map("content_json")
  metadataJson Json       @default("{}") @map("metadata_json")
  scheduledAt  DateTime?  @map("scheduled_at")
  publishedAt  DateTime?  @map("published_at")
  deletedAt    DateTime?  @map("deleted_at")
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")

  channel         Channel          @relation(fields: [channelId], references: [id])
  author          User             @relation("AuthorPosts", fields: [authorId], references: [id])
  template        PostTemplate     @relation(fields: [templateId], references: [id])
  media           PostMedia[]
  reviews         PostReview[]
  publicationJobs PublicationJob[]
  versions        PostVersion[]

  @@index([status])
  @@index([authorId])
  @@index([channelId])
  @@index([scheduledAt])
  @@map("posts")
}

model PostMedia {
  id                   String    @id @default(uuid())
  postId               String    @map("post_id")
  telegramFileId       String    @map("telegram_file_id")
  telegramFileUniqueId String    @map("telegram_file_unique_id")
  mediaType            MediaType @map("media_type")
  fileName             String?   @map("file_name")
  mimeType             String?   @map("mime_type")
  fileSize             BigInt?   @map("file_size")
  caption              String?
  sortOrder            Int       @default(0) @map("sort_order")
  createdAt            DateTime  @default(now()) @map("created_at")

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@map("post_media")
}

model PostReview {
  id         String     @id @default(uuid())
  postId     String     @map("post_id")
  reviewerId String     @map("reviewer_id")
  status     PostStatus
  comment    String?
  createdAt  DateTime   @default(now()) @map("created_at")

  post     Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  reviewer User @relation(fields: [reviewerId], references: [id])

  @@index([postId])
  @@map("post_reviews")
}

model PostVersion {
  id           String   @id @default(uuid())
  postId       String   @map("post_id")
  version      Int
  contentJson  Json     @map("content_json")
  renderedText String?  @map("rendered_text")
  changedBy    String   @map("changed_by")
  createdAt    DateTime @default(now()) @map("created_at")

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, version])
  @@map("post_versions")
}

model PublicationJob {
  id                 String               @id @default(uuid())
  postId             String               @map("post_id")
  postVersion        Int                  @map("post_version")
  idempotencyKey     String               @unique @map("idempotency_key")
  channelId          String               @map("channel_id")
  status             PublicationJobStatus @default(PENDING)
  attempts           Int                  @default(0)
  maxAttempts        Int                  @default(3) @map("max_attempts")
  scheduledFor       DateTime?            @map("scheduled_for")
  telegramMessageIds Json                 @default("[]") @map("telegram_message_ids")
  errorMessage       String?              @map("error_message")
  createdAt          DateTime             @default(now()) @map("created_at")
  updatedAt          DateTime             @updatedAt @map("updated_at")

  post    Post    @relation(fields: [postId], references: [id], onDelete: Cascade)
  channel Channel @relation(fields: [channelId], references: [id])

  @@index([status])
  @@index([scheduledFor])
  @@map("publication_jobs")
}

model AuditLog {
  id         String   @id @default(uuid())
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id")
  action     String
  actorId    String?  @map("actor_id")
  payload    Json     @default("{}")
  createdAt  DateTime @default(now()) @map("created_at")

  actor User? @relation(fields: [actorId], references: [id])

  @@index([entityType, entityId])
  @@index([actorId])
  @@map("audit_logs")
}
```

---

## 12. Complete Functional Feature Inventory

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Source Section |
|---|---|---|---|---|---|---|---|
| F-01 | Auth & RBAC | Telegram ID Auth | Authenticate incoming Telegram user using Telegram ID; verify existence and active flag. | Telegram `from.id` (bigint) | Authenticated user session / profile | Non-registered or inactive: reject with "У вас пока нет доступа..." | tasks.md §4, §7; AGENTS.md §8 |
| F-02 | Auth & RBAC | Role & Permission Check | Evaluate system role (`SUPER_ADMIN`, `USER`) and channel-level role (`EDITOR`, `AUTHOR`, `VIEWER`) plus flags (`can_publish`, `can_approve`). | `userId`, `channelId`, required permission | Permission grant or denial | Unauthorized action rejected with domain exception & user alert | tasks.md §4, §5; AGENTS.md §9 |
| F-03 | Auth & RBAC | Dynamic Role-Based Menu | Render tailored bot menu: Author menu (My Materials, Content Plan, Publications) vs Editor/Admin menu (Materials, Review Queue, Content Plan, Users, Settings). | User ID, permissions | Customized Telegram Reply/Inline Keyboard | Default fallback to minimal help menu | tasks.md §8 |
| F-04 | Channels | Multi-Channel Data Model | Support multiple channels in DB with individual chat ID, title, username, timezone, mode, and active state. | Channel DTO | Stored Channel Record | Unique constraint on `telegram_chat_id` enforced | tasks.md §3; AGENTS.md §30 |
| F-05 | Channels | Auto-Skip Single Channel | Automatically select target channel in post creation if user has access to exactly one channel. | List of accessible channels | Pre-selected channel ID | If 0 channels accessible: return error "Нет доступных каналов" | tasks.md §9 |
| F-06 | Channels | Timezone Conversion | Interpret user-entered publication datetime in channel's configured timezone (default `Europe/Kyiv`) and convert to UTC `TIMESTAMPTZ`. | Local datetime string (`DD.MM.YYYY HH:mm`), channel timezone | UTC `TIMESTAMPTZ` | Invalid format or past timestamp rejected with clear validation message | tasks.md §3, §19; AGENTS.md §24, §47 |
| F-07 | Wizard & Drafts | Channel Selection Step | Step 1 of post creation: Display buttons for authorized channels when multiple exist. | Button click / channel ID | Target channel assigned to draft | Non-accessible channel clicked: reject with permission error | tasks.md §9 |
| F-08 | Wizard & Drafts | Template Selection Step | Step 2: Choose post template (Long-read, Announcement, Photo, Video, News, Free Format). | Template key | New post draft in DB (`status=DRAFT`, `version=1`) | Inactive template rejected | tasks.md §9, §14 |
| F-09 | Wizard & Drafts | Sequential Field Input | Step 3: Prompt user sequentially for fields defined in template `schema_json`. | Field text message | Field saved to `posts.content_json` | Field validation error (length, required, HTML tags) displayed inline | tasks.md §9, §14; AGENTS.md §14 |
| F-10 | Wizard & Drafts | Step-by-Step Autosave | Persist draft data to PostgreSQL immediately after each step/field completion; zero in-memory dependence. | Completed field/step data | Updated DB post record | DB error reported to user; draft progress preserved up to last good step | tasks.md §9, §10; AGENTS.md §11, §12 |
| F-11 | Wizard & Drafts | Media Upload Handling | Step 4: Accept photo, video, document, animation, or media group; store Telegram `file_id` and metadata in `post_media`. | Telegram file object / media message | `post_media` rows created | Unsupported file type or size limit exceeded rejected | tasks.md §9, §18; AGENTS.md §19 |
| F-12 | Wizard & Drafts | Metadata Input | Step 5: Input rubric, tags, CTA, links, priority, comment to editor, and preferred schedule time. | Text messages / buttons | Saved to `posts.metadata_json` | Invalid URL or malformed tag rejected | tasks.md §9 |
| F-13 | Wizard & Drafts | Preview Rendering | Step 6: Render exact post preview using canonical `TelegramRenderer` with action buttons based on user permissions. | Post ID, Template, Media | Rendered Telegram preview message(s) + Action Keyboard | Rendering error caught and displayed cleanly | tasks.md §9, §15, §16; AGENTS.md §15, §16 |
| F-14 | Wizard & Drafts | Granular Field Editing | Allow editing individual fields (Title, Body, Media, Links, Tags, CTA, Schedule, Comment) without restarting the wizard. | Field selector button, new content | Updated post field + new version | Conflict error if version changed concurrently | tasks.md §11 |
| F-15 | Wizard & Drafts | Soft Delete Draft | Author or Editor can delete draft with mandatory confirmation; marks `deleted_at = NOW()`. | Post ID, confirmation callback | Post marked deleted | Already published or non-owned draft rejected | AGENTS.md §31, §54 |
| F-16 | OCC | Optimistic Concurrency Control | Ensure safe concurrent editing using `version INTEGER`; verify `WHERE id = :id AND version = :expected_version`. | Post ID, expected version, updated data | Updated row + incremented version | Version mismatch: return conflict error "Публикация была изменена другим пользователем" | tasks.md §12; AGENTS.md §13 |
| F-17 | Templates | Dynamic Schema & Validation | Validate field content against template `schema_json` (type, required, min/max length). | Field value, schema definition | Validation result (valid/invalid) | Descriptive validation error message returned to user | tasks.md §14; AGENTS.md §14 |
| F-18 | Templates | Canonical TelegramRenderer | Unified formatting engine converting Post + Template + Media into structured `TelegramPayload` for both preview and publishing. | Post, Template, Media entities | `TelegramPayload` with array of outgoing messages | Divergence between preview and publication eliminated | tasks.md §15, §16; AGENTS.md §15, §16 |
| F-19 | Formatting | HTML Sanitization | Sanitize and escape HTML before persistence; allow only Telegram supported tags (`b`, `i`, `u`, `s`, `code`, `pre`, `a`, `blockquote`). | User-entered rich text | Sanitized HTML string | Malformed tags escaped or flagged to user | tasks.md §17; AGENTS.md §17 |
| F-20 | Formatting | Multi-Message Payload Splitting | Split publications into multiple messages (e.g. Media Group with caption + separate Long Text) when exceeding Telegram limits. | Rendered text and media | Multi-message `TelegramPayload` | Payload validation failure if single message text exceeds 4096 | tasks.md §16; AGENTS.md §16 |
| F-21 | Media | Telegram file_id Reuse | Store and reuse Telegram `file_id` for publishing without re-downloading or re-uploading media files. | Uploaded media update | Stored `telegram_file_id` | Media re-upload prevented | tasks.md §18; AGENTS.md §19 |
| F-22 | Media | Document-as-Video Handling | Gracefully detect and handle video files sent by users as uncompressed documents. | Document message with video MIME | Media categorized appropriately | Format unrecognized: handle as generic document | tasks.md §18; AGENTS.md §19 |
| F-23 | Review | Submit for Review | Author submits draft; transitions status `DRAFT -> PENDING_REVIEW`; notifies channel editors. | Post ID, Author ID | Post status `PENDING_REVIEW` | Missing required fields: reject submission | tasks.md §6, §13; AGENTS.md §10 |
| F-24 | Review | Editor Review Card | Present incoming review queue with Author, Channel, Type, Created Date, Priority, Comment, Preview, and Action buttons. | Review post ID | Interactive Telegram review card | Non-pending post: inform editor "Пост уже обработан" | tasks.md §13 |
| F-25 | Review | Approve Post | Editor approves publication; transitions `PENDING_REVIEW -> APPROVED`; notifies Author. | Post ID, Editor ID | Post status `APPROVED` | Invalid current status or lack of `can_approve`: reject | tasks.md §6, §13; AGENTS.md §10 |
| F-26 | Review | Request Revision with Feedback | Editor sends post back to author; requires non-empty feedback comment; transitions `PENDING_REVIEW -> NEEDS_REVISION`; notifies Author. | Post ID, Editor ID, Comment | Post status `NEEDS_REVISION`, `post_reviews` row | Empty comment rejected; status change blocked | tasks.md §6, §13; AGENTS.md §10 |
| F-27 | Review | Reject Post | Editor permanently rejects publication; transitions `PENDING_REVIEW -> REJECTED`; notifies Author. | Post ID, Editor ID | Post status `REJECTED` | Unauthorized user rejected | tasks.md §6, §13; AGENTS.md §10 |
| F-28 | Review | Revision & Resubmission | Author edits post in `NEEDS_REVISION`, reviews editor feedback, and resubmits (`NEEDS_REVISION -> PENDING_REVIEW`); notifies Editor. | Post ID, Author ID | Post status `PENDING_REVIEW` | Not in `NEEDS_REVISION` status: reject | tasks.md §6, §13; AGENTS.md §10 |
| F-29 | Review | Review Queue Navigation | Editors browse all posts currently awaiting review via `✅ На согласовании` menu with pagination. | Channel ID, page offset | Paginated list of review cards | Empty queue: display "Нет постов на согласовании" | tasks.md §8, §13 |
| F-30 | Publishing | Async Queued Publishing | Publish action creates `publication_jobs` row and enqueues BullMQ job; handler never calls Telegram publish API directly. | Post ID, Actor ID | Job ID, Post status `PUBLISHING` | Handler timeout or direct call prevented | tasks.md §20; AGENTS.md §3, §20 |
| F-31 | Publishing | Publication Idempotency Key | Enforce single publication via unique database key `publish:{post_id}:{post_version}`. | Post ID, version | Unique `idempotency_key` | Duplicate button click triggers unique constraint violation and is rejected | tasks.md §21; AGENTS.md §21 |
| F-32 | Publishing | Preflight Validation | Validate channel active, bot admin rights, chat ID existence, and payload validity immediately before enqueueing and before worker execution. | Channel ID, Post entity, Payload | Validation pass / fail | Preflight failure aborts job and marks `PUBLISH_FAILED` | tasks.md §19; AGENTS.md §25 |
| F-33 | Publishing | Worker Execution & Message ID Recording | Worker executes Telegram API calls via `TelegramPublisher` abstraction and persists each created Telegram `message_id` into DB. | BullMQ job | Array of `telegram_message_ids` in DB, status `PUBLISHED` | Telegram API error triggers retry logic | tasks.md §20, §23; AGENTS.md §23, §48 |
| F-34 | Publishing | Partial Publishing Resume | On job retry, worker inspects `telegram_message_ids` and resumes sending remaining messages without duplicating sent messages. | Stored `telegram_message_ids`, Payload | Resumed publication | Duplicate messages in channel prevented | tasks.md §23; AGENTS.md §23 |
| F-35 | Publishing | Exponential Backoff & Retry | BullMQ retries transient failures with exponential backoff (e.g. 3 attempts); respects Telegram `retry_after` headers. | Failed job, attempt count | Scheduled delayed retry | Max retries reached: transition to `PUBLISH_FAILED` | tasks.md §22; AGENTS.md §22, §49, §50 |
| F-36 | Publishing | Manual Retry of Failed Post | Failed post (`PUBLISH_FAILED`) provides button `🔁 Повторить публикацию` to re-enqueue job. | Post ID, Editor/Admin ID | New `publication_jobs` row, status `PUBLISHING` | Non-failed post: action rejected | tasks.md §22; AGENTS.md §10 |
| F-37 | Scheduling | Schedule Approved Post | Set future publication time in channel timezone; transitions `APPROVED -> SCHEDULED`; schedules delayed BullMQ job. | Post ID, `scheduled_at` timestamp | Post status `SCHEDULED`, delayed queue job | Timestamp in the past rejected | tasks.md §6, §19; AGENTS.md §24 |
| F-38 | Scheduling | Cancel Schedule | Editor or Admin cancels scheduled publication; transitions `SCHEDULED -> CANCELLED`; removes queue job. | Post ID, Actor ID | Post status `CANCELLED`, job removed | Already publishing/published post cannot be cancelled | tasks.md §6; AGENTS.md §10 |
| F-39 | Notifications | Domain Event Notifications | Decoupled notification service delivers alerts on post submitted, approved, revision requested, rejected, scheduled, published, and failed. | Domain event, recipient Telegram IDs | Outgoing Telegram direct messages | Notification failure does not roll back DB transaction | tasks.md §24; AGENTS.md §27 |
| F-40 | Notifications | Autosave Silent Rule | Ensure no Telegram notifications are sent during routine draft autosaves. | Autosave event | No notification emitted | Silent execution guaranteed | tasks.md §24 |
| F-41 | Audit | Append-Only Audit Logging | Record every domain state transition, media modification, user creation, and permission change in `audit_logs`. | Entity type, Entity ID, Action, Actor ID, Payload | Inserted `audit_logs` record | Tampering/rewriting audit records blocked | tasks.md §26; AGENTS.md §26 |
| F-42 | UI & Safety | Stale UI & Replay Protection | Handlers verify current PostgreSQL status before executing actions; reject stale buttons from earlier states. | Callback query data, current DB post status | Action permitted or rejected | Stale button click displays friendly warning "Действие устарело" | AGENTS.md §51, §52 |
| F-43 | UI & Safety | Destructive Action Confirmation | Require explicit confirmation dialog for delete draft, cancel publication, or user removal. | Button click | Confirmation prompt (Да, удалить / Отмена) | Accidental one-click deletion prevented | AGENTS.md §54 |
| F-44 | Observability | Health & Readiness Probes | Expose HTTP `GET /health` (process liveness) and `GET /ready` (PostgreSQL, Redis, Queue connectivity). | HTTP GET requests | 200 OK / 503 Service Unavailable + JSON status | Unhealthy dependency reports 503 | tasks.md §29, §31; AGENTS.md §37, §38 |
| F-45 | Observability | Structured JSON Logging | Output structured JSON logs containing `request_id`, `telegram_update_id`, `user_id`, `post_id`, `job_id`. | Log event and context | Formatted JSON log line | Secrets automatically redacted | tasks.md §31; AGENTS.md §33, §34 |
| F-46 | Infrastructure | Environment Validation | Validate required environment variables at startup (`BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `DEFAULT_TIMEZONE`); fail fast if invalid. | Environment variables | Application startup or fatal exit | Missing/malformed env exits process immediately | AGENTS.md §35 |
| F-47 | Infrastructure | Dual Transport Mode | Support both Webhook (`POST /telegram/webhook` with secret token validation) and Polling for local development. | Inbound webhook HTTP request / Polling loop | Inbound Telegram update | Invalid webhook secret returns HTTP 401 | tasks.md §28, §29; AGENTS.md §36 |
| F-48 | Infrastructure | Worker / App Process Separation | Architecture supports running bot transport app and BullMQ publishing worker in separate processes/containers. | Docker Compose configuration | Independent `app` and `worker` services | Bot restart does not kill background queue publishing | AGENTS.md §65 |

---

## 13. Edge Cases, Failure Modes & Observed Behaviors

| # | Feature | Input / Scenario | Observed / Required Specification Behavior |
|---|---|---|---|
| E-01 | Auth (`/start`) | Unregistered Telegram user executes `/start` | Access denied immediately; bot returns message: *"У вас пока нет доступа к редакции. Обратитесь к администратору."* No session created in DB. |
| E-02 | Auth | Deactivated user (`isActive=false`) taps any inline button | Request rejected with authorization error; callback answered with *"Ваш аккаунт деактивирован"*. |
| E-03 | Wizard (Channels) | User has membership in exactly 1 channel | Step 1 (Channel Selection) is automatically skipped; draft is immediately created for the single channel. |
| E-04 | Wizard (Channels) | User has no active channel memberships | Wizard creation aborted; bot notifies: *"У вас нет доступа к каналам для публикации."* |
| E-05 | Wizard (Autosave) | User inputs Step 3 Title and abruptly closes Telegram / app restarts | Draft is already saved in PostgreSQL with status `DRAFT`; upon reopening bot and selecting `📝 Мои материалы`, user resumes from Step 3 without data loss. |
| E-06 | Concurrency (OCC) | Editor A and Editor B open the same post simultaneously; Editor A saves changes (version increments 1 -> 2); Editor B attempts to save changes with expected version 1 | Editor B's update query affects 0 rows; system returns conflict error: *"Публикация была изменена другим пользователем. Откройте актуальную версию и повторите изменение."* Editor A's changes are preserved. |
| E-07 | Review | Editor clicks `↩️ На доработку` and submits empty comment | Bot rejects input with message: *"Для возврата публикации на доработку необходимо указать комментарий."* Status remains `PENDING_REVIEW`. |
| E-08 | Review (Stale UI) | Editor leaves review card open; post is approved by another editor; Editor clicks old `❌ Отклонить` button | System checks DB status, detects post is `APPROVED` (not `PENDING_REVIEW`), rejects action, updates inline keyboard, and displays: *"Публикация уже была согласована."* |
| E-09 | Scheduling | User schedules post for a time in the past (e.g. `20.09.2026 12:00` when current time is `21.09.2026 10:00`) | Validation rejects input: *"Время публикации не может быть в прошлом. Укажите будущее время."* |
| E-10 | Scheduling | User schedules post using channel timezone `Europe/Kyiv` | System parses `21.09.2026 18:30` as Kyiv local time (EEST, UTC+3) and persists `2026-09-21T15:30:00Z` in PostgreSQL `scheduled_at TIMESTAMPTZ`. |
| E-11 | Publishing (Idempotency) | User double-clicks "🚀 Опубликовать" button within 100ms | First click creates `publication_jobs` with key `publish:{post_id}:{post_version}`. Second click triggers PostgreSQL unique constraint violation on `idempotency_key`, returns 409 conflict, and sends no second job. Only 1 Telegram post is published. |
| E-12 | Publishing (Partial) | Post contains Media Group + Long Text. Worker successfully publishes Media Group (Telegram message ID 1001 recorded in DB), but Telegram API times out on Long Text | Job fails attempt 1 and BullMQ schedules retry. On retry, worker reads `telegram_message_ids = [1001]`, sees Media Group was already sent, SKIPS `sendMediaGroup`, and only calls `sendMessage` for the Long Text. Channel receives zero duplicate media groups. |
| E-13 | Publishing (Retries) | Telegram API returns HTTP 429 Too Many Requests (`retry_after: 35`) | Worker parses `retry_after`, delays BullMQ job execution by 35 seconds, and attempts re-execution without burning retry attempts prematurely. |
| E-14 | Publishing (Permanent Failure)| Bot has been removed from channel / revoked admin rights (HTTP 403 Forbidden) | Worker classifies error as non-retryable / permanent; immediately marks job FAILED, transitions post to `PUBLISH_FAILED`, logs audit event, and sends alert to Editors with actionable message. |
| E-15 | Formatting | User inputs invalid HTML tags (e.g. `<div onclick="alert()">Click</div><script>`) | Sanitizer strips dangerous tags; converts allowed formatting; escapes `<` and `>`. If malformed/unclosed tags cannot be fixed, informs user: *"Обнаружены неподдерживаемые HTML-теги."* |
| E-16 | Media | User uploads uncompressed video that arrives as Telegram `document` | Media parser checks MIME type / file extension; stores in `post_media` as `DOCUMENT` with video metadata; renderer correctly uses `sendDocument` or appropriate method without crashing. |
| E-17 | Media | Media group upload exceeds 10 items (Telegram API limit) | System limits media group selection to 10 items; notifies user: *"В одну медиагруппу можно прикрепить от 2 до 10 файлов."* |
| E-18 | Text Length | Rendered post body exceeds 4,096 characters | Unified renderer splits content into logical parts (e.g. multi-message payload) or validates template schema constraints so single text messages never exceed Telegram API limit. |
| E-19 | Audit | Attempt to update an existing audit log entry | Audit service enforces append-only semantics; Prisma schema has no update endpoint for audit logs. |
| E-20 | Process Crash | Docker container restarts during BullMQ job execution | BullMQ stalled job detection re-queues the job; new worker inspects DB idempotency key and `telegram_message_ids` to safely resume execution without duplicate sends. |

---

## 14. Verification & Testing Matrix

To confirm system compliance with this specification, automated verification must cover four tiers:

1. **Unit Verification:**
   - Permission rules (`RoleGuard`, `ChannelPermissionEvaluator`).
   - Post State Machine transitions (`PostWorkflowService` allowed vs forbidden transitions).
   - Template field schema validation (types, bounds, required fields).
   - HTML sanitization and entity escaping.
   - Idempotency key generation and collision detection.
   - Timezone parsing and UTC conversion (`Europe/Kyiv` -> UTC).
2. **Integration Verification:**
   - Prisma schema migration against real PostgreSQL instance.
   - OCC version check under simulated parallel updates.
   - BullMQ queue enqueueing, worker processing, and delay execution with Redis.
   - TelegramPublisher mock capturing `telegram_message_ids`.
   - Partial publishing resume logic (verifying no duplicate calls on retry).
3. **End-to-End Workflow Verification:**
   - Author `/start` -> channel select -> template select -> field input -> autosave verification in DB.
   - Author submit for review -> Editor receives notification -> Editor requests revision with comment -> Author receives feedback -> Author edits and resubmits.
   - Editor approves -> Schedule publication -> Time reaches due -> Worker publishes -> Channel receives post -> Post marked `PUBLISHED`.
   - Simulated Telegram 500/timeout -> Worker retries with exponential backoff -> Worker marks `PUBLISH_FAILED` -> Editor clicks `🔁 Повторить публикацию` -> Successful publication.
4. **Adversarial & Edge Case Verification:**
   - Unregistered user `/start` rejection.
   - Stale inline button replay attack prevention.
   - Double-click publication race condition prevention.
   - Webhook secret token validation.
   - Container restart survival without data or schedule loss.
