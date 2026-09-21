# Milestone 3 Changes Summary

## Overview
Implemented Milestone 3: Templates, Canonical Rendering & Media Management in `c:/TgHelp` according to AGENTS.md (§14-19), tasks.md (§9, §14-18), and explorer reports 1, 2, and 3.

---

## 1. Templates Module (`src/modules/templates/`)

### Created Files:
- `src/modules/templates/interfaces/template.interface.ts`:
  - Defined `TemplateFieldType` (`text`, `textarea`, `rich_text`, `number`, `url`).
  - Defined `TemplateFieldDefinition` with constraints (`required`, `minLength`, `maxLength`, `min`, `max`, `integer`, `regex`, `regexMessage`, `hint`, `defaultValue`).
  - Defined `TemplateSchema`, `TemplateRenderConfig`, `FieldValidationError`, `ValidationResult`.
- `src/modules/templates/dto/create-template.dto.ts`:
  - DTO for admin template creation with typed `schemaJson` and `renderConfig`.
- `src/modules/templates/dto/update-template.dto.ts`:
  - DTO for updating existing template fields.
- `src/modules/templates/dto/index.ts`:
  - Re-exports create and update DTOs.
- `src/modules/templates/template.validator.ts`:
  - Dynamic validation engine supporting all mandated field types and constraints.
  - String-to-number input coercion (`coerceFieldValue`) handling commas and decimal points for Telegram user input.
  - Empathetic Russian validation error messages catalog (`REQUIRED`, `MIN_LENGTH`, `MAX_LENGTH`, `INVALID_NUMBER`, `NOT_INTEGER`, `MIN_VALUE`, `MAX_VALUE`, `INVALID_URL`, `PATTERN_MISMATCH`).
  - Dual evaluation modes: single-field validation (`validateField`) and full content validation (`validateContent`) with `allowPartial: true` (for wizard autosaves) and `allowPartial: false` (for review submission).
  - Schema definition validation (`validateTemplateSchema`) checking field keys, duplicates, allowed types, numeric consistency, regex validity, and layout existence.
- `src/modules/templates/templates.service.ts`:
  - `getActiveTemplates()`: Returns active templates ordered by `createdAt asc`.
  - `findAll(includeInactive)`: Returns all templates for administration.
  - `getById(id)` & `getByKey(key)` & `findByIdOrKey(idOrKey)`: Looks up templates with `TemplateNotFoundException`.
  - `validateField(...)` & `validatePostContent(...)`: Service helpers for post content validation.
  - `createTemplate(dto, actorId)`: Enforces `SystemPermission.MANAGE_TEMPLATES`, validates schema, checks duplicate key, persists to `prisma.postTemplate`, records `AuditAction.SETTINGS_CHANGED`.
  - `updateTemplate(id, dto, actorId)`: Enforces permission, validates schema if updated, bumps template `version`, records audit log.
  - `setActive(id, isActive, actorId)`: Toggles active status.
  - `deleteTemplate(id, actorId)`: Checks referential integrity (`post.count({ where: { templateId: id } })`); throws `ValidationException` if in use; deletes and records audit log if unused.
- `src/modules/templates/templates.module.ts`:
  - Module importing `PrismaModule`, `AuditModule`, `AuthModule`; exports `TemplateValidator`, `TemplatesService`.
- `src/modules/templates/index.ts`:
  - Module barrel export.

---

## 2. Rendering Module (`src/modules/rendering/`)

### Created Files:
- `src/modules/rendering/interfaces/telegram-payload.interface.ts`:
  - Defined `OutgoingMessageType` (`text`, `photo`, `video`, `document`, `animation`, `media_group`).
  - Defined `MediaGroupItem` and structured `TelegramOutgoingMessage` with `partIndex`.
  - Defined canonical `TelegramPayload` (`{ messages: TelegramOutgoingMessage[] }`).
- `src/modules/rendering/html-sanitizer.service.ts`:
  - Telegram Bot API HTML parse mode sanitizer.
  - Allowed tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`.
  - Normalizes aliases: `<strong>` -> `b`, `<em>` -> `i`, `<ins>` -> `u`, `<strike>`/`<del>` -> `s`.
  - Restricts `<a>` attributes to `href` matching `https://`, `http://`, or `tg://`.
  - Strips dangerous tags and content (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`).
  - Strips all inline event handlers (`onclick`, `onerror`, etc.).
  - Strips unsupported layout tags (`<div>`, `<p>`, `<span>`, `<h1>`) while preserving inner text.
  - Auto-balances unclosed and misnested tags via LIFO stack unwind.
  - Escapes raw `<`, `>`, `&` without double-escaping valid entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`).
  - Converts `<br>`/`<br/>` to newline `\n`.
  - Helper `escapeText(str)` for plain-text placeholder interpolation.
- `src/modules/rendering/html-splitter.ts`:
  - Splits HTML respecting Telegram limits (`MAX_CAPTION_LENGTH = 1024`, `MAX_MESSAGE_LENGTH = 4096`).
  - Splits at natural boundaries: paragraphs (`\n\n`), lines (`\n`), sentence ends (`. `, `! `, `? `), word spaces.
  - Auto-closes active open tags at the end of Part 1 and re-opens them at the start of Part 2, preserving attributes (`<a href="...">`).
  - `splitIntoChunks(html, maxLength)` recursively chunks long messages.
- `src/modules/rendering/telegram-renderer.service.ts`:
  - Single canonical pipeline for both Preview and Publication (AGENTS.md §15).
  - Method `render(post, template, media)` -> `Promise<TelegramPayload>`.
  - Method `renderHtml(post, template)`: interpolates fields, tags (`#tag`), CTA into layout, cleans empty tags (`<i></i>`) and collapses blank lines.
  - Multi-message partitioning:
    - Text only: 1 message (or split chunks if > 4096).
    - Single media: 1 message if text <= 1024; split into Message 1 (media + caption <= 1024) and Message 2 (text <= 4096) if text > 1024.
    - Media group (2-10 items): 1 message with lead caption if text <= 1024; split into Message 1 (`media_group` with lead caption <= 1024) and Message 2 (text <= 4096) if text > 1024.
- `src/modules/rendering/rendering.module.ts`:
  - Exports `HtmlSanitizer`, `TelegramRenderer`.
- `src/modules/rendering/index.ts`:
  - Barrel export.

---

## 3. Media Module (`src/modules/media/`)

### Created Files:
- `src/modules/media/utils/media-detector.util.ts`:
  - `isDocumentAsVideo(media)`: Detects uncompressed videos uploaded as documents by MIME type (`video/mp4`, `video/quicktime`, etc.) and file extension (`.mp4`, `.mov`, etc.).
  - `validateMediaGroupCompatibility(items)`: Enforces Telegram album rules (2-10 items, no GIFs, no mixing photos with documents, photos+videos allowed).
- `src/modules/media/dto/attach-media.dto.ts`, `attach-media-batch.dto.ts`, `reorder-media.dto.ts`, `index.ts`:
  - DTOs for media operations.
- `src/modules/media/interfaces/enriched-post-media.interface.ts`:
  - Extended model with `isVideoDocument`, `isImageDocument`, and `transportMethod` (`sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`).
- `src/modules/media/interfaces/media-validation-result.interface.ts`, `index.ts`:
  - Validation result interface.
- `src/modules/media/media.service.ts`:
  - Zero-download principle: persists and reuses Telegram `file_id` directly without disk/network downloading.
  - `attachMedia`: Validates post editable state (`DRAFT` / `NEEDS_REVISION`), checks max limit (10 items), increments post version via OCC, records `AuditAction.MEDIA_ADDED`, emits zero notifications (Rule F-40).
  - `attachMediaBatch`: Attaches multiple media items in a single transaction with one OCC version bump and sequential `sortOrder`.
  - `removeMedia`: Deletes media, renormalizes remaining media `sortOrder` to gapless 1..N, increments post OCC version, records audit log.
  - `reorderMedia`: Reorders media and increments post OCC version.
  - `clearMedia`: Removes all attachments and increments post OCC version.
  - `getMediaForPost`: Returns items enriched with document-as-video and transport method.
  - `validateMediaForPost`: Validates media against template rules and media group compatibility.
- `src/modules/media/media.module.ts`:
  - Imports `PrismaModule`, `AuditModule`, `AuthModule`, `forwardRef(() => PostsModule)`.
  - Exports `MediaService`.
- `src/modules/media/index.ts`:
  - Barrel export.

---

## 4. Existing Codebase Updates & Backward Compatibility

- `src/common/enums/index.ts`:
  - Added `AuditAction.TEMPLATE_CHANGED = 'template_changed'`.
- `src/common/exceptions/domain.exceptions.ts`:
  - Added `TemplateNotFoundException` (404) and `MediaNotFoundException` (404).
- `src/modules/posts/posts.service.ts`:
  - Updated `attachMedia` and `removeMedia` to delegate to `MediaService`.
  - Made `mediaService?: MediaService` `@Optional()` with full internal fallback if not provided, ensuring 100% backward compatibility for existing unit tests instantiating `new PostsService(prisma, repo, audit, perm)`.
- `src/modules/posts/posts.module.ts`:
  - Imported `forwardRef(() => MediaModule)`.
- `src/app.module.ts`:
  - Registered `TemplatesModule`, `RenderingModule`, `MediaModule`.

---

## 5. Tests

### Added Unit Test Suites:
- `tests/unit/templates.spec.ts`: 15 unit tests covering `TemplateValidator` coercion, constraints, Russian error messages, schema validation, and `TemplatesService` CRUD, RBAC, and referential post deletion checks.
- `tests/unit/rendering.spec.ts`: 16 unit tests covering `HtmlSanitizer` tag whitelisting, protocol filtering, stack balancing, escaping, `HtmlSplitter` boundary and tag preservation across chunks, and `TelegramRenderer` single and multi-message generation.
- `tests/unit/media.spec.ts`: 14 unit tests covering `MediaService` zero-download file_id reuse, batch upload, gapless sortOrder renumbering, media group compatibility (2-10, type mixing, animations), and document-as-video detection and enrichment.

### Test Results:
- `npm run build`: Exit code 0 (clean compilation).
- `npm test`: 12/12 test suites passed, 218/218 tests passed (156 baseline + 62 new M3 tests).
- `npm run test:e2e`: 22/22 suites passed, 34/34 tests passed across Tiers 1-4.
