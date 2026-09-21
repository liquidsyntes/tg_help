# MediaService & Media Handling Architecture Report (Milestone 3)

**Author**: `m3_explorer_3` (Teamwork Explorer)  
**Target Milestone**: Milestone 3 (Templates, Canonical Rendering & Media)  
**Date**: 2026-09-21  
**Status**: Completed Investigation & Architecture Specification  

---

## 1. Executive Summary

In Milestone 3, media handling transitions from basic post attachment placeholders into a production-grade editorial media engine. This report defines the architectural design of **`MediaService`**, Telegram **`file_id` reuse** without network downloads or re-uploads, strict **Media Group album rules** (2–10 items, sequential `sort_order`, type compatibility), and a robust solution for **Document-as-Video** handling (detecting uncompressed video files sent as Telegram documents and preventing Bot API crashes).

### Core Architectural Guarantees:
1. **Zero Download / Re-upload**: The bot persists and reuses Telegram `file_id` directly for previews and channel publishing, saving bandwidth, storage, and bypassing the 50MB direct bot upload ceiling.
2. **Strict Media Group Boundaries**: Enforces Telegram Bot API album constraints (2 to 10 items, `sort_order` ordering, photo/video mixing permitted, document/animation grouping rules).
3. **Crash-Proof Document-as-Video Pipeline**: Detects uncompressed video files uploaded as documents (`video/mp4`, `video/quicktime`, etc.), prevents passing document `file_id`s to `sendVideo` (which causes `400 Bad Request: wrong remote file identifier`), and prevents mixing document videos with photos in albums.
4. **OCC & Audit Compliance**: Every media modification (attach, batch attach, remove, reorder) atomically increments post `version` under Optimistic Concurrency Control and creates append-only `AuditLog` records with zero notifications.

---

## 2. Existing System Analysis & Current State

### 2.1 Database Schema (`prisma/schema.prisma`)
The PostgreSQL schema defines `PostMedia` with all required fields (per AGENTS.md § 19, tasks.md § 18):
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

enum MediaType {
  PHOTO
  VIDEO
  DOCUMENT
  ANIMATION
}
```

### 2.2 Current Codebase State
- In M1/M2, `PostsService` contained basic `attachMedia` and `removeMedia` helper methods directly inside `src/modules/posts/posts.service.ts`.
- `PostsRepository.findById` already includes `media: { orderBy: { sortOrder: 'asc' } }`.
- `src/common/constants/telegram-limits.ts` already defines:
  ```ts
  MIN_MEDIA_GROUP_SIZE: 2,
  MAX_MEDIA_GROUP_SIZE: 10,
  MAX_CAPTION_LENGTH: 1024,
  MAX_MESSAGE_LENGTH: 4096,
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  ```
- Dedicated `MediaService` (`src/modules/media/`) is not yet created.

---

## 3. MediaService Architectural Design

`MediaService` will be encapsulated in `src/modules/media/` following NestJS modular patterns and AGENTS.md § 3–5.

### 3.1 Module Structure
```text
src/modules/media/
├── dto/
│   ├── attach-media.dto.ts
│   ├── attach-media-batch.dto.ts
│   └── reorder-media.dto.ts
├── interfaces/
│   ├── media-validation-result.interface.ts
│   └── enriched-post-media.interface.ts
├── utils/
│   └── media-detector.util.ts
├── media.service.ts
├── media.module.ts
└── index.ts
```

### 3.2 Core Responsibilities & Methods

#### 1. `attachMedia(command: AttachMediaCommand): Promise<PostMedia>`
- **Validation**:
  - Verifies post exists and is active (`deletedAt === null`).
  - Verifies post status is editable (`DRAFT` or `NEEDS_REVISION`).
  - Verifies actor permissions (`enforcePostEditPermission`).
  - Checks if post already has maximum media items (`MAX_MEDIA_GROUP_SIZE = 10`).
- **Sort Order Calculation**:
  - If `sortOrder` is not explicitly provided, computes `nextSortOrder = (highestExistingSortOrder || 0) + 1`.
- **OCC & Transaction**:
  - Executes inside `prisma.$transaction`.
  - Creates `postMedia` row.
  - Updates post with OCC (`postsRepository.updateWithOcc`, version incremented).
  - Emits audit log (`AuditAction.MEDIA_ADDED`, entity: `post`, actor: `actorId`).
  - Emits **zero notifications** (Rule F-40).

#### 2. `attachMediaBatch(command: AttachMediaBatchCommand): Promise<PostMedia[]>`
- Supports incoming Telegram media groups (when a user uploads multiple photos/videos simultaneously, Telegram sends multiple updates grouped by `media_group_id`).
- Validates that `existingMediaCount + incomingItems.length <= 10`.
- Sequential `sortOrder` assigned: `[currentMax + 1, currentMax + 2, ...]`.
- Executes batch creation in a single transaction with a single OCC post version increment.

#### 3. `removeMedia(command: RemoveMediaCommand): Promise<void>`
- Validates post state and actor permissions.
- Verifies target media item exists and belongs to `postId`.
- Executes inside transaction:
  - Deletes `postMedia` record.
  - Re-indexes / compacts remaining `sortOrder` values (1, 2, 3...) so no gaps remain.
  - Increments post OCC version.
  - Records `AuditAction.MEDIA_REMOVED` with `{ mediaId, removedSortOrder }`.

#### 4. `reorderMedia(command: ReorderMediaCommand): Promise<PostMedia[]>`
- Enables editorial rearrangement (e.g. changing which image is cover/first in the album).
- Validates that all supplied `mediaId`s belong to the post and map to valid 1-based sequential indices without duplicates.
- Executes bulk updates to `sortOrder` inside a transaction, bumps post OCC version, and logs audit record.

#### 5. `clearMedia(command: ClearMediaCommand): Promise<void>`
- Removes all media attachments for a post (e.g., when resetting media or switching template).
- Transactional deletion, OCC version bump, and audit logging.

#### 6. `getMediaForPost(postId: string): Promise<EnrichedPostMedia[]>`
- Returns all media items for a post ordered by `sortOrder ASC`.
- Automatically computes enriched properties: `isVideoDocument`, `isAlbumCompatible`, `transportType`.

#### 7. `validateMediaForPost(postId: string, template: PostTemplate): Promise<MediaValidationResult>`
- Evaluates attached media against template requirements (`supportedMediaTypes`):
  - If template requires media (e.g. `photo`, `video`), verifies at least 1 matching media item is present.
  - If multiple media items are present, verifies album constraints (2–10 items, type compatibility).
  - Validates caption length $\le 1024$.

---

## 4. Telegram `file_id` Reuse (Zero Download / Upload)

### 4.1 How Telegram `file_id` Works
When a user uploads a file to the bot:
1. Telegram stores the file in its cloud datacenter.
2. Telegram generates a bot-specific `file_id` (Base64 string containing datacenter ID, access hash, file type, file volume/local ID) and a globally unique `file_unique_id`.
3. The bot stores both IDs in PostgreSQL `post_media`.

### 4.2 Benefits
- **Zero Disk/Network Overhead**: The server never downloads binary streams to disk or memory.
- **Instantaneous Publishing**: Re-sending via `file_id` is an internal metadata reference in Telegram's datacenter, completing in tens of milliseconds.
- **Bypassing Bot API Size Ceilings**: Telegram Bot API HTTP uploads are capped at 50MB. Files uploaded by users can be up to 2GB (or 4GB with Telegram Premium). By reusing `file_id`, the bot can publish these large user files to the channel without hitting the 50MB API limit.

### 4.3 Invariant Rules for `file_id` Reuse
1. **Bot Token Scoping**: `file_id` is tied to the bot token that received it. The same bot token must be used by the background Worker to publish to the target channel.
2. **Channel Bot Admin Permissions**: The bot must be an administrator in the target channel with `can_post_messages` permission.
3. **Type Consistency**: Telegram servers remember the internal file type for each `file_id`. You **cannot** pass a document `file_id` to `sendVideo` (see §6).

---

## 5. Media Group Rules & Validation

### 5.1 Telegram Bot API Constraints
Authoritative reference: AGENTS.md § 16, § 18, tasks.md § 16, § 18, Telegram Bot API `sendMediaGroup`.

| Constraint | Limit | Description / Behavior |
|---|---|---|
| **Min Album Size** | 2 items | Telegram rejects `sendMediaGroup` with 1 item. A single item must be sent via `sendPhoto`, `sendVideo`, or `sendDocument`. |
| **Max Album Size** | 10 items | Telegram rejects `sendMediaGroup` with $\ge 11$ items. |
| **Allowed Mix 1** | Photo + Video | Photos (`InputMediaPhoto`) and Videos (`InputMediaVideo`) can be freely mixed together in a single album. |
| **Allowed Mix 2** | Documents only | Documents (`InputMediaDocument`) can only be grouped with other documents. |
| **Prohibited Mix** | Photo/Video + Document | Telegram API strictly rejects mixing documents with photos/videos in the same `sendMediaGroup`. |
| **Animations (GIFs)** | Prohibited in albums | Telegram does not support `InputMediaAnimation` in `sendMediaGroup`. GIFs must be sent via `sendAnimation`. |
| **Album Caption** | 1 caption only | In a media group, only ONE item (by convention, the first item `sortOrder: 1`) can have a caption. Max 1024 characters. |

### 5.2 Ordering via `sort_order`
- Media items are always queried and assembled using `ORDER BY sort_order ASC`.
- Visual layout in Telegram:
  - In a 2-item group: items appear side-by-side.
  - In a 3-item group: 1 large item on top/left, 2 smaller on bottom/right.
  - The item with `sortOrder: 1` is the lead media item (top-left visual anchor) and receives the formatted HTML caption (up to 1024 characters).
- When any media item is deleted or reordered, `sort_order` is renormalized to a gapless 1..N sequence.

### 5.3 Media Group Compatibility Validation Function
```ts
export function validateMediaGroupCompatibility(items: PostMedia[]): {
  isValid: boolean;
  isAlbum: boolean;
  error?: string;
} {
  if (items.length === 0) {
    return { isValid: true, isAlbum: false };
  }
  if (items.length === 1) {
    return { isValid: true, isAlbum: false };
  }
  if (items.length > 10) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'Медиагруппа не может содержать более 10 элементов (лимит Telegram).',
    };
  }

  const hasAnimation = items.some((i) => i.mediaType === MediaType.ANIMATION);
  if (hasAnimation) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'GIF-анимации нельзя объединять в медиагруппу. Анимация отправляется отдельным сообщением.',
    };
  }

  const hasPhotoOrVideo = items.some(
    (i) => i.mediaType === MediaType.PHOTO || i.mediaType === MediaType.VIDEO,
  );
  const hasDocument = items.some((i) => i.mediaType === MediaType.DOCUMENT);

  if (hasPhotoOrVideo && hasDocument) {
    return {
      isValid: false,
      isAlbum: true,
      error: 'Нельзя объединять фото/видео и документы (файлы) в одну медиагруппу Telegram.',
    };
  }

  return { isValid: true, isAlbum: true };
}
```

---

## 6. Document-as-Video Handling

### 6.1 The Problem
When Telegram users on Desktop or Mobile send a video as an uncompressed file (to avoid Telegram's aggressive compression and preserve 4K/60fps quality), Telegram sends a `message.document` update instead of `message.video`.
- `message.video` is `undefined`.
- `message.document` is populated with `mime_type: 'video/mp4'`, `file_name: 'clip.mp4'`, and `file_id: 'BQAC...'`.
- **The Pitfall**: If the publishing engine sees that the template expects a video and attempts to call:
  ```ts
  bot.api.sendVideo(chatId, documentFileId)
  ```
  Telegram Bot API returns an immediate error:
  ```text
  400 Bad Request: wrong remote file identifier specified: can't use "document" file type as video
  ```
  Telegram's backend remembers that this `file_id` was registered in the document table and rejects passing it as a video!

### 6.2 Detection Specification
A dedicated detector utility in `src/modules/media/utils/media-detector.util.ts`:
```ts
export const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',       // .mov
  'video/x-matroska',      // .mkv
  'video/webm',
  'video/avi',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'video/3gpp2',
]);

export const VIDEO_FILE_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'mpg',
  'mpeg',
]);

export function isDocumentAsVideo(media: {
  mediaType: MediaType;
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  if (media.mediaType !== MediaType.DOCUMENT) {
    return false;
  }
  if (media.mimeType) {
    const mime = media.mimeType.toLowerCase();
    if (VIDEO_MIME_TYPES.has(mime) || mime.startsWith('video/')) {
      return true;
    }
  }
  if (media.fileName) {
    const ext = media.fileName.split('.').pop()?.toLowerCase();
    if (ext && VIDEO_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}
```

### 6.3 Mapping and Transport Strategy

| Layer | Behavior / Representation |
|---|---|
| **Database (`post_media`)** | `media_type = DOCUMENT`, `mime_type = 'video/mp4'`, `file_name = 'video.mp4'`. Strictly stores what Telegram returned. |
| **Template Validation** | When validating a post against a template supporting `video`, `isDocumentAsVideo(item) === true` is recognized as a valid video input. The author is not blocked. |
| **Editor / Preview UI** | Displays a clear badge: `🎬 Видео (файл без сжатия): video.mp4 (45 MB)`. Informs author/editor that it will be published as an uncompressed document attachment. |
| **Media Group Rules** | Because it is internally a Telegram document, it **cannot** be mixed with photos or compressed videos in an album. The wizard rejects adding photos to it: `"Видео загружено без сжатия (как файл). В Telegram нельзя объединять файлы с обычными фото в одну медиагруппу."` |
| **Renderer Output** | Formatted as `type: 'document'`, `fileId: item.telegramFileId`. |
| **Publisher Worker** | Calls `bot.api.sendDocument(chatId, item.telegramFileId)` (or `InputMediaDocument` if in a document group). **Zero crashes with 400 Bad Request!** |

---

## 7. Concrete Interfaces, DTOs & Domain Types

### 7.1 DTO Definitions
```ts
// src/modules/media/dto/attach-media.dto.ts
import { MediaType } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class AttachMediaDto {
  @IsString()
  @IsNotEmpty()
  telegramFileId!: string;

  @IsString()
  @IsNotEmpty()
  telegramFileUniqueId!: string;

  @IsEnum(MediaType)
  mediaType!: MediaType;

  @IsString()
  @IsOptional()
  fileName?: string | null;

  @IsString()
  @IsOptional()
  mimeType?: string | null;

  @IsOptional()
  fileSize?: bigint | number | null;

  @IsString()
  @IsOptional()
  caption?: string | null;

  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}

export class AttachMediaBatchDto {
  items!: AttachMediaDto[];
}

export class ReorderMediaItemDto {
  @IsString()
  @IsNotEmpty()
  mediaId!: string;

  @IsNumber()
  sortOrder!: number;
}

export class ReorderMediaDto {
  orders!: ReorderMediaItemDto[];
}
```

### 7.2 Enriched Post Media Interface
```ts
// src/modules/media/interfaces/enriched-post-media.interface.ts
import { PostMedia, MediaType } from '@prisma/client';

export interface EnrichedPostMedia extends PostMedia {
  /** True if mediaType is DOCUMENT but content is video (mp4, mov, mkv, etc.) */
  isVideoDocument: boolean;
  /** True if mediaType is DOCUMENT but content is uncompressed image (png, jpg, etc.) */
  isImageDocument: boolean;
  /** Transport method for TelegramPublisher */
  transportMethod: 'sendPhoto' | 'sendVideo' | 'sendDocument' | 'sendAnimation';
}
```

### 7.3 TelegramPayload Media Contract (Renderer ↔ Publisher)
```ts
// src/modules/rendering/interfaces/telegram-payload.interface.ts
export interface TelegramOutgoingMessage {
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;
  html?: string;
  fileId?: string;
  caption?: string;
  fileName?: string;
  items?: Array<{
    type: 'photo' | 'video' | 'document';
    fileId: string;
    caption?: string;
  }>;
}

export interface TelegramPayload {
  messages: TelegramOutgoingMessage[];
}
```

---

## 8. Worker Implementation Steps (Milestone 3 / Milestone 4)

When the BullMQ worker (`PublishingWorker`) processes a publication job (`publish:{postId}:{version}`):

```text
Worker Job Started
       │
       ▼
1. Fetch Post with Media (ordered by sort_order ASC)
       │
       ▼
2. Preflight Check: Post active, channel active, bot admin verified
       │
       ▼
3. Check publication_jobs.telegram_message_ids (Resume partial publication)
       │
       ▼
4. Dispatch Outgoing Messages:
   ├─ If count === 0: Pure text -> bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
   ├─ If count === 1:
   │    ├─ mediaType === PHOTO -> bot.api.sendPhoto(chatId, fileId, { caption, parse_mode: 'HTML' })
   │    ├─ mediaType === VIDEO -> bot.api.sendVideo(chatId, fileId, { caption, parse_mode: 'HTML' })
   │    ├─ mediaType === ANIMATION -> bot.api.sendAnimation(chatId, fileId, { caption, parse_mode: 'HTML' })
   │    └─ mediaType === DOCUMENT (or isVideoDocument) -> bot.api.sendDocument(chatId, fileId, { caption, parse_mode: 'HTML' })
   └─ If count >= 2 and <= 10:
        └─ bot.api.sendMediaGroup(chatId, inputMediaGroup)
           (Returns Message[]; extract message_id from each element)
       │
       ▼
5. Record Message IDs in publication_jobs.telegram_message_ids
       │
       ▼
6. If multi-message split: send subsequent text message via bot.api.sendMessage
   Append new message_id to publication_jobs.telegram_message_ids
       │
       ▼
7. Transition Post to PUBLISHED & emit notification to Author/Editor
```

### Partial Publication Resume Strategy (F-34, AGENTS.md § 23)
- If `sendMediaGroup` succeeded (e.g. returned `[501, 502, 503]`), but the subsequent long text message failed due to a transient network timeout:
  - BullMQ retries the job.
  - The worker reads `publication_jobs.telegram_message_ids`.
  - Because `[501, 502, 503]` are already recorded, the worker **skips** `sendMediaGroup` and only sends the remaining text message!
  - This prevents duplicate albums in the Telegram channel.

---

## 9. Recommendations for Worker & Milestone 3 Implementation

1. **Create `src/modules/media/`**:
   - Implement `MediaService` with all transactional methods (`attachMedia`, `attachMediaBatch`, `removeMedia`, `reorderMedia`, `clearMedia`, `getMediaForPost`, `validateMediaForPost`).
   - Implement `media-detector.util.ts` for reliable document-as-video classification.
2. **Refactor `PostsService` delegation**:
   - In `PostsService`, delegate `attachMedia` and `removeMedia` to `MediaService` to maintain backward compatibility with existing tests in `tests/harness/test-harness.ts` and `tests/e2e/tier1-feature-coverage.spec.ts`.
3. **Connect with `TelegramRenderer` (m3_explorer_2)**:
   - Ensure the renderer queries `enrichedMedia` from `MediaService` so it renders `media_group` or single media payloads matching the detected transport types.
4. **Unit Tests to Add**:
   - `media-detector.spec.ts`: test MIME types and file extensions for document-as-video detection.
   - `media-group-validator.spec.ts`: test 1 item, 2 items, 10 items, 11 items, mixed photo/video, mixed photo/document, and animation rejection.
   - `media.service.spec.ts`: test atomic OCC increment, sort order compaction, and audit logging.
