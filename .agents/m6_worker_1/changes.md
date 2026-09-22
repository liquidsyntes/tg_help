# Changes Report — m6_worker_1

**Agent**: `m6_worker_1` (`teamwork_preview_worker`)  
**Parent Task**: Milestone 6 Hardening — OCC Versioning Fix  
**Date**: 2026-09-22  

---

## 1. Summary of Changes

This task addressed the Optimistic Concurrency Control (OCC) defect identified by `m6_challenger_2` during white-box adversarial testing of the Telegram transport and draft editing track.

Prior to this fix, `DraftManagerService.submitEditedField()` fetched the post afresh from `postsRepository.findById()` and passed `post.version` (the fresh database version) to `postsService.autosaveStep()`, rather than the expected version stored in the author's session (`session.expectedVersion`) when the editing interaction began in `startEditField()`. If another user concurrently modified the post while the author was typing, the concurrent modification was silently overwritten without triggering OCC conflict detection.

The fix enforces `session.expectedVersion ?? post.version` in `submitEditedField()`, strictly complying with:
- `tasks.md` §12 ("WHERE id = :id AND version = :expected_version. Если версия была изменена другим пользователем, операция отклоняется.")
- `AGENTS.md` §13 ("Updates should verify the expected version... Do not silently overwrite another user's edits.")
- `AGENTS.md` §6 (Strict TypeScript mode, zero `any` or `as any` in `src/`).

---

## 2. Detailed File Modifications

### 2.1 `src/modules/telegram/services/draft-manager.service.ts`
- **Location**: Line 207
- **Change**: Replaced `post.version` with `session.expectedVersion ?? post.version` when invoking `this.postsService.autosaveStep()`.
- **Code Diff**:
  ```diff
      await this.postsService.autosaveStep(
        session.postId,
  -     post.version,
  +     session.expectedVersion ?? post.version,
        actorId,
        session.fieldKey,
        coerced,
      );
  ```
- **Type Safety**:
  - `session.expectedVersion` is typed as `number | undefined` via `WizardSessionData`.
  - `post.version` is typed as `number`.
  - The nullish coalescing expression `session.expectedVersion ?? post.version` evaluates to `number`.
  - Strictly matches `autosaveStep(postId: string, expectedVersion: number, ...)` parameter signature without type assertions or `any`.

---

### 2.2 `tests/unit/adversarial-empirical-m6-transport.spec.ts`
- **Location**: Lines 889–917 (Test case `3.6.2`)
- **Change**: Updated test expectation from observing the defect (where `autosaveStep` received `post.version` = 6) to asserting the verified OCC protection (where `autosaveStep` is invoked with `expectedVersion` = 5 and propagates `PostConflictException` on concurrent modification).
- **Code Diff**:
  ```diff
  -   it('3.6.2 empirically confirms DraftManagerService.submitEditedField queries current DB post and passes post.version instead of session.expectedVersion', async () => {
  +   it('3.6.2 should strictly pass session.expectedVersion to autosaveStep and reject with PostConflictException on concurrent edit', async () => {
        const actorId = 'author-101';
        postRecord.contentJson = { title: 'Старый заголовок', body: 'Текст' };
        postRecord.version = 5;

        // Author starts editing 'title' (session captures expectedVersion: 5)
        await draftManagerService.startEditField(actorId, postRecord.id, 'title');

        const rawSession = await mockRedisService.get(`wizard:session:${actorId}`);
        const session = JSON.parse(rawSession!);
        expect(session.expectedVersion).toBe(5);

        // Concurrent modification occurs in DB: post is now version 6
        postRecord.version = 6;

  -     // submitEditedField executes: it re-reads post from repository and passes post.version (6) to autosaveStep
  -     const result = await draftManagerService.submitEditedField(actorId, 'Новый заголовок');
  -
  -     // The call succeeds because submitEditedField fetched fresh version 6 rather than enforcing session.expectedVersion (5)
  -     expect(result.success).toBe(true);
  -     expect(mockPostsService.autosaveStep).toHaveBeenCalledWith(
  -       postRecord.id,
  -       6, // Received post.version (6) instead of session.expectedVersion (5)!
  -       actorId,
  -       'title',
  -       'Новый заголовок',
  -     );
  +     // submitEditedField executes: it passes session.expectedVersion (5) to autosaveStep,
  +     // which rejects with PostConflictException because DB version is 6
  +     await expect(
  +       draftManagerService.submitEditedField(actorId, 'Новый заголовок'),
  +     ).rejects.toThrow(PostConflictException);
  +
  +     expect(mockPostsService.autosaveStep).toHaveBeenCalledWith(
  +       postRecord.id,
  +       5, // Correctly passed session.expectedVersion (5) instead of post.version (6)!
  +       actorId,
  +       'title',
  +       'Новый заголовок',
  +     );
      });
  ```

---

## 3. Verification Commands & Results

1. **Target Adversarial Suite**:
   ```pwsh
   npx jest tests/unit/adversarial-empirical-m6-transport.spec.ts --config ./tests/jest.json
   ```
   - **Result**: 1 passed, 1 total (35 tests passed, 0 failed, 5.012s).

2. **Full Unit Test Suite**:
   ```pwsh
   npm test
   ```
   - **Result**: 34 passed, 34 total test suites; 559 passed, 559 total tests (13.909s).

3. **E2E Test Suite**:
   ```pwsh
   npm run test:e2e
   ```
   - **Result**: 34 passed, 0 failed across Tiers 1–4 (248.8ms).

4. **NestJS Production Build**:
   ```pwsh
   npm run build
   ```
   - **Result**: Exit code 0, 0 TypeScript errors.

5. **Strict TypeScript Typecheck on Source**:
   ```pwsh
   npx tsc --noEmit -p tsconfig.build.json
   ```
   - **Result**: Exit code 0, 0 diagnostic issues.
