# Milestone 3 Empirical Challenger Report — Media System (Round 2)

**Agent**: `m3_challenger_2_r2`  
**Target**: Milestone 3 (`MediaService`, `media-detector.util`, `TelegramRenderer`)  
**Verdict**: **APPROVE**  
**Date**: 2026-09-21  

---

## Executive Summary

As empirical challenger `m3_challenger_2_r2`, I subjected `MediaService`, `media-detector.util.ts`, and associated rendering and validation pipelines to rigorous adversarial stress testing. A dedicated round-2 empirical test harness (`tests/unit/media-stress-r2.spec.ts`) with 22 tests was authored and executed alongside existing test suites (`tests/unit/media.spec.ts` [17 tests] and `tests/unit/media-stress-challenge.spec.ts` [20 tests]).

All 59 media-related empirical tests passed with 100% success rate. The TypeScript build (`nest build`) and the complete E2E test suite (`npm run test:e2e`: 34/34 tests across Tiers 1–4) passed with zero regressions.

---

## 1. Dimension 1: Media Group Boundaries & Invariants

### 1.1 Album Item Counts
- **1 item boundary**:
  - `validateMediaGroupCompatibility([{ mediaType: MediaType.PHOTO }])` returned `{ isValid: true, isAlbum: false }`.
  - In `TelegramRenderer.render`, a single media item is rendered as a standalone media message (`type: 'photo' | 'video' | 'document' | 'animation'`) and is **never** packaged into a `media_group`.
- **2 to 10 items (valid album)**:
  - Verified across all integer counts $N \in [2, 10]$ that `validateMediaGroupCompatibility` returns `{ isValid: true, isAlbum: true }`.
  - `TelegramRenderer.render` correctly constructs a `type: 'media_group'` payload containing all items with the caption allocated to the lead item.
- **11+ items (limit rejection)**:
  - `validateMediaGroupCompatibility` with 11 items returned `{ isValid: false, isAlbum: true, error: 'Медиагруппа не может содержать более 10 элементов (лимит Telegram).' }`.
  - `MediaService.attachMedia` rejected adding the 11th item when 10 already exist with `ValidationException: Максимальное количество медиафайлов для одной публикации — 10.`.
  - `MediaService.attachMediaBatch` rejected an incoming batch of 11 items (or a batch that pushes existing count > 10) with `ValidationException`.

### 1.2 Media Group Type Mixing
- **PHOTO + VIDEO**: Validated as permitted (`isValid: true, isAlbum: true`). Telegram Bot API natively allows mixing photos and videos within a single album.
- **PHOTO + DOCUMENT**: Validated as rejected (`isValid: false, error: 'Нельзя объединять фото/видео и документы (файлы) в одну медиагруппу Telegram.'`).
- **VIDEO + DOCUMENT**: Validated as rejected (`isValid: false`).
- **ANIMATION / GIF in Album**: Validated as rejected (`isValid: false, error: 'GIF-анимации нельзя объединять в медиагруппу. Анимация отправляется отдельным сообщением.'`). Tested for PHOTO+ANIMATION, VIDEO+ANIMATION, DOCUMENT+ANIMATION, and ANIMATION+ANIMATION.

---

## 2. Dimension 2: Document-as-Video Classification & Invariants

### 2.1 MIME Type and Extension Detection
- **Direct Video MIME types**: `isDocumentAsVideo` correctly returned `true` for all standard MIME types (`video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`, `video/avi`, `video/3gpp`, `video/mpeg`).
- **Case-insensitivity**: `VIDEO/MP4` and `Video/QuickTime` correctly identified.
- **Arbitrary `video/*` prefix**: Tested `video/x-unknown-format`, correctly detected.
- **Generic Octet-Stream with Video Extension**: `mimeType: 'application/octet-stream'` with `fileName: 'clip.mp4'`, `'movie.MOV'`, and `'recording.mkv'` correctly identified.
- **Non-Video Documents**: Standard PDFs (`application/pdf`), archives (`application/zip`), plain text (`text/plain`), images (`image/png`), and generic binaries (`application/octet-stream` without video extension) correctly returned `false`.
- **Native PHOTO and VIDEO**: Verified that `mediaType: MediaType.VIDEO` and `mediaType: MediaType.PHOTO` return `false` because they are already native types, not documents requiring conversion.

### 2.2 Transport Method Routing
- Under Telegram Bot API, passing a document `file_id` to `sendVideo` triggers:
  `400 Bad Request: wrong remote file identifier specified: can't use "..." file_id with sendVideo`.
- Verified that `MediaService.getMediaForPost` enriches document-as-video items with `isVideoDocument: true` and explicitly sets `transportMethod: 'sendDocument'`.
- Verified in `TelegramRenderer` that document-as-video items retain `type: 'document'`, ensuring the publishing layer dispatches via `sendDocument`.

### 2.3 Prevention of Illegal Grouping with Photos
- Verified that attaching a `PHOTO` and a document-as-video (`DOCUMENT` with `video/mp4`) to the same post causes `MediaService.validateMediaForPost` to fail with error:
  `"Нельзя объединять фото/видео и документы (файлы) в одну медиагруппу Telegram."`.
- This ensures an uncompressed video document cannot inadvertently corrupt a photo album.

---

## 3. Dimension 3: Gapless Sort Order Renormalization

### 3.1 Test Harness Execution: Middle Deletion (Item #2 of 5)
1. Attached 5 media items with initial sortOrder 1, 2, 3, 4, 5.
2. Deleted item #2 (sortOrder = 2) via `MediaService.removeMedia`.
3. Observed database transaction:
   - Deleted record for item #2.
   - Loaded remaining records ordered by sortOrder ascending.
   - Updated items with sortOrder mismatch: former item #3 (sortOrder 3) -> 2, former item #4 (sortOrder 4) -> 3, former item #5 (sortOrder 5) -> 4.
4. Verified that remaining items have strictly `sortOrder` = **[1, 2, 3, 4]** without gaps.
5. Verified mapping:
   - Item 1 (`uniq-id-1`): sortOrder = 1
   - Item 3 (`uniq-id-3`): sortOrder = 2
   - Item 4 (`uniq-id-4`): sortOrder = 3
   - Item 5 (`uniq-id-5`): sortOrder = 4

### 3.2 Boundary Deletions: Head, Tail, and Append
- **Head Deletion (Item #1)**: Deleting the item with sortOrder 1 renormalized remaining 3 items to `[1, 2, 3]`.
- **Tail Deletion (Item #3)**: Deleting the tail item left remaining items at `[1, 2]`.
- **Append After Deletion**: Adding a new item correctly assigned sortOrder = 3 (`(highest?.sortOrder ?? 0) + 1`).
- **OCC and Audit Invariants**: Every `removeMedia` operation bumped the post OCC `version` and recorded `AuditAction.MEDIA_REMOVED` with `mediaId`, `telegramFileUniqueId`, and post `version`.

---

## 4. Dimension 4: Zero-Download Verification

### 4.1 Static Code Audit
Inspected `src/modules/media/media.service.ts` and `src/modules/media/utils/media-detector.util.ts`:
- **Filesystem imports**: Verified ZERO imports or references to `fs`, `node:fs`, `writeFile`, `writeFileSync`, `createWriteStream`.
- **HTTP / Network imports**: Verified ZERO imports or references to `http`, `https`, `node:http`, `node:https`, `axios`, `got`, `node-fetch`, `fetch`.
- **Stream / Buffer handling**: Verified no buffer allocation (`Buffer.from`, `Buffer.alloc`) or disk caching.

### 4.2 Runtime Execution Audit
In `tests/unit/media-stress-r2.spec.ts`:
- Spied on `globalThis.fetch`.
- Executed `attachMedia`, `attachMediaBatch`, `getMediaForPost`, `validateMediaForPost`, and `removeMedia`.
- Asserted `expect(fetchSpy).not.toHaveBeenCalled()`.
- Asserted total execution time was under 100ms (purely in-memory relational operations).
- Asserted stored records contain strictly string identifiers (`telegramFileId`, `telegramFileUniqueId`) and scalar metadata, with `buffer === undefined` and `data === undefined`.

---

## 5. Empirical Verification Outputs

### 5.1 Media Test Suites
```text
npx jest tests/unit/media.spec.ts tests/unit/media-stress-challenge.spec.ts tests/unit/media-stress-r2.spec.ts --config ./tests/jest.json

PASS tests/unit/media.spec.ts (5.205 s)
PASS tests/unit/media-stress-challenge.spec.ts (5.211 s)
PASS tests/unit/media-stress-r2.spec.ts (5.248 s)

Test Suites: 3 passed, 3 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        6.042 s
```

### 5.2 TypeScript Build
```text
npm run build
> tg-content-publisher@1.0.0 build
> nest build
Exited with code 0.
```

### 5.3 E2E Test Suite (Tiers 1–4)
```text
npm run test:e2e
ℹ tests 34
ℹ suites 22
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 312.2405
Exited with code 0.
```

---

## 6. Verdict

**Verdict**: **APPROVE**

The media system implementation satisfies all specified boundaries and invariants:
1. Media group counts (1, 2–10, 11+) and type mixing restrictions are strictly enforced.
2. Document-as-video classification is accurate across MIME types and extensions, routes transport to `sendDocument`, and prevents illegal grouping with photos.
3. Media deletion reliably renormalizes sort orders to a contiguous 1..N sequence inside the database transaction while maintaining OCC versioning and audit trails.
4. Zero-download design is preserved both statically and at runtime.
