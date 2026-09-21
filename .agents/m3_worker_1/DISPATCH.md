## 2026-09-21T08:51:01Z
Implement Milestone 3 (Templates, Canonical Rendering & Media Management) in c:/TgHelp:

1. Templates Module (src/modules/templates/):
   - Implement TemplateValidator: supports field types (text, textarea, rich_text, number, url), constraints (required, minLength, maxLength, min, max, integer, regex), string-to-number coercion for Telegram inputs, empathetic Russian validation error messages.
   - Implement TemplatesService: list active templates, getById, getByKey (slug), create, update, delete with referential post count check, RBAC permission check (SystemPermission.MANAGE_TEMPLATES), and audit logging.
   - Define TemplateNotFoundException in src/common/exceptions/domain.exceptions.ts if needed.
   - Implement TemplatesModule and export TemplatesService, TemplateValidator.

2. Rendering Module (src/modules/rendering/):
   - Implement HtmlSanitizer: allow only <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote> (and normalize aliases strong, em, ins, strike, del), whitelist <a> href protocols (https://, http://, tg://), strip unsafe tags/scripts/handlers (onclick, etc.), unclosed tag auto-balancing via LIFO stack, character escaping (<, >, & without double-escaping entities).
   - Implement HtmlSplitter: HTML-aware splitting respecting Telegram limits (caption <= 1024, text <= 4096), splitting at natural boundaries (paragraphs, lines, sentences) and auto-closing/re-opening active tags across message boundaries.
   - Implement TelegramRenderer: single canonical pipeline for both Preview and Publication (AGENTS.md §15), taking (Post, PostTemplate, PostMedia[]) and returning TelegramPayload with structured TelegramOutgoingMessage[].
   - Define TelegramPayload, TelegramOutgoingMessage types.
   - Implement RenderingModule and export TelegramRenderer, HtmlSanitizer.

3. Media Module (src/modules/media/):
   - Implement MediaService: attachMedia, attachMediaBatch, removeMedia, reorderMedia, clearMedia, getMediaForPost, validateMediaForPost.
   - Zero-download principle: persist and reuse Telegram file_id directly without downloading/uploading bytes.
   - Enforce media group rules: 2-10 items, sortOrder ASC, album type compatibility (photo+video ok, document only with document, animation rejected from groups), caption <= 1024 on lead item.
   - Document-as-video handling: detect uncompressed video documents (mime_type: 'video/mp4', etc.); route as sendDocument at transport, allow as video in template validation, forbid mixing with photos in albums.
   - Update PostsService.attachMedia / removeMedia to delegate to MediaService for backward compatibility with existing tests.
   - Implement MediaModule and export MediaService.

4. Integration & App Wiring:
   - Register TemplatesModule, RenderingModule, MediaModule in src/app.module.ts.

5. Comprehensive Unit Testing:
   - Add tests/unit/templates.spec.ts (TemplateValidator rules, coercion, constraints, TemplatesService CRUD & RBAC).
   - Add tests/unit/rendering.spec.ts (HtmlSanitizer tag whitelisting, attribute filtering, stack balancing, HtmlSplitter chunking, TelegramRenderer multi-message payloads).
   - Add tests/unit/media.spec.ts (MediaService CRUD, zero-download file_id reuse, media group limits 2-10, document-as-video detection).

6. Verification:
   - Run npm run build and verify clean compilation without errors.
   - Run npm test and ensure ALL unit tests pass (existing 156 + new M3 tests).
   - Run npm run test:e2e and ensure ALL 34 E2E tests across Tiers 1-4 continue to pass.

Write your changes to c:/TgHelp/.agents/m3_worker_1/changes.md and handoff report to c:/TgHelp/.agents/m3_worker_1/handoff.md.
When complete, notify parent orchestrator via send_message with test results and handoff path.
