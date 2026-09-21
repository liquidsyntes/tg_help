# Milestone 5: Post Creation Wizard, Autosave, and Media Handling

## Executive Summary
This report defines the comprehensive architecture and concrete implementation design for Milestone 5's Post Creation Wizard, Immediate PostgreSQL Autosave, and Media Handling. By strictly separating Telegram transport handlers from domain logic (AGENTS.md §3, §5) and using PostgreSQL as the single source of truth (AGENTS.md §11, §12), all post drafts survive arbitrary process or container restarts with zero state loss, zero in-memory dependencies, and atomic Optimistic Concurrency Control (OCC) versioning.

---

## 1. System Architecture & Module Boundaries

In strict compliance with **AGENTS.md §3** and **§5**, Telegram handlers must never directly execute database queries, modify post status, or run template validations. Handlers act exclusively as a transport adapter.

```text
Incoming Telegram Update (Message / CallbackQuery)
       │
       ▼
AuthMiddleware (m5_explorer_1) -> Validates User & Attaches AuthUser to ctx.state
       │
       ▼
Telegram Transport Layer (src/modules/telegram/handlers/)
  ├── PostWizardHandler (parses updates, extracts text/media/callbacks)
  └── DraftManagerHandler (parses /drafts, resume, delete, edit callbacks)
       │
       ▼ (Passes Domain DTOs / Commands — NO Context objects)
Application Services Layer (src/modules/telegram/services/)
  ├── PostWizardService (orchestrates step transitions, validates inputs, manages sessions)
  └── DraftManagerService (manages draft listing, resumption detection, granular field edits)
       │
       ▼
Domain & Infrastructure Services (Existing M1-M4 Modules)
  ├── PostsService & PostsRepository (createDraft, autosaveStep, updateWithOcc)
  ├── TemplatesService & TemplateValidator (getActiveTemplates, validateField)
  ├── MediaService & MediaDetector (attachMedia, attachMediaBatch, isDocumentAsVideo)
  ├── ChannelsService (autoSkipSingleChannel, getUserAuthorizedChannels)
  └── RedisService (ephemeral session pointers & album debounce buffers)
```

---

## 2. Interactive Post Creation Wizard

### 2.1 Step 1: Channel Selection (tasks.md §9, PROJECT.md F-05, F-07)
1. **Trigger**: Author taps `➕ Создать пост` or executes `/newpost`.
2. **Channel Resolution**:
   - The handler invokes `ChannelsService.autoSkipSingleChannel(actorId)`.
   - **Case A (Single Channel)**: If user has access to exactly one channel (`singleChannel !== null`):
     - The channel selection step is **automatically skipped** (F-05).
     - The channel ID is saved into the user's wizard session in Redis (`channelId`).
     - The wizard immediately transitions to Step 2 (Template Selection).
   - **Case B (Multiple Channels)**: If user is member of 2+ channels (`mustChoose === true`):
     - Renders an inline keyboard displaying authorized channels:
       ```text
       📢 Выберите канал для публикации:
       [ 📢 Основной канал ] (callback: wiz:chan:<channelId>)
       [ 🧪 Тестовый канал ] (callback: wiz:chan:<channelId>)
       [ ❌ Отмена ]          (callback: wiz:cancel)
       ```
     - Upon button press, `channelId` is stored in the wizard session and user proceeds to Step 2.
   - **Case C (Zero Channels)**: If `channels.length === 0`:
     - Renders empathetic message: `⚠️ У вас нет доступа ни к одному каналу для создания публикаций. Обратитесь к администратору.`

### 2.2 Step 2: Template Selection (tasks.md §9, §14, PROJECT.md F-08)
1. **Fetch Active Templates**:
   - `TemplatesService.getActiveTemplates()` returns all active templates from PostgreSQL (`PostTemplate` rows ordered by `createdAt ASC`).
   - Standard seeded templates (tasks.md §9, `prisma/seed.ts`):
     1. `📝 Лонг-рид` (`longread`)
     2. `📢 Анонс` (`announcement`)
     3. `🖼 Фото` (`photo`)
     4. `🎬 Видео` (`video`)
     5. `📰 Новость` (`news`)
     6. `✍️ Свободный формат` (`freeform`)
2. **Template Selection Keyboard**:
   ```text
   📄 Выберите шаблон публикации:
   [ 📝 Лонг-рид ]       [ 📢 Анонс ]
   [ 🖼 Фото ]           [ 🎬 Видео ]
   [ 📰 Новость ]        [ ✍️ Свободный формат ]
   [ ❌ Отмена ]
   ```
   *Callback data format*: `wiz:tpl:<templateId>`
3. **Immediate Draft Initialization in PostgreSQL**:
   - Once the user selects a template, **both `channelId` and `templateId` are known**.
   - `PostWizardService` immediately calls:
     ```ts
     const post = await this.postsService.createDraft({
       authorId: user.id,
       channelId,
       templateId,
       templateVersion: template.version,
       contentJson: {},
       metadataJson: { wizardStep: 'field', currentFieldIndex: 0 },
     });
     ```
   - **PostgreSQL row is created**: `status = DRAFT`, `version = 1`.
   - Active session stored in Redis:
     ```json
     {
       "postId": "post-uuid",
       "channelId": "channel-uuid",
       "templateId": "template-uuid",
       "step": "FIELD_INPUT",
       "fieldIndex": 0,
       "version": 1
     }
     ```
   - Immediately prompts for the first field!

### 2.3 Step 3: Dynamic Field Collection Loop (tasks.md §9, §14, AGENTS.md §14)
The field collection loop is entirely data-driven by the template's `schemaJson.fields` definition. Adding or updating a template never requires altering bot code.

#### Field Prompt Rendering
For field definition `field = schema.fields[fieldIndex]`:
```text
Шаг {fieldIndex + 1} из {fields.length}: {field.label}

{field.hint}

{field.required ? '🔴 Обязательное поле' : '⚪️ Необязательное поле'} (макс. {field.maxLength || 4096} симв.)
```
**Inline Actions**:
- If `!field.required`: Show inline button `[ ⏭ Пропустить поле ]` (`wiz:skip:<field.key>`).
- Always show `[ ❌ Сохранить и выйти ]` (`wiz:exit`).

#### Validation & Empathetic Error Hints
1. Input is validated using `TemplateValidator.validateField(fieldDef, rawInput)`:
   - Coerces numbers and trims text (`coerceFieldValue`).
   - Validates `required`, `minLength`, `maxLength`, `url` prefix (`http://` or `https://`), numeric ranges (`min`, `max`, `integer`), and custom `regex`.
2. **Empathetic Russian Feedback**:
   If validation fails, the bot does NOT clear draft state. It replies with clear, constructive feedback and prompts the user to re-enter:
   ```text
   ⚠️ Ошибка валидации:
   {error.message}

   💡 Подсказка: {field.hint}
   Пожалуйста, введите значение ещё раз:
   ```
   *Examples of built-in messages from `TemplateValidator`:*
   - `Поле «Заголовок» обязательно для заполнения.`
   - `Поле «Заголовок» слишком короткое: минимум 10 симв. (сейчас: 4).`
   - `Поле «Основной текст» превышает допустимый лимит (3620/3500 симв.). Пожалуйста, сократите текст.`
   - `Поле «Ссылка на источник» должно содержать корректную ссылку, начинающуюся с https:// или http://.`
   - `Поле «Количество» должно быть целым числом.`

#### Telegram Native Formatting to HTML
For `rich_text` fields:
- Users can format text using Telegram's built-in formatting popups (Bold, Italic, Link, Quote, Code). Telegram transmits these as `ctx.message.entities`.
- The bot converts `ctx.message.text` + `entities` into valid Telegram HTML, then sanitizes via `HtmlSanitizer.sanitize(...)`.
- Users can also type raw HTML tags (`<b>...</b>`, `<i>...</i>`, `<code>...</code>`). Both modes are fully supported.

---

## 3. Immediate PostgreSQL Autosave & Interruption/Resumption

### 3.1 Immediate Persistence Pipeline (AGENTS.md §11, §12)
Every single interaction that introduces new data immediately triggers a database write with Optimistic Concurrency Control:

| Step | Database Action | Service Method | OCC Version |
|---|---|---|---|
| Channel & Template Selected | `INSERT INTO posts (status: DRAFT)` | `PostsService.createDraft` | `1` |
| Field Value Entered | `UPDATE posts SET content_json = ...` | `PostsService.autosaveStep` | `v -> v + 1` |
| Field Skipped | `UPDATE posts SET content_json = ...` | `PostsService.autosaveStep` (null) | `v -> v + 1` |
| Single Media Attached | `INSERT INTO post_media` + `UPDATE posts` | `MediaService.attachMedia` | `v -> v + 1` |
| Media Group Attached | `INSERT INTO post_media (batch)` + `UPDATE posts` | `MediaService.attachMediaBatch` | `v -> v + 1` |
| Media Removed | `DELETE FROM post_media` + `UPDATE posts` | `MediaService.removeMedia` | `v -> v + 1` |
| Draft Soft-Deleted | `UPDATE posts SET deleted_at = NOW()` | `PostsService.softDeletePost` | `v -> v + 1` |

### 3.2 Autosave Silent Rule (F-40)
In accordance with **tasks.md §24** and **PROJECT.md F-40**:
- Routine autosaves emit **ZERO** notifications to editors or channels.
- Audit records (`POST_UPDATED`, `MEDIA_ADDED`) are logged silently without side-effect event dispatches.

### 3.3 Draft Interruption & Resumption
Since PostgreSQL persists the draft at every step, in-memory sessions are disposable. If the bot process crashes, Redis restarts, or the author leaves Telegram for days, the draft remains 100% intact.

#### Accessing Drafts
1. Author taps `📝 Мои материалы` or enters `/drafts`.
2. Handler queries `PostsRepository.findByAuthor(userId, PostStatus.DRAFT)` and `findByAuthor(userId, PostStatus.NEEDS_REVISION)`.
3. If no drafts exist: `У вас нет сохранённых черновиков.`
4. If drafts exist, renders a paginated draft list:
   ```text
   📝 Ваши черновики:

   1. 📝 Лонг-рид: «Квантовый процессор»
      Канал: Основной канал • Изменен: 21.09.2026 22:15
      [ ✏️ Продолжить ] (draft:res:<postId>)  [ 🗑 Удалить ] (draft:del:<postId>)

   2. 📢 Анонс: «Без названия»
      Канал: Основной канал • Изменен: 21.09.2026 21:30
      [ ✏️ Продолжить ] (draft:res:<postId>)  [ 🗑 Удалить ] (draft:del:<postId>)
   ```

#### Resumption Routing Algorithm
When author clicks `[ ✏️ Продолжить ]`:
```ts
const post = await this.postsService.getPost(postId);
const template = await this.templatesService.getById(post.templateId);
const schema = template.schemaJson as TemplateSchema;
const content = (post.contentJson as Record<string, unknown>) || {};

// Find first missing required field
const firstUnfilledIndex = schema.fields.findIndex(
  (f) => f.required && (content[f.key] === undefined || content[f.key] === null || String(content[f.key]).trim() === '')
);

if (firstUnfilledIndex !== -1) {
  // Resume wizard directly at the missing field
  await this.restoreSession(user.id, {
    postId: post.id,
    templateId: post.templateId,
    channelId: post.channelId,
    step: 'FIELD_INPUT',
    fieldIndex: firstUnfilledIndex,
    version: post.version,
  });
  return this.renderFieldPrompt(ctx, post, template, firstUnfilledIndex);
}

// If all required fields are present, display Draft Control Card
return this.renderDraftCard(ctx, post, template);
```

#### Draft Control Card & Granular Field Editing (F-14)
When resuming a draft with filled fields:
```text
📄 Черновик: {template.name}
Канал: {channel.title} (Версия {post.version})

Заполненные поля:
• {field1.label}: {field1.preview}
• {field2.label}: {field2.preview}
• Прикреплено медиа: {mediaCount} шт.

[ ✏️ Редактировать поля ]  [ 🖼 Добавить медиа ]
[ 👀 Предпросмотр ]        [ 🚀 На согласование ]
[ 🗑 Удалить черновик ]
```
When user taps `[ ✏️ Редактировать поля ]`:
- Displays inline buttons for each individual field (`draft:edit:<postId>:<field.key>`).
- User selects field -> prompts for new value -> validates -> autosaves under OCC -> returns to Draft Control Card.
- **No need to re-enter other fields!**

#### Soft Deletion Confirmation (F-15, AGENTS.md §54)
- When user taps `[ 🗑 Удалить ]`:
  ```text
  ⚠️ Вы уверены, что хотите удалить черновик «{title}»?
  Это действие необратимо.
  [ 🗑 Да, удалить ] (draft:cdel:<postId>:<version>)  [ 🔙 Отмена ] (draft:cancel)
  ```
- Upon confirmation: `PostsService.softDeletePost(postId, expectedVersion, actorId)`.

---

## 4. Media Attachment Flow

### 4.1 Zero-Download file_id Persistence (AGENTS.md §19, PROJECT.md F-21)
The bot **never downloads binary files** to local disk or object storage. It stores Telegram's file references directly:
- `telegram_file_id`: Used directly in publication calls (`sendPhoto`, `sendVideo`, `sendMediaGroup`).
- `telegram_file_unique_id`: Unique identifier across bot instances, indexed for deduplication.
- Metadata: `fileName`, `mimeType`, `fileSize`, `caption`, `sortOrder`.

### 4.2 Supported Media Types
1. `photo`: Largest `PhotoSize` item from `ctx.message.photo` (`photo[photo.length - 1]`).
2. `video`: `ctx.message.video` (`file_id`, `file_name`, `mime_type`, `file_size`).
3. `animation`: `ctx.message.animation` (GIF/video loop).
4. `document`: `ctx.message.document`.
5. `document-as-video`: Evaluated by `isDocumentAsVideo`:
   - Checks video mime types (`video/mp4`, `video/quicktime`, `video/x-matroska`, etc.) and extensions (`.mp4`, `.mov`, `.mkv`, `.avi`, etc.).
   - Stored as `MediaType.DOCUMENT` with enriched flag `isVideoDocument: true`.

### 4.3 Media Group (Album) Debouncing / Batch Collector Pattern
**The Problem**: Telegram sends album items as separate HTTP updates within milliseconds of each other, sharing the same `media_group_id`. If each update executed an individual database update, concurrent OCC version checks would conflict (`PostConflictException`).

**The Solution**:
```text
Telegram Update (with media_group_id)
       │
       ▼
Extract AttachMediaDto & append to Redis List: media_group:buf:{mediaGroupId}
       │
       ▼
Set / Refresh Debounce Timer in Redis (600ms inactivity window)
       │
       ▼ (Timer expires after all items arrive)
Batch Collector fires:
  1. Fetch all items from Redis buffer (LRANGE)
  2. Load latest post from DB (retrieves current post.version)
  3. Validate batch against TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE (<= 10)
  4. Call MediaService.attachMediaBatch(postId, post.version, actorId, batch)
       │
       ▼
Single Atomic Database Transaction:
  ├── INSERT post_media (N rows with consecutive sort_order)
  ├── UPDATE posts (version = version + 1)
  └── INSERT audit_log (MEDIA_ADDED with count N)
       │
       ▼
Send single summary reply: "✅ Загружена медиагруппа: {N} медиа добавлено."
```

### 4.4 Media Validation Rules (tasks.md §18, AGENTS.md §19)
Checked via `MediaService.validateMediaForPost`:
- **Template Compatibility**: Verifies media type is listed in `template.supportedMediaTypes`.
- **Mandatory Media**: Templates like `photo` or `video` require at least one item before submission.
- **Album Invariants**:
  - Albums must contain between 2 and 10 items (`TELEGRAM_LIMITS.MIN_MEDIA_GROUP_SIZE` .. `MAX_MEDIA_GROUP_SIZE`).
  - Animations (GIFs) cannot be grouped in albums (`sendAnimation` required).
  - Documents and photos/videos cannot be mixed in the same album.

---

## 5. Technical Specifications: DTOs & Interfaces

### 5.1 Wizard Session State in Redis
Key format: `wizard:session:{userId}` (TTL: 86400s)
```ts
export type WizardStep = 'CHANNEL_SELECT' | 'TEMPLATE_SELECT' | 'FIELD_INPUT' | 'MEDIA_UPLOAD' | 'EDIT_FIELD';

export interface WizardSessionData {
  postId?: string;
  channelId?: string;
  templateId?: string;
  step: WizardStep;
  fieldIndex?: number;
  fieldKey?: string;
  expectedVersion?: number;
  mode?: 'CREATE' | 'EDIT';
}
```

### 5.2 PostWizardService Interface
```ts
export interface PostWizardService {
  startWizard(actorId: string): Promise<WizardStartResult>;
  selectChannel(actorId: string, channelId: string): Promise<WizardChannelSelectedResult>;
  selectTemplate(actorId: string, templateId: string): Promise<WizardTemplateSelectedResult>;
  processFieldInput(actorId: string, rawInput: string, entities?: MessageEntity[]): Promise<WizardStepResult>;
  skipField(actorId: string, fieldKey: string): Promise<WizardStepResult>;
  processMediaUpload(actorId: string, mediaDto: AttachMediaDto, mediaGroupId?: string): Promise<WizardMediaResult>;
  cancelWizard(actorId: string): Promise<void>;
  getSession(actorId: string): Promise<WizardSessionData | null>;
}
```

### 5.3 DraftManagerService Interface
```ts
export interface DraftManagerService {
  listDrafts(actorId: string): Promise<Post[]>;
  getDraftDetails(actorId: string, postId: string): Promise<DraftDetailsResult>;
  resumeDraft(actorId: string, postId: string): Promise<DraftResumeResult>;
  startEditField(actorId: string, postId: string, fieldKey: string): Promise<DraftEditPromptResult>;
  submitEditedField(actorId: string, postId: string, fieldKey: string, rawValue: string, entities?: MessageEntity[]): Promise<Post>;
  deleteDraft(actorId: string, postId: string, expectedVersion: number): Promise<Post>;
}
```

### 5.4 Telegram Callback Data Conventions (<= 64 Bytes)
| Pattern | Purpose | Byte Length |
|---|---|---|
| `wiz:chan:<channelId>` | Channel selected in wizard | ~46 bytes |
| `wiz:tpl:<templateId>` | Template selected in wizard | ~44 bytes |
| `wiz:skip:<fieldKey>` | Skip optional field | ~15-25 bytes |
| `wiz:done_media` | Finish media upload | 14 bytes |
| `wiz:cancel` | Cancel wizard / save draft | 10 bytes |
| `draft:res:<postId>` | Resume draft | 46 bytes |
| `draft:del:<postId>` | Prompt delete draft | 46 bytes |
| `draft:cdel:<postId>:<v>` | Confirm delete draft with OCC version | ~48-52 bytes |
| `draft:edit:<postId>:<key>` | Select specific field to edit | ~50-60 bytes |

---

## 6. Implementation Recommendations for Worker

### 6.1 Recommended File Layout
```text
src/modules/telegram/
├── telegram.module.ts
├── telegram-bot.service.ts         (from m5_explorer_1)
├── middleware/
│   └── auth.middleware.ts          (from m5_explorer_1)
├── filters/
│   └── telegram-exception.filter.ts(from m5_explorer_1)
├── services/
│   ├── post-wizard.service.ts      <-- M5 Explorer 2 (Wizard orchestration & autosave)
│   └── draft-manager.service.ts    <-- M5 Explorer 2 (Draft listing, resumption, field editing)
├── handlers/
│   ├── post-wizard.handler.ts      <-- M5 Explorer 2 (grammY wizard listeners)
│   ├── draft-manager.handler.ts    <-- M5 Explorer 2 (grammY draft manager listeners)
│   ├── post-preview.handler.ts     (from m5_explorer_3)
│   └── review-queue.handler.ts     (from m5_explorer_3)
└── utils/
    ├── media-extractor.util.ts     <-- M5 Explorer 2 (extracts AttachMediaDto from ctx)
    ├── entity-converter.util.ts    <-- M5 Explorer 2 (converts Telegram entities to HTML)
    └── keyboard-builder.util.ts    <-- Reusable inline keyboard builder
```

### 6.2 Step-by-Step Implementation Steps
1. **Create Utility Extractors**:
   - Implement `media-extractor.util.ts` to transform grammY photos, videos, animations, and documents into `AttachMediaDto`.
   - Implement `entity-converter.util.ts` to parse Telegram entities into clean HTML tags.
2. **Implement Application Services**:
   - Implement `PostWizardService` injecting `PostsService`, `TemplatesService`, `TemplateValidator`, `ChannelsService`, `MediaService`, and `RedisService`.
   - Implement `DraftManagerService` for listing drafts and field-level updates.
3. **Implement grammY Handlers**:
   - Implement `PostWizardHandler`: listens for `/newpost`, command `➕ Создать пост`, callback queries `wiz:*`, text messages (field input), and media messages (photo, video, document).
   - Implement `DraftManagerHandler`: listens for `/drafts`, command `📝 Мои материалы`, callback queries `draft:*`.
4. **Wire into TelegramModule**:
   - Register services and handlers in `TelegramModule`.
   - Ensure `PostsModule`, `TemplatesModule`, `MediaModule`, `ChannelsModule`, and `RedisModule` are imported.
5. **Add Comprehensive Unit Tests**:
   - Wizard step progression with mocked services.
   - Autosave verification at each step.
   - Media album batching debouncer tests.
   - Resumption logic with missing vs complete fields.
