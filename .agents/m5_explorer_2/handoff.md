# Handoff Report — m5_explorer_2: Post Creation Wizard, Autosave, and Media Handling

## 1. Observation
1. **Existing PostsService & Autosave APIs**:
   - `src/modules/posts/posts.service.ts` line 42: `createDraft(dto: CreateDraftDto): Promise<Post>` initializes draft with `version: 1`, `status: PostStatus.DRAFT`.
   - `src/modules/posts/posts.service.ts` lines 82-128: `autosaveStep(postId, expectedVersion, actorId, fieldKey, fieldValue): Promise<Post>` executes atomic OCC update and records silent audit log without emitting notifications (F-40 compliance).
   - `src/modules/posts/posts.repository.ts` lines 61-105: `updateWithOcc` checks `WHERE id = postId AND version = expectedVersion AND deleted_at IS NULL`, increments version, and throws `PostConflictException` on version mismatch.
   - `src/modules/posts/posts.repository.ts` lines 153-166: `findByAuthor(authorId: string, status?: PostStatus): Promise<Post[]>` retrieves posts for draft resumption.

2. **Template Validation & Empathetic Messages**:
   - `src/modules/templates/templates.service.ts` line 32: `getActiveTemplates(): Promise<PostTemplate[]>` retrieves active templates sorted by `createdAt asc`.
   - `src/modules/templates/template.validator.ts` lines 93-238: `validateField(fieldDef, rawValue)` provides built-in empathetic Russian error hints:
     - Line 113: `"Поле «${fieldDef.label}» обязательно для заполнения."`
     - Line 146: `"Поле «${fieldDef.label}» слишком короткое: минимум ${fieldDef.minLength} симв. (сейчас: ${strVal.length})."`
     - Line 155: `"Поле «${fieldDef.label}» превышает допустимый лимит (${strVal.length}/${fieldDef.maxLength} симв.). Пожалуйста, сократите текст."`
     - Line 167: `"Поле «${fieldDef.label}» должно содержать корректную ссылку, начинающуюся с https:// или http://."`

3. **Media Handling & Zero-Download file_id Persistence**:
   - `src/modules/media/media.service.ts` lines 36-101: `attachMedia` persists `telegramFileId` directly into PostgreSQL `post_media` without downloading bytes.
   - `src/modules/media/media.service.ts` lines 107-177: `attachMediaBatch` executes a single transaction with one OCC increment for media groups.
   - `src/modules/media/utils/media-detector.util.ts` lines 27-48: `isDocumentAsVideo` detects uncompressed videos sent as documents via MIME type and file extensions (`.mp4`, `.mov`, `.mkv`, etc.).
   - `src/modules/media/utils/media-detector.util.ts` lines 56-102: `validateMediaGroupCompatibility` validates Telegram album limits (2-10 items, no GIFs, no mixing photos and documents).

4. **Channel Selection & Auto-skip**:
   - `src/modules/channels/channels.service.ts` lines 79-95: `autoSkipSingleChannel(userId)` returns `{ singleChannel, channels, mustChoose }`, directly implementing F-05.

5. **Telegram Limits**:
   - `src/common/constants/telegram-limits.ts` lines 5-29: Centralized limits (`MAX_CALLBACK_DATA_BYTES: 64`, `MAX_MEDIA_GROUP_SIZE: 10`, `MAX_MESSAGE_LENGTH: 4096`, `MAX_CAPTION_LENGTH: 1024`).

---

## 2. Logic Chain
1. **Architectural Separation (AGENTS.md §3, §5)**: Telegram updates must be parsed by transport handlers and transformed into typed domain commands before calling application services. Handlers must never perform Prisma queries directly.
2. **Immediate PostgreSQL Autosave (AGENTS.md §11, §12)**: By calling `PostsService.createDraft` at the moment a template is chosen, and `PostsService.autosaveStep` upon each valid field input, the entire state is durable in PostgreSQL. In-memory sessions are strictly ephemeral pointers.
3. **Resumption Robustness (tasks.md §9, §10)**: If the bot crashes, container restarts, or user leaves, querying `PostsRepository.findByAuthor(userId, PostStatus.DRAFT)` and comparing `post.contentJson` against `template.schemaJson.fields` instantly determines whether to prompt the next unfilled field or show the draft control card.
4. **Media Group Debouncing (tasks.md §18, AGENTS.md §13, §19)**: Telegram delivers album updates as rapid individual HTTP requests. Processing each update independently causes OCC version collisions. Debouncing updates by `media_group_id` into a Redis buffer over a 600ms window allows calling `MediaService.attachMediaBatch` in a single transaction with one version increment.
5. **Zero-Download Rule (AGENTS.md §19)**: Telegram `file_id` is sufficient for downstream publication via `TelegramPublisherService`. The bot never downloads binary files, conserving bandwidth and eliminating local storage dependencies.

---

## 3. Caveats
1. **Callback Data Size**: Telegram restricts inline keyboard callback data to 64 bytes (`TELEGRAM_LIMITS.MAX_CALLBACK_DATA_BYTES`). State payloads must not encode large objects in callback data; callbacks should use short prefixes with UUIDs (e.g. `draft:res:<uuid>` = 46 bytes).
2. **Channel Selection with 0 Channels**: If a user is registered but has no channel memberships (and is not SUPER_ADMIN), channel selection cannot proceed. The wizard must gracefully display an informative message rather than throwing an unhandled exception.
3. **Draft Completion Handshake**: When all wizard fields and media are collected, the wizard completes its data collection phase and transitions to the Preview & Review phase, which is owned by `m5_explorer_3`.

---

## 4. Conclusion
The Post Creation Wizard, Autosave, and Media Handling subsystems are fully specified and ready for implementation by the Worker. All core backend services (`PostsService`, `TemplatesService`, `TemplateValidator`, `MediaService`, `ChannelsService`) are already implemented and tested from Milestones 1-4. The implementation work for Milestone 5 consists of:
1. Two application services: `PostWizardService` and `DraftManagerService` in `src/modules/telegram/services/`.
2. Two grammY transport handlers: `PostWizardHandler` and `DraftManagerHandler` in `src/modules/telegram/handlers/`.
3. Utility extractors: `media-extractor.util.ts` and `entity-converter.util.ts` in `src/modules/telegram/utils/`.

---

## 5. Verification Method
1. **Source Code Inspection**:
   - Inspect `c:/TgHelp/.agents/m5_explorer_2/report.md` for full technical design and interface definitions.
   - Inspect `src/modules/posts/posts.service.ts`, `src/modules/templates/template.validator.ts`, and `src/modules/media/media.service.ts` to verify method signatures.
2. **Automated Test Verification**:
   - Run unit test suite: `npm test`
   - Run end-to-end scenarios: `npm run test:e2e`
3. **Invalidation Conditions**:
   - If draft fields are stored only in memory without a PostgreSQL write after each step, Autosave (AGENTS.md §12) is violated.
   - If media files are downloaded to local disk instead of persisting Telegram `file_id`, Zero-Download (AGENTS.md §19) is violated.
   - If callback data exceeds 64 bytes, Telegram API will reject inline keyboards.
