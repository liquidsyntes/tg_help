# Milestone 5 Architecture & Design Report: Post Preview, Review Cards, Editorial Actions & Scheduling UI

**Author:** m5_explorer_3 (`teamwork_preview_explorer`)  
**Target Milestone:** Milestone 5 — Telegram Transport & Interactive Editorial UI  
**Target Output File:** `c:/TgHelp/.agents/m5_explorer_3/report.md`  
**Date:** 2026-09-21  

---

## 1. Executive Summary & Scope Definition

This report provides the architectural blueprint, data contracts, and implementation specifications for the **Preview, Review, Editorial Controls, and Scheduling subsystem** of Milestone 5.

### Primary Responsibilities of this Subsystem
1. **Canonical Post Preview & Editorial Control Panel**:
   - Integrate `TelegramRenderer` (from Milestone 3) to produce an identical preview in the user's private Telegram chat.
   - Overcome Telegram Bot API restrictions regarding inline keyboards on media groups using the **Companion Control Card** pattern.
   - Render role- and state-dependent editorial action buttons (Author controls: Submit for Review, Edit, Media, Delete Draft).
2. **Review & Editorial Workflow UI**:
   - Paginated Review Queue card deck for Editors and Super Admins.
   - Review card presentation (Author, Channel, Post Type, Creation Time, Author Note).
   - Editorial actions: `Approve` (`PENDING_REVIEW -> APPROVED`), `Request Revision` (`PENDING_REVIEW -> NEEDS_REVISION`), and `Reject` (`PENDING_REVIEW -> REJECTED`).
   - Two-step revision request flow with mandatory feedback comment captured via Redis-backed conversational state.
3. **Publication & Scheduling UI**:
   - "Publish Now" button triggering `PublishingService.enqueuePublish` with DB idempotency.
   - "Schedule Publication" button prompting for date/time in the channel's timezone (default `Europe/Kyiv`), supporting quick-presets, and calling `SchedulingService.schedulePost`.
   - "Cancel Schedule" and "Retry Failed Publication" actions.
4. **Concurrency & Stale Button Defense (AGENTS.md §7, §13, §51, §52)**:
   - Compact callback data encoding strictly constrained to $\le 64$ bytes.
   - Embed `expectedVersion` in every mutable callback payload.
   - Multi-tier validation: transport-level version check, server-side status guard, and PostgreSQL Optimistic Concurrency Control (`WHERE id = :id AND version = :v`).
   - Friendly Russian conflict notification and automatic UI refresh.
5. **Real-time Telegram Notification Delivery**:
   - Extend `NotificationService` to dispatch actual Telegram messages to recipients via `ITelegramPublisher`.
   - Ensure notifications remain isolated side-effects that cannot crash or roll back core business transactions.
6. **Worker Implementation Guidelines**:
   - Exact interfaces, DTOs, codec specifications, keyboard builders, and handler logic ready for direct coding by the worker.

---

## 2. Post Preview & Editorial Controls Architecture

### 2.1 The Canonical Preview Invariant (AGENTS.md §15)
`AGENTS.md § 15` strictly mandates:
> *"There must be one canonical rendering pipeline. Post + Template + Media -> Renderer -> TelegramPayload. Preview and publication must use the same renderer. Do not implement separate formatting logic for preview and publication. Otherwise preview can diverge from the actual channel post."*

In Milestone 3, `TelegramRenderer` was implemented and verified. It accepts `(post: Post, template: PostTemplate, media: PostMedia[])` and returns `TelegramPayload` containing `messages: TelegramOutgoingMessage[]`.

### 2.2 The "Companion Control Card" Architectural Pattern

#### The Telegram Bot API Constraint
Telegram's Bot API method `sendMediaGroup` **does NOT accept an inline keyboard (`reply_markup`)**. Attempting to pass `reply_markup` to `sendMediaGroup` causes Telegram to return HTTP 400 (`Bad Request: reply_markup is not supported for media group`).
Furthermore, if a long text post is split into multiple messages (e.g. Media Group of photos + continuation text message $> 1024$ chars), attaching buttons directly to the content message risks being obscured or displaced.

#### The Solution: Canonical Preview + Companion Control Card
To maintain 100% fidelity to `AGENTS.md § 15` while strictly respecting Telegram limits:
1. **Render Preview Messages**: Send the exact messages produced by `TelegramRenderer` directly into the private chat with the user via `ITelegramPublisher.publishOutgoingMessage(...)`.
2. **Send Anchor Control Card**: Immediately send an editorial companion control message containing structured metadata and the contextual inline keyboard:

```text
╔══════════════════════════════════════════════════════════╗
║ [Canonical Rendered Media / Text Preview]                ║
║ (100% identical to how it will look in the channel)      ║
╚══════════════════════════════════════════════════════════╝
                            ↓
╔══════════════════════════════════════════════════════════╗
║ 📋 <b>Панель управления публикацией</b>                  ║
║ ──────────────────────────────────────────               ║
║ 📌 <b>Статус:</b> Черновик (версия 2)                    ║
║ 📢 <b>Канал:</b> Pro Tech News (@protechnews)            ║
║ 📝 <b>Шаблон:</b> Лонг-рид                                ║
║ 👤 <b>Автор:</b> Иван Иванов (@ivanov)                    ║
║ 🕒 <b>Обновлено:</b> 21.09.2026 18:30                     ║
║ ──────────────────────────────────────────               ║
║ [ Inline Keyboard Actions ]                              ║
╚══════════════════════════════════════════════════════════╝
```

#### Key Architectural Benefits
- **Zero Divergence**: The preview content is not wrapped or modified; it is the raw channel payload.
- **Media Group Compatibility**: Fully supports single photo, single video, animations, documents, and 2–10 item media groups.
- **In-Place UI Updates**: When any action button is clicked (e.g., "Submit for Review", "Delete"), the bot modifies **only the Control Card message** via `ctx.editMessageText()` or `ctx.editMessageReplyMarkup()`. The user does not get spammed with newly sent messages, and the chat remains clean.
- **Version Pinning**: The Control Card holds the latest version badge, giving the user immediate visual confirmation of state changes.

### 2.3 Author Editorial Controls & Visibility Matrix

Buttons displayed on the Control Card are computed dynamically based on:
1. The post's current status (`PostStatus`).
2. The user's role and channel permissions (`PermissionService`).
3. Whether the user is the post's author (`isAuthor = post.authorId === actor.id`).

| Button Label | Internal Action | Allowed Post Statuses | Required Permission |
|---|---|---|---|
| `✅ На согласование` | `SUBMIT_FOR_REVIEW` | `DRAFT`, `NEEDS_REVISION` | Author OR `SUBMIT_REVIEW` |
| `✏️ Редактировать` | `EDIT_POST` | `DRAFT`, `NEEDS_REVISION` (Author); any (Editor) | `checkPostEditPermission` |
| `🖼 Медиа` | `MANAGE_MEDIA` | `DRAFT`, `NEEDS_REVISION` | `checkPostEditPermission` |
| `🗑 Удалить черновик` | `DELETE_DRAFT` | `DRAFT`, `NEEDS_REVISION` | Author OR `DELETE_POST` |
| `🚀 Опубликовать` | `PUBLISH_NOW` | `APPROVED` (or `PUBLISH_FAILED`) | `canPublish = true` / `SUPER_ADMIN` |
| `📅 Запланировать` | `SCHEDULE` | `APPROVED` | `canPublish` / `canApprove` / `SUPER_ADMIN` |
| `❌ Отменить расписание` | `CANCEL_SCHEDULE` | `SCHEDULED` | `canPublish` / `canApprove` / `SUPER_ADMIN` |
| `🔁 Повторить публикацию` | `RETRY_PUBLISH` | `PUBLISH_FAILED` | `canPublish = true` / `SUPER_ADMIN` |

### 2.4 Destructive Action Confirmation Flow (AGENTS.md §54)
When `🗑 Удалить черновик` is tapped:
1. Update the Control Card text:
   ```text
   ⚠️ <b>Удаление публикации</b>

   Вы уверены, что хотите удалить этот черновик?
   <i>Материал будет перемещен в архив.</i>
   ```
2. Present two explicit confirmation buttons:
   `🗑 Да, удалить` (`p:del_ok:<postId>:<version>`) | `🔙 Отмена` (`p:view:<postId>`)
3. Upon clicking `🗑 Да, удалить`:
   - Invoke `PostsService.softDeletePost(postId, expectedVersion, actorId)`.
   - Update card text: `🗑 Черновик успешно удален.`
   - Show single button: `🔙 В главное меню` (`nav:main`).

---

## 3. Review & Editorial Workflow UI

### 3.1 Review Queue Navigation & Listing (AGENTS.md §64)
Editors and Super Admins access the review queue via the main menu button `✅ На согласовании` or the command `/reviews`.

#### Multi-Channel Resolution
1. Resolve all active channels where `actor.systemRole === SUPER_ADMIN` OR `(member.role === EDITOR && member.canApprove === true)`.
2. Query pending posts:
   ```ts
   const pendingPosts = await this.postsRepository.findPendingReview(channelId);
   ```
3. If empty across all assigned channels:
   ```text
   🎉 <b>Очередь согласования пуста!</b>
   Нет публикаций, ожидающих проверки.
   ```
   Button: `🔙 В главное меню`.

#### Paginated Review Card Presentation
If posts exist, display them in card-deck mode (item $N$ of $Total$):
1. Send canonical preview via `TelegramRenderer`.
2. Send the **Review Queue Card**:
   ```text
   📋 <b>Карточка согласования</b> [1 из 3]
   ───────────────────────────────
   📢 <b>Канал:</b> Pro Tech News
   👤 <b>Автор:</b> Алексей Смирнов (@alex_tech)
   📝 <b>Шаблон:</b> Анонс
   🕒 <b>Поступил:</b> 21.09.2026 14:30
   📌 <b>Статус:</b> На согласовании (v2)
   💬 <b>Комментарий автора:</b> Прошу согласовать до 18:00
   ───────────────────────────────
   ```
3. **Review Action Keyboard**:
   - Row 1: `✅ Одобрить` (`r:app:<id>:<v>`) | `↩️ На доработку` (`r:rev:<id>:<v>`)
   - Row 2: `✏️ Редактировать` (`p:edt:<id>:<v>`) | `❌ Отклонить` (`r:rej:<id>:<v>`)
   - Row 3: `⬅️ Предыдущий` (`q:card:<chId>:<idx-1>`) | `Следующий ➡️` (`q:card:<chId>:<idx+1>`)
   - Row 4: `🔙 В главное меню` (`nav:main`)

### 3.2 Action Handlers & State Machine Integrations

#### 1. Approve Post (`✅ Одобрить`)
- Callback: `r:app:<postId>:<expectedVersion>`.
- Handler verifies:
  1. `expectedVersion === post.version`.
  2. `actor` has `ChannelPermission.APPROVE_POST`.
- Invokes domain service:
  ```ts
  const approvedPost = await this.postWorkflow.transition({
    postId,
    expectedVersion,
    actorId,
    action: PostAction.APPROVE,
    targetStatus: PostStatus.APPROVED,
  });
  ```
- **Prisma Transaction Executed**:
  - Atomic OCC update: `status: APPROVED`, `version: version + 1`.
  - `post_reviews` entry created: `action: APPROVE`, `reviewerId: actorId`.
  - `audit_logs` record: `action: approved`.
- **Domain Event Emitted**:
  - `PostApprovedEvent` dispatched -> `NotificationService` alerts author:
    `✅ Ваш пост одобрен! Заголовок: ...`
- **UI Confirmation**:
  Control Card updates in-place:
  ```text
  ✅ <b>Публикация успешно одобрена!</b>
  Статус изменен на: <b>Одобрено</b> (версия 3).
  ```
  Inline buttons:
  Row 1: `🚀 Опубликовать сейчас` (`pub:now:<id>:3`) | `📅 Запланировать` (`pub:sch:<id>:3`)
  Row 2: `📋 Следующий пост из очереди` (`q:next:<chId>`) | `🔙 Меню` (`nav:main`)

#### 2. Request Revision (`↩️ На доработку`) with Mandatory Comment
`tasks.md § 13` and `PostWorkflowService` strictly require:
> *"Для возврата на доработку обязателен комментарий."*

- Callback: `r:rev:<postId>:<expectedVersion>`.
- Pre-validation: Verify post status is still `PENDING_REVIEW` and `post.version === expectedVersion`.
- **Set Redis Conversational State**:
  Store state with 15-minute TTL to ensure user input routing survives bot restarts:
  ```ts
  await this.redisService.set(
    `user:session:${telegramId}`,
    JSON.stringify({
      state: 'AWAITING_REVISION_COMMENT',
      postId,
      expectedVersion,
    }),
    900, // 15 min TTL
  );
  ```
- Prompt Editor:
  ```text
  ↩️ <b>Возврат на доработку</b>

  Пожалуйста, отправьте сообщение с комментарием для автора:
  укажите, что необходимо исправить или дополнить.

  <i>Комментарий обязателен для возврата на доработку.</i>
  ```
  Button: `❌ Отмена` (`p:view:<postId>`).
- When Editor sends text message:
  1. Retrieve session from Redis.
  2. If empty text or only whitespace -> repeat prompt: `⚠️ Комментарий не может быть пустым. Пожалуйста, напишите замечания для автора:`.
  3. Invoke domain transition:
     ```ts
     await this.postWorkflow.transition({
       postId,
       expectedVersion,
       actorId,
       action: PostAction.REQUEST_REVISION,
       targetStatus: PostStatus.NEEDS_REVISION,
       comment: textContent.trim(),
     });
     ```
  4. Clear Redis session key.
  5. `PostRevisionRequestedEvent` emitted -> Author receives Telegram notification containing the editor's feedback comment.
  6. Reply to Editor:
     ```text
     ↩️ <b>Публикация возвращена автору на доработку.</b>
     Комментарий передан автору:
     «<i>${textContent.trim()}</i>»
     ```
     Buttons: `📋 К очереди согласования` (`q:list`) | `🔙 В главное меню`.

#### 3. Reject Post (`❌ Отклонить`)
- Callback: `r:rej:<postId>:<expectedVersion>`.
- Prompt Confirmation (Destructive Action):
  ```text
  ⚠️ <b>Отклонение публикации</b>

  Вы действительно хотите отклонить эту публикацию?
  Автор получит уведомление об отказе.
  ```
  Buttons: `❌ Да, отклонить` (`r:rej_ok:<postId>:<expectedVersion>`) | `🔙 Назад` (`p:view:<postId>`).
- Upon confirmation:
  - Transition: `postWorkflow.transition({ postId, expectedVersion, actorId, action: PostAction.REJECT, targetStatus: PostStatus.REJECTED })`.
  - Emits `PostRejectedEvent` -> notifies author.
  - Card updates: `❌ Публикация отклонена.`

---

## 4. Publication & Scheduling UI

### 4.1 "Publish Now" Execution Flow (AGENTS.md §20, §21)
`AGENTS.md § 20` mandates:
> *"Never publish directly from a Telegram callback handler. User action -> permission validation -> post validation -> create publication job -> BullMQ -> worker -> Telegram API -> save result -> notify users."*

#### Step-by-Step Flow:
1. User taps `🚀 Опубликовать` (`pub:now:<postId>:<expectedVersion>`).
2. Handler checks:
   - OCC: `expectedVersion === post.version`.
   - Post status is `APPROVED` or `PUBLISH_FAILED`.
   - Actor has `canPublish` or `SUPER_ADMIN`.
3. Handler calls `PublishingService.enqueuePublish(postId, actorId)`.
4. `PublishingService`:
   - Runs Stage 1 preflight (bot admin rights, channel active, post exists and non-deleted).
   - Generates idempotency key: `publish:${postId}:${post.version}`.
   - Inserts `PublicationJob` into PostgreSQL (status `PENDING`).
   - Pushes job to BullMQ queue `publication-queue`.
   - Records audit log `publication_job_created`.
5. Handler receives `PublicationJob` and immediately responds to user:
   - Calls `ctx.answerCallbackQuery({ text: '🚀 Публикация отправлена в очередь!' })`.
   - Updates Control Card:
     ```text
     ⏳ <b>Публикация передана в очередь!</b>
     ──────────────────────────────────────────
     ID задачи: <code>${job.id}</code>
     Статус: <b>Обработка воркером...</b>
     ──────────────────────────────────────────
     <i>По завершении публикации автор получит уведомление.</i>
     ```
     Button: `🔄 Обновить статус` (`p:view:<postId>`).
6. The background Worker picks up the job, executes Stage 2 preflight, marks post `PUBLISHING`, calls `TelegramPublisherService.publishOutgoingMessage`, records message IDs, marks post `PUBLISHED`, and emits `PostPublishedEvent`.

### 4.2 "Schedule Publication" Flow (AGENTS.md §24, §47)
`AGENTS.md § 24` and `tasks.md § 19` specify:
> *"Store absolute publication times using timezone-aware database types (TIMESTAMPTZ). User-entered dates should be interpreted in the channel timezone (default Europe/Kyiv). Convert to absolute timestamp before scheduling. Do not store ambiguous local datetime values without timezone context. Validate that scheduled dates are not in the past."*

#### Step-by-Step Flow:
1. User taps `📅 Запланировать` (`pub:sch:<postId>:<expectedVersion>`).
2. Server validates actor has `SCHEDULE_POST` and post status is `APPROVED`.
3. Store conversational state in Redis:
   ```ts
   await this.redisService.set(
     `user:session:${telegramId}`,
     JSON.stringify({
       state: 'AWAITING_SCHEDULE_DATETIME',
       postId,
       expectedVersion,
       channelId: post.channelId,
     }),
     900,
   );
   ```
4. Render Timezone-Aware Prompt with Quick Presets:
   - Current time formatted in channel timezone via `formatChannelDate(new Date(), channel.timezone)`.
   ```text
   📅 <b>Планирование публикации</b>

   Часовой пояс канала: <b>${channel.timezone}</b>
   Текущее время в канале: <b>${channelCurrentTime}</b>

   Введите дату и время публикации в формате:
   <code>ДД.ММ.ГГГГ ЧЧ:ММ</code>

   Например: <code>${exampleTime}</code>
   ```
   **Inline Keyboard with Quick Presets**:
   - Row 1: `Через 1 час` (`sch_p:1h:<id>:<v>`) | `Через 3 часа` (`sch_p:3h:<id>:<v>`)
   - Row 2: `Завтра в 10:00` (`sch_p:t10:<id>:<v>`) | `Завтра в 18:00` (`sch_p:t18:<id>:<v>`)
   - Row 3: `❌ Отмена` (`p:view:<postId>`)
5. Input Processing:
   - If user clicks a preset: calculate target Date in channel timezone.
   - If user sends text message: parse via `parseAndValidateScheduledDate(text, channel.timezone)`.
   - **Validation Error Handling**:
     If invalid format or past date, send empathetic feedback:
     ```text
     ⚠️ <b>Некорректная дата публикации</b>

     «${input}»

     Пожалуйста, используйте формат <code>ДД.ММ.ГГГГ ЧЧ:ММ</code> (например: 22.09.2026 15:30) и укажите время в будущем.
     ```
6. Execution:
   - Call `SchedulingService.schedulePost(postId, targetDate, actorId, expectedVersion)`.
   - Clear Redis session state.
   - Transitions post `APPROVED -> SCHEDULED` with OCC increment.
   - Creates `PublicationJob` with `scheduledFor = targetDate`.
   - Enqueues delayed BullMQ job with `delayMs = targetDate.getTime() - Date.now()`.
   - Dispatches `PostScheduledEvent` -> author notified.
   - UI confirms:
     ```text
     🕒 <b>Публикация успешно запланирована!</b>
     ──────────────────────────────────────────
     📢 <b>Канал:</b> ${channel.title}
     🕒 <b>Время публикации:</b> ${formattedTargetDate} (${channel.timezone})
     ──────────────────────────────────────────
     ```
     Buttons: `❌ Отменить расписание` (`pub:sch_c:<id>:<newVersion>`) | `📋 К списку публикаций`.

### 4.3 "Cancel Schedule" Flow (AGENTS.md §10, §54)
1. User taps `❌ Отменить расписание` (`pub:sch_c:<postId>:<expectedVersion>`).
2. Confirmation Dialog:
   `Вы действительно хотите отменить запланированную публикацию?`
   `❌ Да, отменить` (`pub:sch_ok:<id>:<v>`) | `🔙 Назад` (`p:view:<postId>`).
3. Execution:
   - Call `SchedulingService.cancelSchedule(postId, actorId, expectedVersion)`.
   - Cancels BullMQ delayed job, sets `publication_jobs.status = CANCELLED`.
   - Transitions post `SCHEDULED -> CANCELLED` with OCC increment.
   - Updates card: `🚫 Публикация отменена.`

### 4.4 "Retry Failed Publication" Flow (AGENTS.md §22, §23)
When a post is in `PUBLISH_FAILED`:
1. Control Card displays error context:
   ```text
   🚨 <b>Ошибка публикации</b>
   Публикация не удалась после 3 попыток.
   Причина: ${lastJob.errorMessage ?? 'Неизвестная ошибка'}
   ```
2. Buttons: `🔁 Повторить публикацию` (`pub:ret:<postId>:<version>`) | `❌ Отменить` (`pub:sch_c:<postId>:<version>`).
3. Clicking `🔁 Повторить публикацию` calls `PublishingService.enqueuePublish(postId, actorId)`.
4. The worker resumes sending remaining messages from `telegramMessageIds` without duplicate messages (F-34 Partial Publishing Resume).

---

## 5. Concurrency & Stale Button Defense (AGENTS.md §7, §13, §51, §52)

### 5.1 Telegram Callback Data 64-Byte Limit Analysis
`TELEGRAM_LIMITS.MAX_CALLBACK_DATA_BYTES` is strictly **64 bytes**. Exceeding 64 bytes causes Telegram Bot API to reject the inline keyboard creation with HTTP 400 (`BUTTON_DATA_INVALID`).

A standard UUID has 36 ASCII characters (36 bytes):
`123e4567-e89b-12d3-a456-426614174000`

If we format callback data as:
`<action_prefix>:<postId>:<expectedVersion>`
Let's analyze byte counts:

| Action | Prefix | UUID Bytes | Version (up to 4 digits) | Separators | Total Bytes | Headroom to 64 bytes |
|---|---|---|---|---|---|---|
| Submit for Review | `p:sub` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Delete Draft Prompt | `p:del` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Confirm Delete Draft | `p:del_ok` | 36 | 4 | 2 | 50 bytes | +14 bytes safe |
| Edit Fields Menu | `p:edt` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Manage Media Menu | `p:med` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| View Post Card | `p:view` | 36 | - | 1 | 43 bytes | +21 bytes safe |
| Review: Approve | `r:app` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Review: Request Revision | `r:rev` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Review: Reject Prompt | `r:rej` | 36 | 4 | 2 | 47 bytes | +17 bytes safe |
| Review: Confirm Reject | `r:rej_ok` | 36 | 4 | 2 | 50 bytes | +14 bytes safe |
| Publish Now | `pub:now` | 36 | 4 | 2 | 49 bytes | +15 bytes safe |
| Schedule Prompt | `pub:sch` | 36 | 4 | 2 | 49 bytes | +15 bytes safe |
| Cancel Schedule Prompt | `pub:sch_c` | 36 | 4 | 2 | 51 bytes | +13 bytes safe |
| Confirm Cancel Schedule | `pub:sch_ok` | 36 | 4 | 2 | 52 bytes | +12 bytes safe |
| Retry Failed Publish | `pub:ret` | 36 | 4 | 2 | 49 bytes | +15 bytes safe |

**Conclusion**: Every single callback string in our architecture is $\le 52$ bytes, leaving at least 12 bytes of guaranteed safety margin under all conditions.

### 5.2 The 4-Tier Stale Button & Concurrency Defense Matrix

```text
               User Taps Callback Button (e.g. r:app:POST_ID:2)
                                      ↓
      ┌──────────────────────────────────────────────────────────────┐
      │ Tier 1: Callback Codec Validation                            │
      │ - Verify structure: action + valid UUID + positive integer   │
      │ - Reject malformed or tampered payloads immediately          │
      └──────────────────────────────┬───────────────────────────────┘
                                     ↓
      ┌──────────────────────────────────────────────────────────────┐
      │ Tier 2: Server-Side State & Version Guard                    │
      │ - Fetch current Post from PostgreSQL                         │
      │ - Check 2A: Post exists and deletedAt === null?              │
      │   -> If deleted: show alert 'Публикация удалена', clear keys │
      │ - Check 2B: Does post.version === expectedVersion?           │
      │   -> If mismatch: show alert 'Публикация была изменена...',  │
      │      auto-refresh card with latest version & fresh buttons   │
      │ - Check 2C: Does post.status allow requested transition?     │
      │   -> If invalid: show alert with current status, refresh UI  │
      └──────────────────────────────┬───────────────────────────────┘
                                     ↓
      ┌──────────────────────────────────────────────────────────────┐
      │ Tier 3: Database Optimistic Concurrency Control (OCC)        │
      │ - UPDATE posts SET status = :target, version = version + 1   │
      │   WHERE id = :id AND version = :expectedVersion              │
      │ - If 0 rows updated: throws PostConflictException            │
      │ - Caught by handler -> Alert user & refresh Control Card     │
      └──────────────────────────────┬───────────────────────────────┘
                                     ↓
      ┌──────────────────────────────────────────────────────────────┐
      │ Tier 4: Database Unique Idempotency Key (Publishing)         │
      │ - Unique constraint on publication_jobs.idempotency_key      │
      │ - Pattern: publish:{postId}:{version}                        │
      │ - Prevents duplicate queue jobs on rapid double-clicks       │
      └──────────────────────────────────────────────────────────────┘
```

### 5.3 Conflict Resolution UX (AGENTS.md §53)
When `expectedVersion !== post.version` or `PostConflictException` is caught:
1. **Immediate Telegram Toast Alert**:
   ```ts
   await ctx.answerCallbackQuery({
     text: '⚠️ Публикация была изменена другим пользователем. Интерфейс обновлен.',
     show_alert: true,
   });
   ```
2. **Silent In-Place UI Refresh**:
   Fetch the fresh post record, re-render the Control Card with the new status and updated version, and mount fresh callback buttons embedding the new version:
   ```ts
   await this.previewService.updateControlCard(ctx, post);
   ```
3. **Zero Phantom State**:
   No state change is executed on stale versions. The user is instantly brought up to date.

---

## 6. Real-Time Notification Delivery Architecture

### 6.1 Current Gap in Milestone 2 Codebase
In `src/modules/notifications/notification.service.ts`, event handlers (`handlePostSubmitted`, `handlePostApproved`, `handlePostRevisionRequested`, etc.) construct notification messages and store them in an in-memory array `this.dispatched` for testing and logging.
**However**, they do not currently invoke the Telegram Bot API to deliver messages to real Telegram users!

### 6.2 The Delivery Adapter Pattern (AGENTS.md §27, §49)
`AGENTS.md § 27` specifies:
> *"Notifications are side effects of domain events. Avoid spreading Telegram notification calls across business services. Notifications should not determine whether the core transaction succeeds unless the notification itself is the requested operation. Failure to send a secondary notification should not corrupt publication state."*

#### Upgraded Notification Dispatcher:
1. Inject `TelegramPublisherService` (or `ITelegramPublisher`) into `NotificationService`.
2. In `recordAndDispatch(...)`, execute asynchronous Telegram message delivery wrapped in an isolated error handler:
   ```ts
   private async recordAndDispatch(notif: Omit<DispatchedNotification, 'timestamp'>): Promise<void> {
     const entry: DispatchedNotification = {
       ...notif,
       timestamp: new Date(),
     };
     this.dispatched.push(entry);

     // Log event
     this.logger.log({
       event: 'notification_dispatched',
       recipientId: entry.recipientId,
       recipientTelegramId: entry.recipientTelegramId,
       eventType: entry.eventType,
       postId: entry.postId,
     }, 'NotificationService');

     // Asynchronous Telegram delivery (non-blocking side-effect)
     if (entry.recipientTelegramId) {
       try {
         await this.telegramPublisher.sendMessage(
           entry.recipientTelegramId,
           entry.message,
           { parseMode: 'HTML' },
         );
       } catch (err: unknown) {
         // Gracefully handle blocked bot, deactivated user, or network glitches
         this.logger.warn({
           event: 'telegram_notification_delivery_failed',
           recipientTelegramId: entry.recipientTelegramId,
           eventType: entry.eventType,
           postId: entry.postId,
           error: err instanceof Error ? err.message : String(err),
         }, 'NotificationService');
       }
     }
   }
   ```
3. **Autosave Silent Rule (F-40)**:
   `PostsService.autosaveStep` only writes to audit logs and emits **no domain events**, guaranteeing zero notification spam during routine drafting.

---

## 7. Concrete Technical Blueprint: Interfaces, DTOs & Code

### 7.1 Callback Codec Specification (`callback-data.codec.ts`)

```typescript
/**
 * Typesafe callback data codec enforcing 64-byte Telegram limit.
 * Authoritative reference: AGENTS.md § 18, § 51, § 52; tasks.md § 13
 */

export enum PostCallbackAction {
  // Author controls
  SUBMIT_FOR_REVIEW = 'p:sub',
  DELETE_DRAFT_PROMPT = 'p:del',
  DELETE_DRAFT_CONFIRM = 'p:del_ok',
  EDIT_POST = 'p:edt',
  MANAGE_MEDIA = 'p:med',
  VIEW_POST = 'p:view',

  // Reviewer actions
  APPROVE = 'r:app',
  REQUEST_REVISION = 'r:rev',
  REJECT_PROMPT = 'r:rej',
  REJECT_CONFIRM = 'r:rej_ok',

  // Publication & scheduling
  PUBLISH_NOW = 'pub:now',
  SCHEDULE_PROMPT = 'pub:sch',
  CANCEL_SCHEDULE_PROMPT = 'pub:sch_c',
  CANCEL_SCHEDULE_CONFIRM = 'pub:sch_ok',
  RETRY_PUBLISH = 'pub:ret',

  // Scheduling Presets
  PRESET_1H = 'sch_p:1h',
  PRESET_3H = 'sch_p:3h',
  PRESET_TOMORROW_10 = 'sch_p:t10',
  PRESET_TOMORROW_18 = 'sch_p:t18',
}

export interface PostCallbackPayload {
  action: PostCallbackAction;
  postId: string;
  expectedVersion: number;
}

export class CallbackCodec {
  /**
   * Serializes action, postId, and expectedVersion into compact callback data string.
   * Throws Error if result exceeds 64 bytes.
   */
  static encode(action: PostCallbackAction, postId: string, expectedVersion: number): string {
    const serialized = `${action}:${postId}:${expectedVersion}`;
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > 64) {
      throw new Error(`Callback data exceeds 64-byte limit (${byteLength} bytes): "${serialized}"`);
    }
    return serialized;
  }

  /**
   * Serializes a read-only post view action without version tracking.
   */
  static encodeView(postId: string): string {
    return `${PostCallbackAction.VIEW_POST}:${postId}`;
  }

  /**
   * Deserializes callback data string.
   * Returns null if string does not match expected format.
   */
  static decode(data: string): PostCallbackPayload | null {
    if (!data || typeof data !== 'string') return null;

    const parts = data.split(':');
    if (parts.length < 3) return null;

    // Handle compound prefixes like 'p:sub', 'r:app', 'pub:now', 'sch_p:1h'
    const versionStr = parts.pop();
    const postId = parts.pop();
    const actionStr = parts.join(':');

    if (!postId || !versionStr) return null;

    const version = parseInt(versionStr, 10);
    if (Number.isNaN(version) || version < 1) return null;

    const validActions = Object.values(PostCallbackAction) as string[];
    if (!validActions.includes(actionStr)) return null;

    return {
      action: actionStr as PostCallbackAction,
      postId,
      expectedVersion: version,
    };
  }
}
```

### 7.2 Russian Status Formatter (`status-formatter.util.ts`)

```typescript
import { PostStatus } from '@prisma/client';

export interface StatusMetadata {
  label: string;
  emoji: string;
  description: string;
}

export const POST_STATUS_METADATA: Record<PostStatus, StatusMetadata> = {
  [PostStatus.DRAFT]: {
    label: 'Черновик',
    emoji: '📝',
    description: 'Материал редактируется автором.',
  },
  [PostStatus.PENDING_REVIEW]: {
    label: 'На согласовании',
    emoji: '⏳',
    description: 'Ожидает проверки редактором.',
  },
  [PostStatus.APPROVED]: {
    label: 'Одобрено',
    emoji: '✅',
    description: 'Материал проверен и готов к публикации.',
  },
  [PostStatus.NEEDS_REVISION]: {
    label: 'Требуется доработка',
    emoji: '↩️',
    description: 'Редактор вернул публикацию с замечаниями.',
  },
  [PostStatus.REJECTED]: {
    label: 'Отклонено',
    emoji: '❌',
    description: 'Публикация отклонена редактором.',
  },
  [PostStatus.SCHEDULED]: {
    label: 'Запланировано',
    emoji: '🕒',
    description: 'Публикация ожидает наступления указанного времени.',
  },
  [PostStatus.PUBLISHING]: {
    label: 'Публикуется',
    emoji: '🚀',
    description: 'Идет отправка сообщения в канал...',
  },
  [PostStatus.PUBLISHED]: {
    label: 'Опубликовано',
    emoji: '🎉',
    description: 'Пост успешно опубликован в канале.',
  },
  [PostStatus.PUBLISH_FAILED]: {
    label: 'Ошибка публикации',
    emoji: '🚨',
    description: 'Не удалось опубликовать пост. Требуется повтор.',
  },
  [PostStatus.CANCELLED]: {
    label: 'Отменено',
    emoji: '🚫',
    description: 'Публикация отменена.',
  },
};

export function formatStatusBadge(status: PostStatus, version: number): string {
  const meta = POST_STATUS_METADATA[status];
  return `${meta.emoji} ${meta.label} (v${version})`;
}
```

### 7.3 Keyboard Builders (`keyboards/post-controls.keyboard.ts`)

```typescript
import { InlineKeyboard } from 'grammy';
import { Post, PostStatus } from '@prisma/client';
import { CallbackCodec, PostCallbackAction } from '../utils/callback-data.codec';

export interface UserContextPermissions {
  isSuperAdmin: boolean;
  canApprove: boolean;
  canPublish: boolean;
  isAuthor: boolean;
}

export class PostControlsKeyboardBuilder {
  /**
   * Constructs the action keyboard for the Post Preview Control Card.
   */
  static buildAuthorControls(post: Post, perms: UserContextPermissions): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Editable status: DRAFT or NEEDS_REVISION
    if (post.status === PostStatus.DRAFT || post.status === PostStatus.NEEDS_REVISION) {
      // Row 1: Primary Action (Submit for review)
      kb.text(
        '✅ На согласование',
        CallbackCodec.encode(PostCallbackAction.SUBMIT_FOR_REVIEW, post.id, post.version),
      );
      kb.row();

      // Row 2: Editing controls
      kb.text(
        '✏️ Редактировать',
        CallbackCodec.encode(PostCallbackAction.EDIT_POST, post.id, post.version),
      );
      kb.text(
        '🖼 Медиа',
        CallbackCodec.encode(PostCallbackAction.MANAGE_MEDIA, post.id, post.version),
      );
      kb.row();

      // Row 3: Destructive
      kb.text(
        '🗑 Удалить черновик',
        CallbackCodec.encode(PostCallbackAction.DELETE_DRAFT_PROMPT, post.id, post.version),
      );
      kb.row();
    }

    // Status: APPROVED
    if (post.status === PostStatus.APPROVED) {
      if (perms.canPublish || perms.isSuperAdmin) {
        kb.text(
          '🚀 Опубликовать',
          CallbackCodec.encode(PostCallbackAction.PUBLISH_NOW, post.id, post.version),
        );
        kb.text(
          '📅 Запланировать',
          CallbackCodec.encode(PostCallbackAction.SCHEDULE_PROMPT, post.id, post.version),
        );
        kb.row();
      }
    }

    // Status: SCHEDULED
    if (post.status === PostStatus.SCHEDULED) {
      if (perms.canPublish || perms.canApprove || perms.isSuperAdmin) {
        kb.text(
          '❌ Отменить расписание',
          CallbackCodec.encode(PostCallbackAction.CANCEL_SCHEDULE_PROMPT, post.id, post.version),
        );
        kb.row();
      }
    }

    // Status: PUBLISH_FAILED
    if (post.status === PostStatus.PUBLISH_FAILED) {
      if (perms.canPublish || perms.isSuperAdmin) {
        kb.text(
          '🔁 Повторить публикацию',
          CallbackCodec.encode(PostCallbackAction.RETRY_PUBLISH, post.id, post.version),
        );
        kb.row();
      }
    }

    // Navigation back
    kb.text('🔙 В главное меню', 'nav:main');
    return kb;
  }

  /**
   * Constructs the action keyboard for the Editor Review Card.
   */
  static buildReviewControls(post: Post, currentIndex: number, totalCount: number): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Row 1: Decision actions
    kb.text(
      '✅ Одобрить',
      CallbackCodec.encode(PostCallbackAction.APPROVE, post.id, post.version),
    );
    kb.text(
      '↩️ На доработку',
      CallbackCodec.encode(PostCallbackAction.REQUEST_REVISION, post.id, post.version),
    );
    kb.row();

    // Row 2: Secondary actions
    kb.text(
      '✏️ Редактировать',
      CallbackCodec.encode(PostCallbackAction.EDIT_POST, post.id, post.version),
    );
    kb.text(
      '❌ Отклонить',
      CallbackCodec.encode(PostCallbackAction.REJECT_PROMPT, post.id, post.version),
    );
    kb.row();

    // Row 3: Pagination if multiple pending
    if (totalCount > 1) {
      if (currentIndex > 0) {
        kb.text('⬅️ Предыдущий', `q:card:${post.channelId}:${currentIndex - 1}`);
      }
      if (currentIndex < totalCount - 1) {
        kb.text('Следующий ➡️', `q:card:${post.channelId}:${currentIndex + 1}`);
      }
      kb.row();
    }

    kb.text('🔙 В главное меню', 'nav:main');
    return kb;
  }

  /**
   * Constructs confirmation dialog keyboard for destructive actions.
   */
  static buildConfirmationKeyboard(
    confirmAction: PostCallbackAction,
    postId: string,
    version: number,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text('⚠️ Да, подтвердить', CallbackCodec.encode(confirmAction, postId, version))
      .text('🔙 Отмена', CallbackCodec.encodeView(postId));
  }
}
```

### 7.4 Telegram Preview Service (`services/telegram-preview.service.ts`)

```typescript
import { Injectable } from '@nestjs/common';
import { Api } from 'grammy';
import { Post, PostTemplate, PostMedia, User, Channel, PostReview } from '@prisma/client';
import { TelegramRenderer } from '../rendering/telegram-renderer.service';
import { TelegramPublisherService } from '../../infrastructure/telegram-api/telegram-publisher.service';
import { PostControlsKeyboardBuilder, UserContextPermissions } from '../keyboards/post-controls.keyboard';
import { formatStatusBadge } from '../utils/status-formatter.util';
import { formatChannelDate } from '../channels/utils/timezone.util';

export type PostWithRelations = Post & {
  template: PostTemplate;
  media: PostMedia[];
  author: User;
  channel: Channel;
  reviews?: (PostReview & { reviewer: Partial<User> })[];
};

@Injectable()
export class TelegramPreviewService {
  constructor(
    private readonly renderer: TelegramRenderer,
    private readonly publisher: TelegramPublisherService,
  ) {}

  /**
   * Renders the canonical post preview and sends companion Control Card.
   */
  async sendPostPreview(
    api: Api,
    chatId: number | string,
    post: PostWithRelations,
    perms: UserContextPermissions,
  ): Promise<number> {
    // 1. Render Canonical Preview via TelegramRenderer (AGENTS.md § 15)
    const payload = await this.renderer.render(post, post.template, post.media);

    // 2. Transmit each outgoing preview message
    for (const msg of payload.messages) {
      await this.publisher.publishOutgoingMessage(chatId, msg);
    }

    // 3. Construct and Transmit the Companion Control Card
    const cardHtml = this.formatControlCardHtml(post);
    const keyboard = PostControlsKeyboardBuilder.buildAuthorControls(post, perms);

    const controlMessageId = await this.publisher.sendMessage(chatId, cardHtml, {
      parseMode: 'HTML',
    });

    // Attach inline keyboard to the control message
    await api.editMessageReplyMarkup(chatId, controlMessageId, {
      reply_markup: keyboard,
    });

    return controlMessageId;
  }

  /**
   * Updates an existing Control Card in-place (e.g. on status change or OCC conflict).
   */
  async updateControlCard(
    api: Api,
    chatId: number | string,
    messageId: number,
    post: PostWithRelations,
    perms: UserContextPermissions,
    overrideNotice?: string,
  ): Promise<void> {
    const cardHtml = this.formatControlCardHtml(post, overrideNotice);
    const keyboard = PostControlsKeyboardBuilder.buildAuthorControls(post, perms);

    await api.editMessageText(chatId, messageId, cardHtml, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  private formatControlCardHtml(post: PostWithRelations, notice?: string): string {
    const authorName =
      [post.author.firstName, post.author.lastName].filter(Boolean).join(' ') ||
      post.author.username ||
      `ID ${post.author.telegramId.toString()}`;

    const updatedAtStr = formatChannelDate(post.updatedAt, post.channel.timezone);

    let html =
      `📋 <b>Панель управления публикацией</b>\n` +
      `──────────────────────────\n` +
      `📌 <b>Статус:</b> ${formatStatusBadge(post.status, post.version)}\n` +
      `📢 <b>Канал:</b> ${post.channel.title}\n` +
      `📝 <b>Шаблон:</b> ${post.template.name}\n` +
      `👤 <b>Автор:</b> ${authorName}\n` +
      `🕒 <b>Обновлено:</b> ${updatedAtStr}\n`;

    if (post.scheduledAt) {
      const scheduledStr = formatChannelDate(post.scheduledAt, post.channel.timezone);
      html += `⏰ <b>Запланировано на:</b> ${scheduledStr}\n`;
    }

    // If recent revision comment exists, highlight it
    const latestReview = post.reviews?.[0];
    if (latestReview?.comment && latestReview.action === 'REQUEST_REVISION') {
      html +=
        `──────────────────────────\n` +
        `⚠️ <b>Замечания редактора:</b>\n` +
        `«<i>${latestReview.comment}</i>»\n`;
    }

    if (notice) {
      html += `──────────────────────────\n${notice}\n`;
    }

    html += `──────────────────────────`;
    return html;
  }
}
```

---

## 8. Implementation & Verification Recommendations for the Worker

### 8.1 Suggested Order of Implementation

```text
Step 1: Codec & Status Formatter Utilities
  ├── Implement callback-data.codec.ts
  ├── Implement status-formatter.util.ts
  └── Unit test: 64-byte strict limit verification, parsing & round-trip encoding

Step 2: Keyboard Builders
  ├── Implement PostControlsKeyboardBuilder (Author & Reviewer controls)
  ├── Implement Confirmation keyboards
  └── Unit test: Verify buttons generated match status matrix and permissions

Step 3: NotificationService Real Telegram Delivery
  ├── Inject TelegramPublisherService into NotificationService
  ├── Add isolated try/catch delivery block in recordAndDispatch()
  └── Integration test: Verify domain events result in publisher.sendMessage calls

Step 4: TelegramPreviewService & Companion Control Card
  ├── Implement TelegramPreviewService bridging TelegramRenderer and Api
  └── Integration test: Single text, single photo, and media_group preview rendering

Step 5: Review Queue & Review Handlers
  ├── Implement ReviewQueueHandler (list, pagination, card deck)
  ├── Implement Approve, Request Revision (with Redis state), and Reject flows
  └── Integration test: Full review cycle with OCC checks and comment persistence

Step 6: Publication & Scheduling Handlers
  ├── Implement Publish Now handler (calling PublishingService.enqueuePublish)
  ├── Implement Scheduling handler (timezone prompt, presets, schedulePost)
  └── Implement Cancel Schedule & Retry Publication handlers

Step 7: Concurrency & Stale Button Verification
  ├── Add adversarial tests for double-clicks, stale version clicks, and concurrent edits
```

### 8.2 Testing Strategy & Verification Methods

1. **Unit Testing**:
   - `callback-data.codec.spec.ts`: Test that every action with UUID and up to 4-digit version numbers generates $< 64$ bytes. Test decoding of malformed or truncated payloads.
   - `post-controls.keyboard.spec.ts`: Assert that Author cannot see "Publish Now" without `canPublish`, that Editor sees "Approve" only on `PENDING_REVIEW`, etc.
   - `status-formatter.spec.ts`: Verify that all 10 `PostStatus` enums map to friendly Russian badges.

2. **Integration Testing**:
   - `preview-rendering.spec.ts`: Test rendering of posts with no media, single photo with caption, and 3-photo media group with long caption. Verify the Companion Control Card message ID is tracked.
   - `review-workflow-concurrency.spec.ts`:
     - Test that clicking `Approve` with `expectedVersion = 1` when DB is at `version = 2` triggers toast alert and card refresh without state transition.
     - Test that `Request Revision` requires non-empty text and transitions to `NEEDS_REVISION` with review record in PostgreSQL.
   - `scheduling-timezone.spec.ts`:
     - Test date parsing in `Europe/Kyiv`.
     - Test that scheduling in the past is rejected with empathetic Russian validation message.
     - Test that delayed BullMQ job is properly scheduled and cancellable.

3. **E2E Alignment**:
   - Verify that the critical editorial path:
     `DRAFT -> Submit for Review -> PENDING_REVIEW -> Request Revision -> NEEDS_REVISION -> Resubmit -> APPROVED -> Schedule / Publish -> PUBLISHED`
     executes seamlessly through Telegram handlers, PostgreSQL, and the BullMQ worker.
