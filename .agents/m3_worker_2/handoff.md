# Milestone 3 Remediation Handoff Report

- **Agent**: `m3_worker_2` (teamwork_preview_worker)
- **Role**: implementer, qa, specialist
- **Date**: 2026-09-21
- **Target**: Milestone 3 HTML Splitter Boundary Length Budgeting Defect Remediation

---

## 1. Observation

1. **Defect Confirmation**:
   - Initial run of `npx ts-node tests/empirical-m3-verification.ts` resulted in:
     ```text
     STRESS 3.3: Caption split limit: 1024. Part1 length: 1036. Over limit by: 12
     STRESS 3.4: Message split limit: 4096. Part1 length: 4123. Over limit by: 27
     STRESS 3.4b: TelegramRenderer message 0 caption length: 1036. Over limit by: 12

     Total tests: 47 | Passed: 44 | Failed: 3
     ```
   - Initial run of `npx jest tests/unit/adversarial-empirical-m3.spec.ts --config ./tests/jest.json` resulted in:
     ```text
     ● 3.10 should check part1 length with deep open tags near caption limit (1024)
       Expected: <= 1024, Received: 1038
     ● 3.11 should check part1 length with deep open tags near message limit (4096)
       Expected: <= 4096, Received: 4111
     ```

2. **Root Cause**:
   - In `src/modules/rendering/html-splitter.ts` lines 27–38, `splitHtml` called `findOptimalCutPoint(html, maxLength)`. The cut point was searched solely against `maxLength`.
   - When active tags were identified via `getActiveOpenTags`, `closingSuffix` (length 16–33 chars) was appended:
     `const part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix;`
   - Because `closingSuffix.length` was not reserved in the search budget, `part1.length` exceeded `maxLength` (`cutPoint + closingSuffix.length > maxLength`).
   - In `TelegramRenderer.render()`, `messages[0].caption` was assigned `part1` (1036 chars > 1024 limit), which would cause Telegram Bot API to reject media with `HTTP 400 Bad Request: message caption is too long`.

3. **Remediation Applied**:
   - In `src/modules/rendering/html-splitter.ts`:
     - Implemented iterative tag-aware budgeting in `splitHtml`: when `html.slice(0, cutPoint).trimEnd().length + closingSuffix.length > maxLength`, `safeLimit` is reduced to `maxLength - closingSuffix.length`, and cut point and active tags are re-evaluated until `part1.length <= maxLength`.
     - Added `isInsideTagOrEntity` helper to prevent `findOptimalCutPoint` candidates from landing inside `<tag ...>` or `&entity;`.
     - Added hard ceiling fallback for extreme nesting/pathological cases.
     - Updated `tagRegex` to `/<\/?([a-zA-Z0-9\-]+)(?:\s+[^>]*?)?>/g` to support tags with hyphens (`tg-spoiler`, `tg-emoji`).
   - In `tests/unit/adversarial-empirical-m3.spec.ts`:
     - Fixed Prisma mock type: `fileSize: BigInt(102400)`.

4. **Post-Remediation Verification**:
   - `npx ts-node tests/empirical-m3-verification.ts`:
     ```text
     STRESS 3.3: Caption split limit: 1024. Part1 length: 1018. Over limit by: -6
     STRESS 3.4: Message split limit: 4096. Part1 length: 4091. Over limit by: -5
     STRESS 3.4b: TelegramRenderer message 0 caption length: 1018. Over limit by: -6

     Total tests: 47 | Passed: 47 | Failed: 0
     VERDICT: APPROVE
     ```
   - `npx jest tests/unit/adversarial-empirical-m3.spec.ts --config ./tests/jest.json`:
     `Tests: 39 passed, 39 total (100%)`
   - `npm run build`:
     `nest build` exited with code 0.
   - `npm test`:
     `Test Suites: 15 passed, 15 total; Tests: 299 passed, 299 total (100%)`
   - `npm run test:e2e`:
     `34 passed, 0 failed across 22 suites (100%)`

---

## 2. Logic Chain

1. Telegram Bot API enforces hard ceiling constraints on message payloads: `MAX_CAPTION_LENGTH = 1024` for media captions and `MAX_MESSAGE_LENGTH = 4096` for text messages.
2. Because HTML tags must be properly closed before message boundaries and reopened after them, the total length of any generated chunk $L_{chunk}$ equals $L_{text} + L_{closingTags}$.
3. If the splitting algorithm finds a cut point $C \le \text{maxLength}$ without budgeting for $L_{closingTags}$, then $L_{chunk} = C + L_{closingTags} > \text{maxLength}$.
4. By dynamically subtracting $L_{closingTags}$ from the maximum allowed cut point search budget (`safeLimit = maxLength - closingSuffix.length`) and iteratively refining the cut point until $C + L_{closingTags} \le \text{maxLength}$, all chunks strictly satisfy Telegram API constraints under any nesting depth.
5. In addition, checking that candidate break points do not fall inside tags or entities guarantees that tags and entities are never severed across chunks.
6. As a direct result, `TelegramRenderer` renders captions and message chunks that strictly respect 1024 and 4096 characters, guaranteeing publication jobs will not be rejected by Telegram API due to boundary overflow.

---

## 3. Caveats

- **No live Telegram network calls**: All tests were executed against deterministic empirical and mocked harnesses simulating Telegram Bot API payload limits (`TELEGRAM_LIMITS`). Live network calls to Telegram servers are scheduled for Milestone 4 (Publishing Engine).
- **Whitespace handling**: Trailing whitespace before the cut point is trimmed (`.trimEnd()`) prior to appending the closing tag suffix, ensuring the character budget is not wasted on invisible spaces.

---

## 4. Conclusion

- The boundary length budgeting defect in `HtmlSplitter` and `TelegramRenderer` has been fully remediated.
- All 47 empirical stress tests in `tests/empirical-m3-verification.ts` pass (specifically STRESS 3.3, 3.4, and 3.4b).
- All 39 unit tests in `tests/unit/adversarial-empirical-m3.spec.ts` pass.
- Project builds cleanly (`npm run build` exit code 0).
- All 15 unit test suites (299 tests) pass 100%.
- All 22 E2E test suites (34 tests) pass 100%.
- Milestone 3 is verified and ready for gate re-evaluation.

---

## 5. Verification Method

To independently verify:
```bash
# 1. Run empirical verification suite (47 tests)
npx ts-node tests/empirical-m3-verification.ts

# 2. Run adversarial jest unit suite (39 tests)
npx jest tests/unit/adversarial-empirical-m3.spec.ts --config ./tests/jest.json

# 3. Verify clean TypeScript compilation
npm run build

# 4. Run all unit test suites (299 tests)
npm test

# 5. Run all E2E test suites (34 tests)
npm run test:e2e
```
Invalidation condition: Any test failure, caption > 1024, or text > 4096.
