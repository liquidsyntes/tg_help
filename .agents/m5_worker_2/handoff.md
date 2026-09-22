# Milestone 5 Remediation Handoff Report

**Agent**: `m5_worker_2` (teamwork_preview_worker)  
**Roles**: implementer, qa, specialist  
**Milestone**: Milestone 5 Remediation — Telegram Transport & Interactive Wizard UI  
**Verdict**: **REMEDIATION_COMPLETE**  
**Date**: 2026-09-22  

---

## 1. Observation

### 1.1 Verbatim Code Observations Prior to Fix
- In `src/modules/telegram/handlers/draft-manager.handler.ts`:
  - Line 56:
    ```ts
    kb.text(`🗑 Удалить`, `draft:del:${d.id}`).row();
    ```
    (Did not encode draft version).
  - Line 108:
    ```ts
    const kb = new InlineKeyboard()
      .text('🗑 Да, удалить', `draft:cdel:${postId}:1`)
      .text('🔙 Отмена', `draft:res:${postId}`);
    ```
    Verbatim: `:1` hardcoded as the expected version.
- In `src/modules/telegram/telegram-bot.service.ts`:
  - Line 129:
    ```ts
    if (data.startsWith('draft:del:')) {
      const postId = data.replace('draft:del:', '');
      return this.draftManagerHandler.handlePromptDeleteDraft(ctx, postId);
    }
    ```
    (Did not extract or pass version parameter).
- In `src/modules/telegram/handlers/post-actions.handler.ts`:
  - Line 209:
    ```ts
    kb.text(`✏️ ${field.label}`, `draft:edit:${post.id}:${field.key}`).row();
    ```
    (Prefix `draft:edit:` plus 36-char UUID and separators used 48 bytes, leaving only 16 bytes for field keys before exceeding Telegram's 64-byte callback limit).

### 1.2 Verification Commands & Results After Fix
- Adversarial Suite:
  ```bash
  npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json
  ```
  Result:
  ```text
  PASS tests/unit/adversarial-empirical-m5.spec.ts
  Test Suites: 1 passed, 1 total
  Tests:       24 passed, 24 total
  ```
- Preview Adversarial Suite:
  ```bash
  npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json
  ```
  Result:
  ```text
  PASS tests/unit/adversarial-empirical-m5-preview.spec.ts
  Test Suites: 1 passed, 1 total
  Tests:       19 passed, 19 total
  ```
- Full Unit Test Suite:
  ```bash
  npm test
  ```
  Result:
  ```text
  Test Suites: 32 passed, 32 total
  Tests:       501 passed, 501 total
  Snapshots:   0 total
  Time:        12.898 s
  Ran all test suites.
  ```
- Full E2E Test Suite:
  ```bash
  npm run test:e2e
  ```
  Result:
  ```text
  ℹ tests 34
  ℹ suites 22
  ℹ pass 34
  ℹ fail 0
  ```
- TypeScript Nest Build:
  ```bash
  npm run build
  ```
  Result: Exited with code 0 (clean build).
- Bug Invalidation Condition:
  ```bash
  git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
  ```
  Result: 0 matches found (clean exit code 1).

---

## 2. Logic Chain

1. **Defect Root Cause (Obs. 1.1)**:
   - When authors create drafts and enter fields, step-by-step autosave increments `post.version` in PostgreSQL to $\ge 2$ (AGENTS.md §11, §12).
   - `draft-manager.handler.ts:108` previously rendered `draft:cdel:${postId}:1`, forcing expected version to `1`.
   - When confirmed, `PostsService.softDeletePost(postId, 1, actorId)` executed OCC check `WHERE id = :id AND version = 1`.
   - Because current version was $\ge 2$, zero rows updated, throwing `PostConflictException` and permanently blocking draft deletion.
2. **Remediation Implementation (Obs. 1.1, 1.2)**:
   - In `draft-manager.handler.ts:58`, draft listing encodes current draft version into `draft:del:${d.id}:${d.version}`.
   - In `telegram-bot.service.ts`, regex `/^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$/` extracts the version parameter and forwards it to `handlePromptDeleteDraft(ctx, postId, versionStr)`.
   - In `draft-manager.handler.ts:101-125`, `handlePromptDeleteDraft` dynamically accepts `versionStr`. If omitted, it queries `postsRepository.findById(postId)` or `draftManagerService.getDraft(postId)` to obtain the live DB version.
   - Confirmation button is rendered dynamically as `draft:cdel:${postId}:${version}` (all `:1` occurrences eliminated).
   - `handleConfirmDeleteDraft` parses dynamic version and invokes `draftManagerService.deleteDraft(user.id, postId, version)`. OCC succeeds matching actual DB version.
3. **Callback Length Budget Enforcement (Obs. 1.1, 1.2)**:
   - In `post-actions.handler.ts:209`, callback prefix was shortened from `draft:edit:` to `d:e:`.
   - Combined length with 36-char UUID is 41 bytes, guaranteeing safe headroom of 23 characters for field keys before reaching Telegram's 64-byte threshold.
   - `telegram-bot.service.ts` routes both `d:e:` and `draft:edit:` for seamless backwards compatibility.
4. **Verification Validation (Obs. 1.2)**:
   - All 24 adversarial tests in `adversarial-empirical-m5.spec.ts` pass, including test 5.1 confirming OCC behavior.
   - All 19 tests in `adversarial-empirical-m5-preview.spec.ts` pass.
   - All 501 unit tests across 32 suites pass.
   - All 34 E2E tests pass.
   - `git grep ":1"` returns zero matches in `draft-manager.handler.ts`.

---

## 3. Caveats

- **Timezone Parsing**: Scheduling inputs continue to rely on channel timezone (default `Europe/Kyiv`) as established in M2/M4.
- **Visual Telegram UI**: Tested programmatically using grammY mock contexts and unit/E2E test runners. Telegram desktop/mobile GUI client rendering was not manually exercised in live channels.

---

## 4. Conclusion

**Verdict**: **REMEDIATION_COMPLETE**

The defects identified by Challenger 1 have been remediated:
1. Hardcoded `:1` in draft deletion confirmation has been replaced by dynamic OCC version resolution across `draft:del`, `handlePromptDeleteDraft`, `draft:cdel`, and `handleConfirmDeleteDraft`.
2. Granular field edit callbacks have been shortened to `d:e:${post.id}:${field.key}`, guaranteeing strict compliance with Telegram's 64-byte limit.
3. All unit, preview, E2E, and adversarial test suites pass with 100% success rate. Clean compilation with zero build errors.

---

## 5. Verification Method

To independently verify the remediation:

1. **Verify Invalidation Condition (Zero occurrences of hardcoded `:1`)**:
   ```bash
   git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
   ```
   *Expectation*: Zero matches.

2. **Verify Adversarial Suites**:
   ```bash
   npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json
   npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json
   ```
   *Expectation*: 24/24 passed and 19/19 passed.

3. **Verify Full Unit & E2E Suites**:
   ```bash
   npm test
   npm run test:e2e
   npm run build
   ```
   *Expectation*: All 32 suites (501 tests) pass, all 34 E2E tests pass, build exits with code 0.
