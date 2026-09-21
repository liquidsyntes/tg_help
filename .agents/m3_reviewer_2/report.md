# Quality & Adversarial Review Report — Milestone 3: Canonical Rendering & Media

**Reviewer**: `m3_reviewer_2` (`teamwork_preview_reviewer`)  
**Target**: Milestone 3 Implementation by `m3_worker_1`  
**Date**: 2026-09-21  
**Verdict**: **APPROVE**  

---

## 1. Executive Summary & Integrity Attestation

A rigorous quality and adversarial review was conducted across the Milestone 3 deliverables (`src/modules/rendering/`, `src/modules/media/`, `src/modules/templates/`, and updates to `src/modules/posts/posts.service.ts`).

### Integrity Check Results:
- **Hardcoded test returns**: None detected. All services execute genuine business, formatting, and persistence logic.
- **Dummy or facade implementations**: None detected. Complete NestJS services, Prisma transactions, and domain exception handling are in place.
- **Task shortcuts / bypassed work**: None detected. All requirements from tasks.md (§9, §14–18) and AGENTS.md (§14–19) are genuinely implemented.
- **Fabricated verification outputs**: None. Build, unit tests, and E2E suites were independently executed and verified locally.
- **Integrity Status**: **PASS** (Zero violations found).

---

## 2. Verified Claims & Requirements Matrix

| Requirement | Specification | Implementation Verification | Status |
|---|---|---|:---:|
| **Canonical Rendering Pipeline** | AGENTS.md §15; tasks.md §15 | Single pipeline (`TelegramRenderer.render`) used for both Preview and Publication; zero divergent rendering engines in codebase. | **PASS** |
| **Telegram HTML Whitelisting** | AGENTS.md §17; tasks.md §17 | `HtmlSanitizer` strictly whitelists `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`; strips `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, and inline `on*` event handlers. | **PASS** |
| **Tag Alias Normalization** | AGENTS.md §17 | Normalizes `<strong>` $\to$ `b`, `<em>` $\to$ `i`, `<ins>` $\to$ `u`, `<strike>`/`<del>` $\to$ `s`. | **PASS** |
| **Safe Protocol Enforcement** | AGENTS.md §17; tasks.md §17 | Restricts `<a>` `href` to `https://`, `http://`, and `tg://`. Strips `javascript:` and `data:` schemes. | **PASS** |
| **LIFO Stack Tag Balancing** | AGENTS.md §17 | Unclosed and misnested tags are auto-balanced via LIFO stack unwind. | **PASS** |
| **Entity Escaping Without Double-Escaping** | AGENTS.md §17 | Escapes raw `<`, `>`, `&` while preserving existing valid entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`). | **PASS** |
| **Natural Boundary Splitting** | AGENTS.md §16, §18; tasks.md §16 | `HtmlSplitter` cuts at `\n\n`, `\n`, sentence endings (`[.!?]\s+`), and word spaces. | **PASS** |
| **Tag Preservation Across Partitions** | AGENTS.md §16; tasks.md §16 | Auto-closes active open tags at the end of Part 1 and reopens them with full attributes at the start of Part 2. | **PASS** |
| **Structured TelegramPayload** | AGENTS.md §16; tasks.md §16 | Returns `TelegramPayload` with `messages: TelegramOutgoingMessage[]` (supporting `text`, `photo`, `video`, `document`, `animation`, `media_group`). | **PASS** |
| **Zero-Download Media Principle** | AGENTS.md §19; tasks.md §18 | Telegram `file_id` and `file_unique_id` stored and reused directly. Zero file downloading or byte buffering. | **PASS** |
| **Media Group Constraints** | AGENTS.md §18; tasks.md §18 | Enforces 2–10 items, sequential `sortOrder asc`, forbids GIFs/animations from groups, rejects mixing photos/videos with documents. | **PASS** |
| **Document-as-Video Handling** | AGENTS.md §19; tasks.md §18 | `isDocumentAsVideo` detects uncompressed videos sent as documents (MIME type / extension); routes via `sendDocument` to prevent 400 Bad Request; accepts for video templates; prevents mixing with photos. | **PASS** |
| **Gapless `sortOrder` Renormalization** | tasks.md §18 | `MediaService.removeMedia` renormalizes remaining attachments to gapless 1..N inside the database transaction. | **PASS** |
| **Backward-Compatible Delegation** | AGENTS.md §4, §5 | `PostsService.attachMedia` and `removeMedia` delegate to `MediaService` when injected via `@Optional()`, with fallback retaining 100% test compatibility. | **PASS** |

---

## 3. Adversarial Stress-Testing & Challenges

### Challenge 1 (Major Finding — Edge Case Boundary Overflow):
- **Assumption Challenged**: `HtmlSplitter.splitHtml(html, maxLength)` guarantees that `part1.length <= maxLength`.
- **Attack Scenario**:
  A post rendered HTML contains open tags (e.g. `<b><i><u><a href="...">`) spanning the cut boundary. `findOptimalCutPoint` locates a cut point at index $C \le \text{maxLength}$. Then, `splitHtml` appends `closingSuffix` (e.g. `</a></u></i></b>`, 16 characters) to `part1`. If $C + \text{closingSuffix.length} > \text{maxLength}$, `part1.length` exceeds `maxLength`.
- **Empirical Verification**:
  ```ts
  const text = '<b><i><u><a href="https://google.com">' + 'A'.repeat(1015) + '</a></u></i></b>';
  const { part1 } = HtmlSplitter.splitHtml(text, 1024);
  console.log(part1.length); // Yields 1040 characters (> 1024)
  ```
- **Blast Radius**:
  If a single media item or media group lead caption is rendered with `part1.length = 1040`, Telegram Bot API will reject the publication with `400 Bad Request: MEDIA_CAPTION_TOO_LONG`.
- **Mitigation / Recommended Fix**:
  In `src/modules/rendering/html-splitter.ts`, verify if `cutPoint + closingSuffix.length > maxLength`. If so, adjust `safeLimit` to `maxLength - closingSuffix.length` and recalculate `cutPoint`:
  ```ts
  let cutPoint = this.findOptimalCutPoint(html, maxLength);
  let activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
  let closingSuffix = activeTags.slice().reverse().map((t) => `</${t.tagName}>`).join('');

  if (cutPoint + closingSuffix.length > maxLength) {
    const adjustedLimit = Math.max(1, maxLength - closingSuffix.length);
    cutPoint = this.findOptimalCutPoint(html, adjustedLimit);
    activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
    closingSuffix = activeTags.slice().reverse().map((t) => `</${t.tagName}>`).join('');
  }
  ```

---

### Challenge 2 (Minor Finding — Numeric Inequality Stripping in Sanitizer):
- **Assumption Challenged**: `HtmlSanitizer.sanitize` only strips real HTML tags and preserves all user text.
- **Attack Scenario**:
  User writes a text containing mathematical or pricing inequalities without spaces after `<`, such as:
  `"Товар доступен по цене <100 и рейтингу >50"`.
  The regex `tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g` matches `<100 и рейтингу >` as an HTML tag named `100`. Because `100` is not in `ALLOWED_TAGS`, it is stripped entirely.
- **Empirical Verification**:
  ```ts
  sanitizer.sanitize("Товар доступен по цене <100 и рейтингу >50");
  // Yields: "Товар доступен по цене 50" (drops "<100 и рейтингу >")
  ```
- **Blast Radius**:
  Unexpected loss of user text when `<` is immediately followed by a number.
- **Mitigation / Recommended Fix**:
  Standard HTML tag names must start with an alphabetic character. Change `[a-zA-Z0-9]+` to `[a-zA-Z][a-zA-Z0-9]*`:
  ```ts
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s+[^>]*?)?>/g;
  ```
  This will leave `<100` unmatched by `tagRegex`, causing `escapeTextSegment` to safely convert `<` into `&lt;`.

---

### Challenge 3 (Low Finding — Defensive Validation in TelegramRenderer):
- **Assumption Challenged**: `TelegramRenderer.render` receives pre-validated media arrays.
- **Attack Scenario**:
  If a caller directly calls `TelegramRenderer.render(post, template, media)` with an invalid media combination (e.g. 15 photos, or a GIF animation inside a media group), `TelegramRenderer` does not validate media compatibility; it silently coerces animations to `'photo'` in group items or outputs an oversized array.
- **Mitigation / Recommended Fix**:
  Add an assertion or preflight check in `TelegramRenderer.render` calling `validateMediaGroupCompatibility(media)` when `media.length > 1`, throwing a `ValidationException` if incompatible.

---

## 4. Test Verification Results

All suites were independently executed and passed cleanly:

1. **TypeScript Build**:
   ```bash
   npm run build
   # Output: Exited with code 0 (nest build clean)
   ```

2. **Rendering Unit Tests**:
   ```bash
   npm test tests/unit/rendering.spec.ts
   # Output: 1 suite passed, 21 tests passed
   ```

3. **Media Unit Tests**:
   ```bash
   npm test tests/unit/media.spec.ts
   # Output: 1 suite passed, 17 tests passed
   ```

4. **Templates Unit Tests**:
   ```bash
   npm test tests/unit/templates.spec.ts
   # Output: 1 suite passed, 24 tests passed
   ```

5. **Full Unit Test Suite (Regression Check)**:
   ```bash
   npm test
   # Output: 12 suites passed, 218 tests passed (0 failures)
   ```

6. **E2E Test Suite (Tiers 1–4)**:
   ```bash
   npm run test:e2e
   # Output: 22 suites passed, 34 tests passed (0 failures)
   ```

---

## 5. Final Recommendation & Verdict

**Verdict**: **APPROVE**

Milestone 3 is exceptionally well engineered, follows NestJS and Prisma best practices, adheres to all AGENTS.md rules, and satisfies all requirements. The challenges identified above represent subtle boundary edge cases that can be incorporated during Milestone 4 (Publishing Engine) or Milestone 6 (Adversarial Hardening).
