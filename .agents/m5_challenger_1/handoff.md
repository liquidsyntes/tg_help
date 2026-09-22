# Milestone 5 Handoff Report — Adversarial Empirical Challenge

**Agent**: `m5_challenger_1` (teamwork_preview_challenger)  
**Roles**: critic, specialist  
**Milestone**: Milestone 5 — Telegram Transport & Interactive Wizard UI  
**Verdict**: **REQUEST_CHANGES**  
**Date**: 2026-09-21  

---

## 1. Observation

### 1.1 Baseline Verification Commands & Results
1. `npm run build`:
   ```text
   > tg-content-publisher@1.0.0 build
   > nest build
   ```
   Exited with code 0 (clean build).

2. `npm run test:e2e`:
   ```text
   ▶ Tier 1: Feature Coverage (Isolated Verification) (30.9351ms)
   ▶ Tier 2: Boundary & Corner Cases (Invariants & Limits) (13.8861ms)
   ▶ Tier 3: Cross-Feature Combinations & Complex Lifecycles (10.7751ms)
   ▶ Tier 4: Real-World Application Scenarios (End-to-End Lifecycles) (13.5774ms)
   ℹ tests 34, suites 22, pass 34, fail 0
   ```
   Exited with code 0.

3. Empirical Adversarial Suite `tests/unit/adversarial-empirical-m5.spec.ts`:
   Command: `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json`
   ```text
   PASS tests/unit/adversarial-empirical-m5.spec.ts
   24 passed, 24 total, Time: 3.776 s
   ```

### 1.2 Verbatim Code Observation: Hardcoded Version in Draft Deletion
In `src/modules/telegram/handlers/draft-manager.handler.ts`:
- Line 56:
  ```ts
  kb.text(`🗑 Удалить`, `draft:del:${d.id}`).row();
  ```
  *(Note: `d.version` is available on line 52 but omitted in callback data).*

- Lines 107–109:
  ```ts
  const kb = new InlineKeyboard()
    .text('🗑 Да, удалить', `draft:cdel:${postId}:1`)
    .text('🔙 Отмена', `draft:res:${postId}`);
  ```
  *(Verbatim: `draft:cdel:${postId}:1` hardcodes `:1` as expected version).*

- Lines 124–136:
  ```ts
  async handleConfirmDeleteDraft(
    ctx: BotContext,
    postId: string,
    versionStr: string,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const version = parseInt(versionStr, 10) || 1;
    await ctx.answerCallbackQuery({ text: 'Черновик удален' });

    await this.draftManagerService.deleteDraft(user.id, postId, version);
  ```

- In `tests/unit/adversarial-empirical-m5.spec.ts` (Test 5.1):
  ```ts
  await expect(
    handler.handleConfirmDeleteDraft(ctx, postV3.id, '1'),
  ).rejects.toThrow(PostConflictException);
  ```
  Verbatim result: Confirmed throwing `PostConflictException` on any autosaved draft (`version >= 2`).

### 1.3 Verbatim Code Observation: Callback Prefix in Granular Field Editing
In `src/modules/telegram/handlers/post-actions.handler.ts`:
- Line 209:
  ```ts
  kb.text(`✏️ ${field.label}`, `draft:edit:${post.id}:${field.key}`).row();
  ```
  - Byte length calculation: `'draft:edit:'.length + 36 (UUID) + 1 + fieldKey.length = 48 + fieldKey.length`.
  - At `fieldKey.length >= 17`, total bytes $\ge 65 > 64$ (exceeding Telegram's limit).

---

## 2. Logic Chain

1. **Step-by-step Autosave Invariant (Obs. 1.1, 1.2; AGENTS.md §11, §12)**:
   - When a draft is initialized, `version = 1`.
   - As soon as the author enters Step 3 (e.g. Title), `PostsService.autosaveStep` updates `posts` and increments `version` to `2`. Entering Body increments `version` to `3`.
2. **Draft Listing (Obs. 1.2; tasks.md §9, §11)**:
   - When the author views `/drafts`, `DraftManagerHandler.handleListDrafts` lists all drafts.
   - For each draft, it renders a "🗑 Удалить" button with callback `draft:del:${d.id}`.
3. **Confirmation Generation Defect (Obs. 1.2)**:
   - When clicked, `handlePromptDeleteDraft` generates confirmation buttons where the delete confirmation callback is explicitly hardcoded as `draft:cdel:${postId}:1`.
4. **Execution Conflict (Obs. 1.2; AGENTS.md §13)**:
   - When the user confirms deletion, `handleConfirmDeleteDraft` extracts version `1` and invokes `PostsService.softDeletePost(postId, 1, user.id)`.
   - `PostsService.softDeletePost` executes an OCC update: `WHERE id = :id AND version = :expectedVersion`.
   - Because the actual version in PostgreSQL is $\ge 2$, zero rows match.
   - `PostsService.softDeletePost` throws `PostConflictException`.
5. **User Experience Impact (Obs. 1.2)**:
   - The centralized `TelegramExceptionFilter` catches the exception and informs the user: *"⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие."*
   - The post is **never deleted**. It is permanently impossible to delete any draft from the `/drafts` menu once any wizard field has been autosaved.
6. **Conclusion**:
   - Because this defect breaks draft soft-deletion (F-15, tasks.md §9, AGENTS.md §54), the work product cannot be approved in its current state. Verdict is **REQUEST_CHANGES**.

---

## 3. Caveats

1. **Companion Control Card Deletion**:
   - Deletion of drafts via the Companion Control Card (`PostControlsKeyboardBuilder.buildAuthorControls` $\to$ `p:del:${post.id}:${post.version}` $\to$ `p:del_ok:${postId}:${expectedVersion}`) correctly passes `post.version` and succeeds. The bug specifically affects deletion initiated from the `/drafts` menu list.
2. **Template Field Key Lengths**:
   - Current seed templates in `prisma/seed.ts` have field keys $\le 11$ characters (longest: `description`), so existing standard templates will not trigger the 64-byte overflow in `draft:edit`. However, custom templates created in future milestones with keys $> 16$ characters will crash Telegram API calls unless shortened or validated.

---

## 4. Conclusion

**Verdict**: **REQUEST_CHANGES**

Milestone 5 demonstrates strong engineering across the 4 core dimensions:
- **Auth Middleware**: Correctly rejects unregistered users with tasks.md §7 Russian prompt and Telegram ID, blocks deactivated users, handles non-user updates safely, and respects role boundaries.
- **Autosave & Concurrency**: Step-by-step autosave immediately updates PostgreSQL; drafts are recoverable solely from PostgreSQL after complete session loss.
- **Callback Codec**: All 19 actions, UUIDs, and version permutations strictly obey Telegram's 64-byte limit (max 58 bytes).
- **Stale Button Defense**: Version mismatches across submit, publish, and approve are rejected with Russian alert toasts and zero DB mutation.

However, Milestone 5 contains a blocking defect in `draft-manager.handler.ts:108` where `expectedVersion` is hardcoded to `1`, preventing authors from deleting any autosaved draft from the `/drafts` list.

**Action Required from Worker (`m5_worker_1`)**:
1. Update `draft-manager.handler.ts` line 56 to encode the current post version: `draft:del:${d.id}:${d.version}`.
2. Update `draft-manager.handler.ts` line 99/108 to pass the version to `draft:cdel:${postId}:${version}` (or fetch latest version dynamically).
3. Update `telegram-bot.service.ts` line 129 to parse the version parameter if present.

---

## 5. Verification Method

1. **Verify Adversarial Test Suite**:
   ```bash
   npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json
   ```
   Confirms 24 tests pass, including the bug reproduction test (Test 5.1).

2. **Verify Full Unit & E2E Suites**:
   ```bash
   npm run build
   npm run test:e2e
   ```

3. **Verify Bug Invalidation Condition**:
   - In `src/modules/telegram/handlers/draft-manager.handler.ts`, search for `:1`:
     ```bash
     git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
     ```
   - Must return zero matches after the worker applies the fix.
