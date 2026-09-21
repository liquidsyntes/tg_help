# Milestone 3 Challenger Handoff Report (m3_challenger_1_r2)

## 1. Observation

1. **Compilation & Baseline**:
   - `npm run build` exits with code 0.
   - `npm run test:e2e` passes 34/34 tests across 22 suites.

2. **Test Suite Typecheck Inconsistency in Initial State**:
   - Running `npm test` initially failed with:
     ```text
     tests/unit/adversarial-empirical-m3.spec.ts:347:11 - error TS2322: Type 'number' is not assignable to type 'bigint'.
     347           fileSize: 102400,
     ```
     `PostMedia.fileSize` in Prisma is defined as `BigInt?`, requiring `bigint | null` (e.g. `BigInt(102400)`). Fixing line 347 in the mock object allowed `adversarial-empirical-m3.spec.ts` to execute under `ts-jest`.

3. **Empirical Execution of Adversarial Suite**:
   - Executing `npx ts-node tests/empirical-m3-verification.ts` yielded:
     ```text
     STRESS 3.3: Caption split limit: 1024. Part1 length: 1036. Over limit by: 12
     STRESS 3.4: Message split limit: 4096. Part1 length: 4123. Over limit by: 27
     STRESS 3.4b: TelegramRenderer message 0 caption length: 1036. Over limit by: 12

     Total tests: 47
     Passed:      44
     Failed:      3
     ```
   - Executing `npx jest tests/unit/adversarial-empirical-m3.spec.ts` yielded:
     ```text
     ● Milestone 3 Empirical Adversarial Stress Suite (m3_challenger_1) › 3. Multi-Message Boundary Splitting Challenge › 3.10 should check part1 length with deep open tags near caption limit (1024)
       Expected: <= 1024
       Received:    1038

     ● Milestone 3 Empirical Adversarial Stress Suite (m3_challenger_1) › 3. Multi-Message Boundary Splitting Challenge › 3.11 should check part1 length with deep open tags near message limit (4096)
       Expected: <= 4096
       Received:    4111
     ```

4. **Code Inspection of `src/modules/rendering/html-splitter.ts`**:
   Lines 27–38 of `HtmlSplitter.splitHtml`:
   ```ts
   // 1. Find optimal natural cut point <= maxLength
   const cutPoint = this.findOptimalCutPoint(html, maxLength);

   // 2. Track active open tags up to cutPoint
   const activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));

   // 3. Close open tags at end of Part 1 (in reverse LIFO order)
   const closingSuffix = activeTags
     .slice()
     .reverse()
     .map((t) => `</${t.tagName}>`)
     .join('');
   const part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix;
   ```
   `cutPoint` is chosen solely against `maxLength` (e.g. 1020). Then `closingSuffix` (e.g. `16–30` characters) is appended without ensuring `cutPoint + closingSuffix.length <= maxLength`.

5. **Code Inspection of `src/modules/rendering/telegram-renderer.service.ts`**:
   Lines 86–99:
   ```ts
   const { part1, part2 } = HtmlSplitter.splitHtml(
     renderedHtml,
     TELEGRAM_LIMITS.MAX_CAPTION_LENGTH,
   );

   const messages: TelegramOutgoingMessage[] = [
     {
       partIndex: 0,
       type: outgoingType,
       fileId: item.telegramFileId,
       caption: part1,
   ```
   `part1` is assigned directly to `messages[0].caption`. When `part1.length = 1036`, `messages[0].caption` is 1036 characters, strictly violating `TELEGRAM_LIMITS.MAX_CAPTION_LENGTH = 1024`.

---

## 2. Logic Chain

1. **Telegram API Constraints (Observation 4 & 5)**:
   Telegram Bot API strictly enforces:
   - Captions for photos, videos, animations, and documents must not exceed 1024 UTF-16 code units (`MAX_CAPTION_LENGTH`).
   - Messages sent via `sendMessage` must not exceed 4096 UTF-16 code units (`MAX_MESSAGE_LENGTH`).
   - Telegram returns `HTTP 400 Bad Request: message caption is too long` or `message is too long` if these limits are exceeded.

2. **Root Cause in `HtmlSplitter` (Observation 4)**:
   In `HtmlSplitter.splitHtml(html, maxLength)`, `findOptimalCutPoint(html, maxLength)` chooses a boundary close to `maxLength` (e.g. 1018 or 4085). The method then computes `closingSuffix` for active open tags and appends it to `part1`. Because the length of `closingSuffix` was not subtracted from the cut point search budget, `part1.length` equals `cutPoint + closingSuffix.length`, which exceeds `maxLength` whenever open tags exist near the boundary.

3. **Impact on `TelegramRenderer` (Observation 3 & 5)**:
   In `TelegramRenderer.render()`, single media and media groups with text > 1024 call `HtmlSplitter.splitHtml(renderedHtml, 1024)`. When `part1.length` is 1036, `messages[0].caption` receives 1036 characters. When M4 publishing worker sends this payload, the Telegram API call will fail with HTTP 400. After retries are exhausted, the post transitions to `PUBLISH_FAILED`.

4. **Malicious Injection & Tag Balancing Robustness (Observation 3)**:
   All 17 malicious injection tests (scripts, iframes, onerror, javascript protocols, tag smuggling, event handlers) and all 12 tag balancing / entity escaping tests passed without defect in `HtmlSanitizer`. The vulnerability is isolated to boundary splitting in `HtmlSplitter` and `TelegramRenderer`.

---

## 3. Caveats

1. **No Live Telegram Network Calls**:
   Verification was performed empirically via runtime test harnesses simulating inputs and limits (`TELEGRAM_LIMITS`). Live HTTP calls to Telegram servers are scoped to Milestone 4.
2. **Review-Only Role**:
   Per role constraints ("Review-only — do NOT modify implementation code"), no changes were made to `src/modules/rendering/html-splitter.ts`. The defect is surfaced with an exact, actionable mitigation proposal for the worker.

---

## 4. Conclusion

- **Verdict**: **REQUEST_CHANGES**
- **Action Required**:
  Update `src/modules/rendering/html-splitter.ts` so that `splitHtml(html, maxLength)` guarantees `part1.length <= maxLength` by accounting for `closingSuffix.length` in the cut point budget.
  Specifically, if `cutPoint + closingSuffix.length > maxLength`, `findOptimalCutPoint` must be called with `safeLimit = maxLength - closingSuffix.length` (iterating if new open tags are encountered) until `part1.length <= maxLength`.

---

## 5. Verification Method

To independently reproduce and verify this defect:

1. **Run the Empirical Verification Harness**:
   ```bash
   npx ts-node tests/empirical-m3-verification.ts
   ```
   *Expected Output*:
   - STRESS 3.3 fails with `part1 length = 1036 (limit 1024)`
   - STRESS 3.4 fails with `part1 length = 4123 (limit 4096)`
   - STRESS 3.4b fails with `TelegramRenderer Message 0 caption length = 1036 (limit 1024)`

2. **Run the Jest Suite**:
   ```bash
   npx jest tests/unit/adversarial-empirical-m3.spec.ts --config ./tests/jest.json
   ```
   *Expected Output*:
   - Test 3.10 fails: `Received: 1038, Expected: <= 1024`
   - Test 3.11 fails: `Received: 4111, Expected: <= 4096`

3. **Invalidation Condition**:
   Once `HtmlSplitter` is modified with tag-aware length budgeting, running both commands must report 0 failures and exit code 0.
