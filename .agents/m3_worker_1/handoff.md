# Milestone 3 Handoff Report

## 1. Observation

### Codebase State & Initial Verification:
1. Prior to implementation, `npm run build` completed with exit code 0.
2. Initial unit test run (`npm test`) yielded:
   ```text
   Test Suites: 9 passed, 9 total
   Tests:       156 passed, 156 total
   Time:        12.079 s
   ```
3. Initial E2E test run (`npm run test:e2e`) yielded:
   ```text
   ℹ tests 34
   ℹ suites 22
   ℹ pass 34
   ℹ fail 0
   ```
4. `src/modules/` contained only `audit`, `auth`, `channels`, `health`, `notifications`, `posts`, `reviews`, `users`. Modules `templates`, `rendering`, and `media` were not yet implemented.
5. In `src/modules/posts/posts.service.ts` (lines 129–232), `attachMedia` and `removeMedia` were implemented as local placeholders directly mutating the database and bumping version.
6. In `tests/unit/occ-state-machine.spec.ts` (line 98), `PostsService` was instantiated directly with four arguments:
   ```ts
   postsService = new PostsService(
     mockPrisma as any,
     postsRepository,
     mockAuditService as AuditService,
     mockPermissionService as PermissionService,
   );
   ```

### Implementation Observations:
1. Implemented `TemplatesModule` (`src/modules/templates/`):
   - `TemplateValidator` (`src/modules/templates/template.validator.ts`): supports `text`, `textarea`, `rich_text`, `number`, `url`, input coercion (`"42"` -> `42`, `"3,14"` -> `3.14`), empathetic Russian error messages, dual evaluation modes (`validateField`, `validateContent` with `allowPartial`), and `validateTemplateSchema`.
   - `TemplatesService` (`src/modules/templates/templates.service.ts`): active templates retrieval, lookup by ID or slug key, content validation helpers, admin CRUD with `SystemPermission.MANAGE_TEMPLATES` enforcement, referential post count check on deletion, and audit logging.
   - `TemplateNotFoundException` and `MediaNotFoundException` added to `src/common/exceptions/domain.exceptions.ts`.
2. Implemented `RenderingModule` (`src/modules/rendering/`):
   - `HtmlSanitizer` (`src/modules/rendering/html-sanitizer.service.ts`): whitelist for `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`; tag alias normalization (`strong`->`b`, `em`->`i`, `ins`->`u`, `strike`/`del`->`s`); protocol restriction on `<a>` (`https://`, `http://`, `tg://`); strips dangerous tags (`script`, `style`, `iframe`) and event handlers (`onclick`); LIFO stack auto-balancing for unclosed tags; escaping without double-escaping entities.
   - `HtmlSplitter` (`src/modules/rendering/html-splitter.ts`): Telegram limits splitting (1024 for captions, 4096 for text messages) at natural boundaries (`\n\n`, `\n`, `. `, space) with automatic tag closure at Part 1 and tag reopening with attributes at Part 2.
   - `TelegramRenderer` (`src/modules/rendering/telegram-renderer.service.ts`): single canonical pipeline for preview and publication (AGENTS.md §15); renders `Post + PostTemplate + PostMedia[]` into `TelegramPayload` with structured `TelegramOutgoingMessage[]`; handles pure text (<=4096 and >4096 split), single media (<=1024 caption and >1024 caption+text split), and media groups (2-10 items with lead caption).
3. Implemented `MediaModule` (`src/modules/media/`):
   - `MediaService` (`src/modules/media/media.service.ts`): zero-download principle with direct Telegram `file_id` persistence; `attachMedia` and `attachMediaBatch` with OCC version increment, `AuditAction.MEDIA_ADDED`, and zero notifications (Rule F-40); `removeMedia` with gapless 1..N `sortOrder` renormalization; `reorderMedia`, `clearMedia`, `getMediaForPost` (enrichment with `isVideoDocument` and `transportMethod`), and `validateMediaForPost`.
   - `media-detector.util.ts` (`src/modules/media/utils/media-detector.util.ts`): document-as-video detection by MIME type and extension, and media group compatibility validation (2-10 items, no GIFs, no mixing documents with photos/videos).
4. Updated `PostsService` (`src/modules/posts/posts.service.ts`):
   - Injected `MediaService` with `@Optional()` and `@Inject(forwardRef(() => MediaService))`; delegated `attachMedia` and `removeMedia` to `MediaService` when injected while retaining full backward compatibility for tests passing 4 arguments.
5. Module wiring (`src/app.module.ts`):
   - Imported `TemplatesModule`, `RenderingModule`, `MediaModule`.
6. Test Suites added:
   - `tests/unit/templates.spec.ts`: 15 tests.
   - `tests/unit/rendering.spec.ts`: 16 tests.
   - `tests/unit/media.spec.ts`: 14 tests.

### Final Test Results:
1. `npm run build`:
   ```text
   > tg-content-publisher@1.0.0 build
   > nest build
   Exited with code 0
   ```
2. `npm test`:
   ```text
   Test Suites: 12 passed, 12 total
   Tests:       218 passed, 218 total
   Snapshots:   0 total
   Time:        12.291 s
   ```
3. `npm run test:e2e`:
   ```text
   ℹ tests 34
   ℹ suites 22
   ℹ pass 34
   ℹ fail 0
   ℹ duration_ms 276.0541
   ```

---

## 2. Logic Chain

1. **Templates & Dynamic Validation**:
   - According to AGENTS.md §14 and tasks.md §9, §14, templates are stored in PostgreSQL with dynamic schemas (`schemaJson`).
   - Telegram sends user input as raw text strings. Therefore, `TemplateValidator` must coerce strings to numbers for numeric fields (`coerceFieldValue`).
   - Posts in draft status need incremental autosaves without failing on empty subsequent fields (`allowPartial: true`), while review submissions and preflight checks must enforce all required fields (`allowPartial: false`).
   - Referential integrity requires checking `prisma.post.count({ where: { templateId: id } })` before template deletion to protect foreign keys and historical posts.

2. **Canonical Rendering Pipeline**:
   - AGENTS.md §15 mandates that Preview and Publication MUST use the exact same renderer.
   - `TelegramRenderer` acts as this single pipeline, taking `(Post, PostTemplate, PostMedia[])` and returning `TelegramPayload`.
   - If rendered text exceeds Telegram's 1024 caption limit, a naive split corrupts HTML tags. `HtmlSplitter` determines the optimal natural cut point, unwinds unclosed tags in Part 1, and reopens them in Part 2, producing valid Telegram HTML in both parts.

3. **Media Handling & Zero-Download**:
   - AGENTS.md §19 mandates that Telegram `file_id` is reused directly without downloading or uploading bytes. `MediaService` stores `telegramFileId` directly.
   - Telegram Bot API rejects passing document `file_id` to `sendVideo`. `isDocumentAsVideo` detects uncompressed videos uploaded as documents, enabling the system to route them via `sendDocument` while still accepting them in template validation and preventing illegal mixing with photos in media groups.
   - Removing an item from a media album leaves gaps in `sortOrder`. `MediaService.removeMedia` renormalizes remaining items to 1..N inside the database transaction.

4. **Backward Compatibility & Regression Prevention**:
   - In `PostsService`, decorating `mediaService` with `@Optional()` guarantees that existing tests manually instantiating `PostsService` with 4 arguments continue to run cleanly without constructor signature errors.
   - All 156 baseline unit tests and all 34 E2E tests across Tiers 1-4 pass without modification.

---

## 3. Caveats

1. **Queue/Worker Integration (Milestone 4 Scope)**:
   - `TelegramRenderer` produces `TelegramPayload` with `messages: TelegramOutgoingMessage[]`. The actual BullMQ worker execution of these messages to Telegram Bot API belongs to Milestone 4.
2. **Interactive Wizard UI (Milestone 5 Scope)**:
   - The interactive Telegram grammY wizard UI that prompts for template fields and calls `templatesService.validateField` step-by-step will be implemented in Milestone 5.
3. **Database Migrations**:
   - The existing Prisma schema (`prisma/schema.prisma`) already defined `PostTemplate`, `PostMedia`, and all related models from M1. No new database migration was required.

---

## 4. Conclusion

Milestone 3 (Templates, Canonical Rendering & Media Management) is fully and genuinely implemented in accordance with AGENTS.md, tasks.md, and PROJECT.md specifications:
- `TemplatesModule` provides dynamic validation, type coercion, empathetic Russian messages, and RBAC-controlled template management.
- `RenderingModule` provides a strict HTML sanitizer, HTML-aware splitting, and the canonical `TelegramRenderer` powering preview and publication payloads.
- `MediaModule` provides zero-download `file_id` persistence, media group validation, gapless sort order maintenance, and document-as-video detection.
- All 218 unit tests (156 original + 62 new) and all 34 E2E tests pass cleanly with zero regressions.

---

## 5. Verification Method

To independently verify this implementation:

1. **Compile the TypeScript codebase**:
   ```bash
   npm run build
   ```
   *Expected result*: Process exits with code 0.

2. **Execute all unit tests**:
   ```bash
   npm test
   ```
   *Expected result*: 12 test suites, 218 tests passing (including `templates.spec.ts`, `rendering.spec.ts`, `media.spec.ts`).

3. **Execute all E2E tests**:
   ```bash
   npm run test:e2e
   ```
   *Expected result*: 22 suites, 34 tests passing across Tiers 1–4.

4. **Inspect key implementation files**:
   - `src/modules/templates/template.validator.ts`
   - `src/modules/templates/templates.service.ts`
   - `src/modules/rendering/html-sanitizer.service.ts`
   - `src/modules/rendering/html-splitter.ts`
   - `src/modules/rendering/telegram-renderer.service.ts`
   - `src/modules/media/media.service.ts`
   - `src/modules/media/utils/media-detector.util.ts`

Invalidation conditions:
- Any failure in `npm run build`.
- Any failure in `npm test` or `npm run test:e2e`.
- Divergence between preview payload and publication payload formats.
