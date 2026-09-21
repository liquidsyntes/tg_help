# Handoff Report — Milestone 3: TelegramRenderer, HtmlSanitizer & Multi-Message Splitting

**Agent**: `m3_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m3_explorer_2`  
**Report Reference**: `c:/TgHelp/.agents/m3_explorer_2/report.md`  

---

## 1. Observation

1. **Telegram Limits Constraints (`c:/TgHelp/src/common/constants/telegram-limits.ts:1-29`)**:
   - `MAX_MESSAGE_LENGTH: 4096`
   - `MAX_CAPTION_LENGTH: 1024`
   - `MIN_MEDIA_GROUP_SIZE: 2`
   - `MAX_MEDIA_GROUP_SIZE: 10`
   - `MAX_CALLBACK_DATA_BYTES: 64`
2. **Architectural Directives (`c:/TgHelp/AGENTS.md`)**:
   - **§15 Canonical Rendering**: "There must be one canonical rendering pipeline. Preview and publication must use the same renderer. Do not implement separate formatting logic for preview and publication."
   - **§16 Telegram Payload**: "A publication is not necessarily one Telegram message. Represent the rendered result as a structured payload. `interface TelegramPayload { messages: TelegramOutgoingMessage[]; }`. Possible message types: `text, photo, video, document, animation, media_group`."
   - **§17 Telegram HTML**: "Use Telegram HTML parse mode. Sanitize and validate HTML before publication. Supported: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`. Escape special characters correctly."
   - **§23 Partial Publication**: "If the first succeeds and the second fails, do not blindly restart everything. Store Telegram message IDs after each successful step. Retries should resume safely where technically possible. Never duplicate already-published messages just because the final step failed."
3. **Product Specification (`c:/TgHelp/tasks.md:532-622`)**:
   - §15: Unified rendering pipeline: `Post + Template + Media -> TelegramRenderer -> TelegramPayload`.
   - §16: Structured payload supports multi-message delivery (e.g. media group + separate long text message).
   - §17: Allowed HTML tags strictly enumerated: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`. Pipeline flow: `sanitize -> validate -> render -> preview -> publish`.
4. **Current Database & Models (`c:/TgHelp/prisma/schema.prisma:124-256`)**:
   - `PostTemplate` model defines `schemaJson`, `renderConfig`, and `supportedMediaTypes`.
   - `Post` model stores `contentJson: Json`, `metadataJson: Json`, `version: Int`.
   - `PostMedia` model stores `telegramFileId`, `telegramFileUniqueId`, `mediaType`, `caption`, `sortOrder`.
   - `PublicationJob` model stores `idempotencyKey: String @unique`, `telegramMessageIds: Json @default("[]")`.
5. **Existing Seed Templates (`c:/TgHelp/prisma/seed.ts:74-275`)**:
   - 6 templates seeded: `longread`, `announcement`, `photo`, `video`, `news`, `freeform`.
   - `renderConfig.layout` defines mustache placeholders (e.g., `'<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}'`).
   - Fields range from short text (title $\le 256$) to rich text (`body` up to 8000 in longread), which exceeds Telegram single message limits (4096) and caption limits (1024).
6. **Current Test Suite Results**:
   - `npm test`: 9 test suites passed, 156 unit tests passed (`tests/unit/`).
   - `npm run test:e2e`: 4 suites passed, 34 E2E tests passed (`tests/e2e/tier1-4`).
   - `tests/e2e/tier2-boundary-cases.spec.ts:158-183` already validates basic HTML sanitization expectations (stripping script/handlers, preserving allowed tags, preserving inner text of unsupported tags).
   - `tests/e2e/tier3-cross-feature.spec.ts:186-260` explicitly tests partial publication resume where `sendMediaGroup` succeeds and `sendMessage` retries.

---

## 2. Logic Chain

1. **Sanitization Necessity (Obs 2, 3, 6)**:
   Because Telegram Bot API's HTML parser strictly rejects illegal tags, unclosed tags, or unescaped `<`, `>`, `&` with `400 Bad Request: can't parse entities`, raw user inputs must be processed through `HtmlSanitizer`.
   The sanitizer must:
   - Whitelist only `b, i, u, s, code, pre, a, blockquote` (and normalize aliases `strong, em, ins, strike, del`).
   - Strip malicious content (`<script>`, `<iframe>`, inline event handlers like `onclick`).
   - Strip layout tags (`<div>`, `<p>`, `<table>`) while preserving inner text.
   - Restrict attributes on `<a>` to verified protocols (`https://`, `http://`, `tg://`).
   - Use a LIFO stack to automatically close unclosed tags at the end, ensuring 100% parseable Telegram HTML.

2. **Single Canonical Renderer Guarantee (Obs 2, 3)**:
   Per AGENTS.md §15, separating preview formatting from publication formatting invites divergence.
   By placing `TelegramRenderer` in `src/modules/rendering/` and accepting domain entities `(Post, PostTemplate, PostMedia[])`, both the Bot Preview Handler (Milestone 5) and the BullMQ Publication Worker (Milestone 4) invoke the identical `TelegramRenderer.render()` method.

3. **Multi-Message Splitting Strategy (Obs 1, 2, 5)**:
   - When a post has attached media (`PostMedia.length >= 1`), Telegram caps the caption at 1024 characters.
   - Long-form templates like `longread` permit `body` up to 8000 characters.
   - Therefore, when total text exceeds 1024 characters with media:
     - Message 1 is emitted as media (single media or media group) with a short caption (e.g. formatted `title` or first section $\le 1024$).
     - Message 2 is emitted as a text message containing the remaining text ($\le 4096$).
     - If the remaining text exceeds 4096 characters, it is recursively split into chunks $\le 4096$.
   - Splitting HTML requires an HTML-aware split algorithm (`HtmlSplitter`) that finds natural break boundaries (paragraphs, lines, sentences) without slicing tags or entities, closes open tags in Part 1, and re-opens them in Part 2.

4. **Worker Idempotency & Partial Publication (Obs 2, 4, 6)**:
   - Multi-message publication requires sequential Telegram API calls (`sendMediaGroup` then `sendMessage`).
   - By structuring `TelegramPayload.messages` with zero-indexed `partIndex` and persisting sent IDs in `publication_jobs.telegram_message_ids`, any worker retry after a network timeout safely skips previously delivered parts, satisfying AGENTS.md §23.

---

## 3. Caveats

1. **Document-as-Video Classification**:
   Handling video files uploaded as raw uncompressed documents (`media_type: DOCUMENT` with `video/mp4` MIME type) is designed in conjunction with `m3_explorer_3` (Media Explorer). The renderer assumes `PostMedia` has `mediaType` properly identified or classified before rendering.
2. **Interactive Inline Keyboards in Preview vs Channel**:
   `TelegramPayload` specifies message content, media, and text. In Preview, the bot transport layer attaches editorial callback buttons (`[Одобрить]`, `[На доработку]`) to the final message. In Channel publication, no bot management buttons are attached. This separation is handled at the transport layer, not inside `TelegramRenderer`.
3. **External Dependencies**:
   The proposed `HtmlSanitizer` and `HtmlSplitter` are designed in native TypeScript without external npm dependencies, avoiding supply-chain bloat and maintaining compatibility with strict NestJS/TypeScript settings.

---

## 4. Conclusion

1. The architectural blueprint for Milestone 3 rendering (`HtmlSanitizer`, `TelegramRenderer`, `HtmlSplitter`, and `TelegramPayload`) is complete, fully specified in `c:/TgHelp/.agents/m3_explorer_2/report.md`.
2. The implementation should be placed in `src/modules/rendering/`:
   - `html-sanitizer.ts`
   - `html-splitter.ts`
   - `types/telegram-payload.types.ts`
   - `telegram-renderer.service.ts`
   - `rendering.module.ts`
3. The design satisfies all constraints of AGENTS.md §15-18, §23 and seamlessly supports both the Milestone 4 Worker and Milestone 5 Wizard/Preview UI.

---

## 5. Verification Method

To independently verify this design and its compatibility:
1. **Inspect Report**:
   Read `c:/TgHelp/.agents/m3_explorer_2/report.md` for complete code blueprints and interface specifications.
2. **Run Existing Test Suites**:
   - `npm test` (verifies 156 unit tests remain green).
   - `npm run test:e2e` (verifies 34 E2E tests across Tiers 1-4 remain green).
3. **Invalidation Conditions**:
   - If Telegram HTML parse mode rejects valid tags or errors on unclosed tags generated by `HtmlSanitizer`.
   - If caption length in `TelegramPayload` for media messages exceeds 1024 characters.
   - If text length in `TelegramPayload` for text messages exceeds 4096 characters.
   - If Preview and Publication rely on different formatting code.
