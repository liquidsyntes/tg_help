# Handoff Report — Tier 5 Adversarial Hardening (Transport, Wizard & Rendering Track)

**Agent**: `m6_challenger_2` (`teamwork_preview_challenger`)  
**Parent Conversation ID**: `6f35b072-3fac-43df-87fc-95e48993acc2`  
**Working Directory**: `c:/TgHelp/.agents/m6_challenger_2`  
**Date**: 2026-09-22  
**Handoff Type**: Hard (Task Complete)  

---

## 1. Observation

1. **Source Inspection**:
   - `src/modules/rendering/html-splitter.ts`: Implements tag-budgeted splitting algorithm with `isInsideTagOrEntity()`, backward boundary search, reverse LIFO auto-closing suffix, and FIFO reopening prefix.
   - `src/modules/rendering/telegram-renderer.service.ts`: Canonical rendering pipeline. Lines 86–117 and 149–183 split single media and media group items exceeding 1024 characters into media item with caption $\le 1024$ plus trailing text message(s) $\le 4096$.
   - `src/modules/telegram/services/post-wizard.service.ts`: Lines 369–418 implement media group debouncing using Redis buffer `album:buf:${mediaGroupId}` and a 600ms timer (`albumTimers`).
   - `src/modules/media/media.service.ts`: Lines 47–51 and 124–128 enforce `TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE` (10 items). Lines 198–220 renormalize sort orders to gapless 1..N upon item deletion.
   - `src/modules/telegram/services/draft-manager.service.ts`:
     - Lines 79–120: `resumeDraft()` inspects PostgreSQL `contentJson` against `TemplateSchema.fields` to find the first missing required field, ignoring unfilled optional fields.
     - Lines 176–212: `submitEditedField()` queries the database afresh via `this.postsRepository.findById(session.postId)` and invokes `this.postsService.autosaveStep(session.postId, post.version, actorId, ...)` using the freshly fetched database version (`post.version`) rather than the version stored in the Redis session (`session.expectedVersion`).
   - `src/modules/channels/utils/timezone.util.ts`: Uses Luxon with `Europe/Kyiv` IANA zone; converts to UTC and rejects `date.getTime() <= nowMs`.
   - `src/modules/scheduling/scheduling.service.ts`: Validates `post.status === PostStatus.APPROVED`, parses Kyiv time, runs Stage 1 preflight, transitions state to `SCHEDULED`, writes `PublicationJob` with `idempotencyKey = publish:${postId}:${version}`, and enqueues delayed BullMQ job.

2. **Empirical Test Execution**:
   - Authored 35 new white-box tests in `tests/unit/adversarial-empirical-m6-transport.spec.ts`.
   - Test execution command: `npx jest tests/unit/adversarial-empirical-m6-transport.spec.ts --config ./tests/jest.json`.
   - Result: 35 passed, 0 failed (duration: ~5.2s).
   - Full repository test execution command: `npm test`.
   - Result: 34 test suites passed, 34 total; 559 tests passed, 559 total (duration: ~11.9s).

---

## 2. Logic Chain

1. **HTML Splitting & Tag Preservation**:
   - `HtmlSplitter.splitHtml()` was tested under 7 layers of tag nesting (`<blockquote><pre><code><b><i><u><s>`).
   - Observations confirm that `part1` strictly bounds length to $\le 1024$, appends closing tags in reverse LIFO order (`</s></u></i></b></code></pre></blockquote>`), and `part2` reopens them in FIFO order.
   - Boundary tests confirmed that HTML entities (`&quot;`, `&amp;`) and tag definitions (`<blockquote class="...">`) are never sliced across chunk borders.
   - Massive unbroken 5500-character strings and 12,000-character documents split cleanly into $\le 4096$ chunks without infinite loops or lost content.

2. **Media Burst Concurrency & Limits**:
   - Simulating 10 concurrent incoming photos within 50ms triggered the debouncing timer in `PostWizardService.processMediaUpload()`.
   - All 10 items were buffered into Redis, and exactly one `attachMediaBatch()` transaction executed, incrementing post version exactly once (version 1 -> 2).
   - Attempting to attach 11 items or exceeding the 10-item cap (e.g. 8 existing + 3 new) strictly raised `ValidationException`.
   - Mixed media groups containing documents with photos/videos were correctly rejected by `validateMediaGroupCompatibility()`.

3. **Wizard Recovery & Interruption Resistance**:
   - Skipping multiple optional fields (`subtitle`, `lead`, `cta`) persisted `null` values under OCC and correctly advanced the wizard.
   - Attempting to skip required fields (`title`, `body`) was rejected.
   - When Redis was wiped, `DraftManagerService.resumeDraft()` reconstructed the session at `body` (the first missing required field).

4. **Defect Discovery — OCC Bypass in Granular Editing**:
   - In `DraftManagerService.startEditField()`, `session.expectedVersion` is captured from `post.version`.
   - However, in `DraftManagerService.submitEditedField()` (line 207), `post.version` is retrieved directly from `this.postsRepository.findById()` and passed to `autosaveStep()`.
   - When a concurrent modification occurs in the database (bumping version from 5 to 6), `submitEditedField()` passes 6 instead of 5, which satisfies `autosaveStep()` and silently overwrites the concurrent edit.
   - This violates AGENTS.md §13 and tasks.md §12. This was confirmed empirically in test `3.6.2`.

5. **Europe/Kyiv Timezone Conversion**:
   - Verified that `20.07.2026 15:00` (EEST, UTC+3) maps to `12:00:00.000Z` UTC and `20.01.2026 15:00` (EET, UTC+2) maps to `13:00:00.000Z` UTC.
   - Verified the 2026 Spring Forward (March 29) and Fall Back (October 25) boundaries.
   - Verified that past dates at `nowMs` or earlier throw `ValidationException`.

---

## 3. Caveats

1. **Review-Only Constraint**:
   - As per challenger constraints, the defect in `DraftManagerService.submitEditedField` was documented and proven empirically, but the implementation source code was not modified.
2. **Network & Real Telegram API**:
   - Real network latency and actual Telegram Bot API rate limiting are simulated via unit doubles and grammY mock contexts; real Telegram webhooks were not connected to live Telegram servers.

---

## 4. Conclusion

The Telegram transport, wizard, rendering, media, and scheduling tracks have demonstrated high architectural resilience across 34 of 35 evaluated invariant checks.

- **Status**: Milestone 6 Phase 2 (Adversarial Coverage Hardening for Transport Track) is **COMPLETE**.
- **Delivered Suite**: `tests/unit/adversarial-empirical-m6-transport.spec.ts` (35 tests, 100% pass rate).
- **Actionable Finding**: Patch `src/modules/telegram/services/draft-manager.service.ts` line 207 to pass `session.expectedVersion ?? post.version` to `autosaveStep()` so concurrent edits trigger `PostConflictException`.

---

## 5. Verification Method

To independently verify the adversarial findings and test execution:

```pwsh
# 1. Run the transport track adversarial suite:
npx jest tests/unit/adversarial-empirical-m6-transport.spec.ts --config ./tests/jest.json

# 2. Run the entire unit test suite across all modules:
npm test
```
