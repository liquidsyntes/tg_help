# Tier 5 Adversarial Hardening Report — Telegram Transport, Interactive Wizard & Rendering Track

**Agent**: `m6_challenger_2` (`teamwork_preview_challenger`)  
**Track**: Telegram Transport, Interactive Wizard, Rendering, Media & Scheduling  
**Date**: 2026-09-22  
**Test Suite**: `tests/unit/adversarial-empirical-m6-transport.spec.ts`  
**Total Tests Executed**: 35 tests  
**Pass Rate**: 100% (35 passed, 0 failed)  
**Authoritative References**: `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`, `c:/TgHelp/.agents/PROJECT.md`, `c:/TgHelp/AGENTS.md` (§3, §10, §11, §12, §13, §15, §16, §18, §19, §24, §47), `tasks.md` (§6, §9, §10, §11, §12, §14, §15, §16, §18, §19)

---

## 1. Executive Summary

As part of Milestone 6 Phase 2 (Adversarial Coverage Hardening), `m6_challenger_2` conducted an in-depth white-box challenge of the Telegram transport, interactive wizard, canonical rendering engine, media debouncing pipeline, and Europe/Kyiv scheduling subsystems.

A comprehensive, hermetic, 35-test adversarial test suite was authored in `tests/unit/adversarial-empirical-m6-transport.spec.ts`, exercising:
1. **Complex HTML splitting & tag preservation boundaries** under extreme nesting depths (7 layers), multi-attribute anchors, entity slicing avoidance, continuous unbroken text tokens, and recursive multi-chunk splitting.
2. **Media album batching, burst concurrency & limit enforcement**, validating that rapid concurrent bursts of 10 items debounce into a single batch write with 1 OCC version increment, and that group limit bounds (<= 10 items) and mixed-media constraints are strictly enforced.
3. **Interactive wizard recovery from partial entries & session interruptions**, verifying seamless handling of skipped intermediate optional fields, strict protection against skipping required fields, input validation boundaries, and resilience against total Redis session loss by reconstructing wizard state from PostgreSQL.
4. **Europe/Kyiv timezone conversion & past-date validation**, verifying DST transitions (EEST UTC+3 in summer, EET UTC+2 in winter), Spring Forward and Fall Back switch boundaries for 2026, millisecond-exact past date rejection, format resilience, and end-to-end `SchedulingService` domain orchestration.

---

## 2. Test Execution & Verification

### Test Command:
```pwsh
npx jest tests/unit/adversarial-empirical-m6-transport.spec.ts --config ./tests/jest.json
```

### Execution Results:
```text
PASS tests/unit/adversarial-empirical-m6-transport.spec.ts
  Milestone 6 Adversarial Empirical Suite (m6_challenger_2)
    Track 1: Complex HTML Splitting & Tag Preservation Boundaries
      √ 1.1 should split deeply nested HTML (7 layers) respecting maxLength and preserving reverse-LIFO close & FIFO reopen (3 ms)
      √ 1.2 should preserve complex anchor tag attributes (URL + query params) across split boundary (1 ms)
      √ 1.3 should never slice through HTML entities (&quot;, &amp;, &lt;, &gt;, &#1234;) near split boundary
      √ 1.4 should never cut inside an HTML tag header (<blockquote class="...">) (1 ms)
      √ 1.5 should handle massive unbroken string (5500 chars) with tags without infinite recursion or exceeding limit
      √ 1.6 should split a 12,000 character document into balanced chunks all <= 4096 with zero dropped words (1 ms)
      √ 1.7 should handle exact boundary conditions (1024, 1025, 4096, 4097 chars)
      √ 1.8 should render post with single photo and 1500 char caption into photo (<=1024) + text message (<=4096) (1 ms)
      √ 1.9 should render post with media group (2 photos) and caption > 1024 into album + text message (1 ms)
    Track 2: Media Album Batching, Burst Concurrency & Limit Enforcement
      √ 2.1 should debounce a rapid burst of 10 incoming album items into a single attachMediaBatch call with 1 OCC increment (15 ms)
      √ 2.2 should reject album batch if attaching items would exceed maximum media group size (10) (16 ms)
      √ 2.3 should reject batch when existing media count + new items > 10 (1 ms)
      √ 2.4 should reject single media upload when post already has 10 items attached
      √ 2.5 should detect document as video when mimeType is video/* or extension is .mp4
      √ 2.6 should disallow mixing documents with photos/videos in a media group (1 ms)
      √ 2.7 should renormalize remaining sort orders to gapless 1..N upon media deletion
    Track 3: Wizard Recovery from Partial Entries & Session Interruptions
      √ 3.1 should allow skipping multiple intermediate optional fields and persist null values under OCC (1 ms)
      √ 3.2 should strictly reject skipping a required field and maintain session position (1 ms)
      √ 3.3 should reject field input exceeding maxLength without mutating DB or advancing field
      √ 3.4 should recover draft from PostgreSQL after complete Redis loss and resume at first missing required field
      √ 3.5 should return CONTROL_CARD if all required fields are present even if optional fields are omitted
      √ 3.6.1 should verify that PostsService.autosaveStep strictly rejects stale expectedVersion with PostConflictException (2 ms)
      √ 3.6.2 empirically confirms DraftManagerService.submitEditedField queries current DB post and passes post.version instead of session.expectedVersion (1 ms)
    Track 4: Europe/Kyiv Timezone Conversion & Past-Date Validation
      √ 4.1 should correctly convert Europe/Kyiv Summer Time (EEST, UTC+3) to UTC instant (5 ms)
      √ 4.2 should correctly convert Europe/Kyiv Winter Time (EET, UTC+2) to UTC instant (1 ms)
      √ 4.3 should accurately handle 2026 Spring Forward DST transition (last Sunday of March)
      √ 4.4 should accurately handle 2026 Fall Back DST transition (last Sunday of October)
      √ 4.5 should reject dates in the past with exact boundary test against reference nowMs (4 ms)
      √ 4.6 should reject invalid calendar dates and malformed strings (3 ms)
      √ 4.7 should safely fall back to DEFAULT_CHANNEL_TIMEZONE (Europe/Kyiv) if invalid timezone string is provided (1 ms)
      √ 4.8 should support yyyy-MM-dd and ISO datetime format inputs in channel timezone (1 ms)
      SchedulingService Domain Orchestration Stress
        √ 4.9 should schedule post: parse Kyiv time, validate Stage 1, transition APPROVED -> SCHEDULED, create PublicationJob, and enqueue delayed BullMQ job (1 ms)
        √ 4.10 should reject scheduling for posts not in APPROVED status (e.g. DRAFT or PENDING_REVIEW) (3 ms)
        √ 4.11 should cancel schedule: verify permission, remove delayed BullMQ job, mark DB job CANCELLED, and transition SCHEDULED -> CANCELLED
        √ 4.12 should reject cancel schedule if user lacks CANCEL_SCHEDULE channel permission (1 ms)

Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
Snapshots:   0 total
Time:        5.223 s
```

---

## 3. Discovered Implementation Defects & Gaps

During white-box adversarial stress testing, one significant concurrency gap was discovered and confirmed empirically:

### Defect finding: `DraftManagerService.submitEditedField` Bypasses OCC Version Check
- **Location**: `src/modules/telegram/services/draft-manager.service.ts`, lines 176–212.
- **Mechanism**:
  1. When an author initiates granular editing of a field via `startEditField()`, the current post version is recorded into the Redis session (`session.expectedVersion: post.version`).
  2. When the author later sends the replacement text and triggers `submitEditedField()`, the method parses the session, but instead of passing `session.expectedVersion` to `postsService.autosaveStep()`, it executes `const post = await this.postsRepository.findById(session.postId)` and passes `post.version` (the freshly queried database version).
  3. **Blast Radius**: If another user (e.g., an Editor or co-author) modifies the post while the author is typing a field edit, the author's submission re-reads the updated version from the DB and overwrites the post without raising `PostConflictException`. This circumvents AGENTS.md §13 ("Updates should verify the expected version... Do not silently overwrite another user's edits") and tasks.md §12.
- **Empirical Confirmation**: Verified in test `3.6.2`, where `autosaveStep` is called with `post.version` rather than `session.expectedVersion`.
- **Recommended Mitigation**: Update line 207 of `draft-manager.service.ts` to pass `session.expectedVersion ?? post.version` to `autosaveStep()`, properly surfacing `PostConflictException` to the user.

---

## 4. Architectural Invariants Verified

1. **TelegramRenderer & HtmlSplitter**:
   - `TelegramRenderer` guarantees that messages never violate Telegram length limits (captions $\le$ 1024, text messages $\le$ 4096).
   - In multi-message publications (single media or media group with caption > 1024), message 0 contains the media attachment with caption <= 1024, and message 1 contains the remaining text <= 4096.
   - Tag balancing guarantees that neither chunk contains dangling unclosed tags.
2. **Media Album Burst Debouncing**:
   - `PostWizardService.processMediaUpload` uses a 600ms debounce window backed by Redis `rpush` to collect media group items.
   - 10 rapidly arriving photos result in exactly 1 `attachMediaBatch` invocation and 1 OCC version increment.
3. **Draft Recovery**:
   - When Redis cache is entirely lost, `DraftManagerService.resumeDraft` reconstructs wizard state by inspecting PostgreSQL `contentJson` against `TemplateSchema.fields`, resuming at the first missing required field without prompting for optional fields that were skipped.
4. **Timezone & Scheduling**:
   - `parseAndValidateScheduledDate` converts Europe/Kyiv time (EEST UTC+3 / EET UTC+2) to precise UTC timestamps, correctly navigating DST transitions in 2026.
   - Past dates are strictly rejected at the millisecond boundary against current time.
