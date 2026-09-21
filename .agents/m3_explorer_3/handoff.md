# Handoff Report: MediaService & Media Handling (Milestone 3)

**Agent ID**: `m3_explorer_3`  
**Role**: Teamwork Explorer (Media Architecture)  
**Parent Orchestrator**: `6f35b072-3fac-43df-87fc-95e48993acc2` (parent)  
**Handoff Type**: Hard (Task Complete)  
**Date**: 2026-09-21  

---

## 1. Observation

1. **Database Schema**:
   - File: `c:/TgHelp/prisma/schema.prisma`, lines 176–194:
     ```prisma
     model PostMedia {
       id                   String    @id @default(uuid())
       postId               String    @map("post_id")
       telegramFileId       String    @map("telegram_file_id")
       telegramFileUniqueId String    @map("telegram_file_unique_id")
       mediaType            MediaType @map("media_type")
       fileName             String?   @map("file_name")
       mimeType             String?   @map("mime_type")
       fileSize             BigInt?   @map("file_size")
       caption              String?   @map("caption")
       sortOrder            Int       @default(0) @map("sort_order")
       createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz

       post Post @relation(fields: [postId], references: [id], onDelete: Cascade)
       @@index([postId])
       @@index([telegramFileUniqueId])
       @@map("post_media")
     }
     ```
   - Enum `MediaType` (`schema.prisma`, lines 38–43): `PHOTO`, `VIDEO`, `DOCUMENT`, `ANIMATION`.
2. **Current Post Repository & Ordering**:
   - File: `c:/TgHelp/src/modules/posts/posts.repository.ts`, lines 24–25:
     ```ts
     include: {
       media: { orderBy: { sortOrder: 'asc' } },
     ```
3. **Current Post Service Media Logic**:
   - File: `c:/TgHelp/src/modules/posts/posts.service.ts`, lines 129–184 (`attachMedia`) and lines 189–228 (`removeMedia`). Media logic is currently embedded in `PostsService` rather than a dedicated `src/modules/media/` module.
4. **Telegram Constraints**:
   - File: `c:/TgHelp/src/common/constants/telegram-limits.ts`, lines 13–16:
     ```ts
     /** Minimum number of items allowed in a media group */
     MIN_MEDIA_GROUP_SIZE: 2,

     /** Maximum number of items allowed in a media group */
     MAX_MEDIA_GROUP_SIZE: 10,
     ```
5. **Telegram Bot API Behavior**:
   - Telegram Bot API rejects passing a document's `file_id` to `sendVideo` with `400 Bad Request: wrong remote file identifier` because Telegram's cloud storage marks the file type at upload time.
   - Telegram Bot API `sendMediaGroup` accepts mixing `photo` and `video` together, or `document` with `document` only. It rejects mixing `photo`/`video` with `document`, and does not support `animation` (GIF) in albums.
6. **Existing Test Coverage**:
   - File: `c:/TgHelp/tests/e2e/tier1-feature-coverage.spec.ts`, lines 159–176: tests `attachMedia` asserting version increment from 3 to 4, `sortOrder === 1`, and zero notifications emitted (Rule F-40).

---

## 2. Logic Chain

1. **Media Layer Decoupling**:
   - From Observation 3, `PostsService` holds rudimentary attachment methods. AGENTS.md § 4 specifies modular boundaries and avoiding "god services".
   - Therefore, a dedicated `MediaService` in `src/modules/media/` must own all media lifecycle methods (`attachMedia`, `attachMediaBatch`, `removeMedia`, `reorderMedia`, `clearMedia`, `getMediaForPost`, `validateMediaForPost`).
   - To avoid breaking existing tests (Observation 6), `PostsService.attachMedia` should delegate directly to `MediaService.attachMedia`.
2. **Zero-Download `file_id` Reusability**:
   - From Observation 1 & 5, Telegram assigns a persistent `file_id` for each uploaded file.
   - Because the bot can pass this string directly to `bot.api.sendPhoto/sendVideo/sendDocument/sendMediaGroup`, downloading binary streams over HTTP to disk is unnecessary, wasteful, and subject to Telegram's 50MB direct bot upload limit.
   - Reusing `file_id` allows instant publishing and handles user uploads up to 2GB.
3. **Media Group Rule Enforcement**:
   - From Observation 4 & 5, media groups require 2 to 10 items. Single items cannot use `sendMediaGroup`. Over 10 items fail.
   - Ordering is governed by `sort_order ASC` (Observation 2). Item with `sortOrder: 1` serves as the lead media and anchors the caption ($\le 1024$ chars).
   - Validation must ensure type compatibility: photos and videos may mix; documents may group only with documents; animations must be rejected from groups.
4. **Document-as-Video Safety**:
   - From Observation 5, users sending uncompressed video send it as a `document` (`mime_type: 'video/mp4'`, etc.).
   - If stored as `DOCUMENT` and naively sent via `sendVideo`, Telegram API throws `400 Bad Request: wrong remote file identifier`.
   - Therefore, detection logic (`isDocumentAsVideo`) checks MIME types (`video/mp4`, `video/quicktime`, etc.) and extensions (`.mp4`, `.mov`, etc.).
   - For transport, the Publisher sends it using `sendDocument`.
   - For domain validation, the Template Validator accepts it as a video.
   - In albums, the Media Validator forbids mixing it with compressed photos/videos, preventing runtime publishing crashes.

---

## 3. Caveats

1. **Bot Token Scoping**: A Telegram `file_id` is valid only for the bot token that received the file. If `BOT_TOKEN` changes in `.env`, previously cached `file_id`s cannot be sent by the new bot token.
2. **Channel Admin Permissions**: Reusing `file_id` to post into a channel requires the bot to be an administrator in that channel with `can_post_messages` permission.
3. **Animation in Telegram Albums**: Telegram's Bot API currently lacks an `InputMediaAnimation` type for `sendMediaGroup`. Therefore, GIFs must remain separate single messages and cannot be attached to a media group.

---

## 4. Conclusion

The media architecture for Milestone 3 is completely specified in `report.md`:
1. `MediaService` (`src/modules/media/media.service.ts`) provides full CRUD, batching, reordering, and validation for post media.
2. Reuses Telegram `file_id` directly without any file downloads or uploads.
3. Enforces media group constraints: 2–10 items, sequential `sort_order`, album type compatibility, and caption limits.
4. Robustly handles document-as-video: detects uncompressed videos, routes them through `sendDocument` at transport, accepts them as videos during template validation, and forbids mixing them with photos in albums.
5. Fully backward-compatible with M2 tests via delegation from `PostsService`.

---

## 5. Verification Method

1. **Unit & E2E Test Execution**:
   Run the existing test suite to ensure all M1/M2 tests pass:
   ```bash
   npm test
   ```
2. **Verify File Locations & Specifications**:
   - Inspect report: `c:/TgHelp/.agents/m3_explorer_3/report.md`
   - Inspect handoff: `c:/TgHelp/.agents/m3_explorer_3/handoff.md`
3. **Implementation Invalidation Conditions**:
   - If `MediaService` attempts to download files to local disk via `bot.api.getFile`, the zero-download principle is violated.
   - If `PublishingWorker` calls `sendVideo` with a `file_id` originating from a Telegram document, Telegram will return `400 Bad Request: wrong remote file identifier`.
   - If `sendMediaGroup` is called with 1 item or >10 items, Telegram will return an immediate `400 Bad Request`.
