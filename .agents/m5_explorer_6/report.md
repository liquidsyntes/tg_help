# Milestone 5 Remediation — Test Regression & Verification Strategy Report

**Explorer**: `m5_explorer_6` (teamwork_preview_explorer)  
**Date**: 2026-09-22  
**Target Files**:
- `src/modules/telegram/handlers/draft-manager.handler.ts`
- `src/modules/telegram/services/draft-manager.service.ts`
- `tests/unit/draft-manager.service.spec.ts`
- `tests/unit/adversarial-empirical-m5.spec.ts`
- `tests/unit/adversarial-empirical-m5-preview.spec.ts`

---

## 1. Executive Summary

Forensic Auditor `m5_auditor_2` rejected the initial M5 remediation due to an integrity violation:
1. `src/modules/telegram/handlers/draft-manager.handler.ts` lines 118–119 introduced two explicit `as any` type bypasses (`(this.draftManagerService as any).getDraft`), violating TypeScript strict typing rules (`PROJECT.md`, `AGENTS.md` § 6).
2. `DraftManagerHandler` injected `@Optional() private readonly postsRepository?: PostsRepository`, directly querying the database repository layer from a Telegram transport handler and violating architectural layer boundaries (`AGENTS.md` § 3, § 5).

This investigation conducted a comprehensive analysis of the unit and adversarial test suites to formulate the exact test adjustments and verification strategy for the remediation worker.

**Key Findings**:
1. `DraftManagerService` already exposes `async getDraft(postId: string): Promise<Post | null>` (lines 227–229 of `src/modules/telegram/services/draft-manager.service.ts`), which is properly tested in `tests/unit/draft-manager.service.spec.ts` (lines 179–183).
2. Removing `postsRepository` from `DraftManagerHandler` requires clean updates in `tests/unit/draft-manager.service.spec.ts`: eliminating the unused `mockPostsRepo`, removing `mockPostsRepo` from `new DraftManagerHandler(...)`, and asserting that `mockDraftManagerService.getDraft` is directly invoked.
3. In `tests/unit/adversarial-empirical-m5.spec.ts` line 856, `DraftManagerHandler` was **already** instantiated with only 2 arguments: `new DraftManagerHandler(mockDraftManagerService as any, {} as any)`. Removing `postsRepository` from `DraftManagerHandler` aligns the constructor signature perfectly with the adversarial test. All 24 tests in `adversarial-empirical-m5.spec.ts` and all 19 tests in `adversarial-empirical-m5-preview.spec.ts` remain 100% passing with zero modifications needed in adversarial suites.

---

## 2. Inspection of `tests/unit/draft-manager.service.spec.ts`

`tests/unit/draft-manager.service.spec.ts` contains two top-level test suites:

### 2.1 Suite 1: `DraftManagerService` (lines 13–184)
Tests the core domain application service with mocked `PostsService`, `PostsRepository`, `TemplatesService`, and `RedisService`.
- `should list drafts and posts needing revision for the author` (lines 120–125)
- `should resume draft at first missing required field when incomplete` (lines 127–141)
- `should show control card when resuming a draft where all required fields are filled` (lines 143–157)
- `should perform granular field editing under OCC` (lines 159–172)
- `should soft-delete draft with expected version` (lines 174–177)
- `should retrieve a draft by ID via getDraft` (lines 179–183):
  ```ts
  it('should retrieve a draft by ID via getDraft', async () => {
    const post = await service.getDraft('post-1');
    expect(postsRepository.findById).toHaveBeenCalledWith('post-1');
    expect(post?.id).toBe('post-1');
  });
  ```
This suite is fully operational and requires no modifications.

### 2.2 Suite 2: `DraftManagerHandler` (lines 186–288)
Currently sets up `DraftManagerHandler` with three mock dependencies:
```ts
describe('DraftManagerHandler', () => {
  let handler: DraftManagerHandler;
  let mockDraftManagerService: Partial<DraftManagerService>;
  let mockPreviewService: Partial<TelegramPreviewService>;
  let mockPostsRepo: Partial<PostsRepository>; // <-- OBSOLETE

  beforeEach(() => {
    mockDraftManagerService = {
      listDrafts: jest.fn().mockResolvedValue([ ... ]),
      getDraft: jest.fn().mockResolvedValue({
        id: 'draft-1',
        version: 3,
      } as any),
      deleteDraft: jest.fn().mockResolvedValue({} as any),
    };

    mockPreviewService = {
      sendPostPreview: jest.fn().mockResolvedValue(undefined),
    };

    mockPostsRepo = { // <-- OBSOLETE
      findById: jest.fn().mockResolvedValue({
        id: 'draft-1',
        version: 3,
      } as any),
    };

    handler = new DraftManagerHandler(
      mockDraftManagerService as DraftManagerService,
      mockPreviewService as TelegramPreviewService,
      mockPostsRepo as PostsRepository, // <-- OBSOLETE 3rd argument
    );
  });
```

**Observations**:
- `mockDraftManagerService` **already mocks `getDraft`**!
- However, because `mockPostsRepo` was passed as the 3rd argument, `handlePromptDeleteDraft` executed the `if (this.postsRepository)` branch and called `mockPostsRepo.findById(postId)` instead of `mockDraftManagerService.getDraft(postId)`.
- When `postsRepository` is removed from `DraftManagerHandler`:
  1. `let mockPostsRepo: Partial<PostsRepository>;` becomes completely dead code.
  2. The `beforeEach` initialization of `mockPostsRepo` is unneeded and should be deleted.
  3. `handler = new DraftManagerHandler(...)` must take only 2 parameters.
  4. In test `handlePromptDeleteDraft queries post version if versionStr not provided` (line 262), `mockDraftManagerService.getDraft` will now be called, and we can explicitly assert `expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1');`.
  5. An additional test case should be added to verify fallback to version 1 if `getDraft` returns `null`.

---

## 3. Impact on `tests/unit/adversarial-empirical-m5.spec.ts`

### 3.1 Constructor Usage in Adversarial Suite
Grep search across all files confirmed that `DraftManagerHandler` is instantiated in `adversarial-empirical-m5.spec.ts` at line 856:
```ts
// tests/unit/adversarial-empirical-m5.spec.ts:856-859
const handler = new DraftManagerHandler(
  mockDraftManagerService as any,
  {} as any,
);
```
Notice that:
- It was already called with **only two arguments**!
- When `postsRepository` was an `@Optional()` parameter, this call was syntactically valid in TypeScript.
- When `postsRepository` is removed entirely from `DraftManagerHandler`:
  ```ts
  constructor(
    private readonly draftManagerService: DraftManagerService,
    private readonly previewService: TelegramPreviewService,
  ) {}
  ```
  The call `new DraftManagerHandler(mockDraftManagerService as any, {} as any)` continues to match the constructor signature exactly!
- Test 5.1 in `adversarial-empirical-m5.spec.ts` executes `handler.handleConfirmDeleteDraft(ctx, postV3.id, '1')`, testing that confirming deletion with stale version 1 on a version 3 post throws `PostConflictException`.
- It does NOT invoke `handlePromptDeleteDraft`.
- Empirical test execution:
  ```bash
  npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json
  ```
  **Result**: 24/24 tests passed (exit code 0).
- Empirical test execution of preview suite:
  ```bash
  npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json
  ```
  **Result**: 19/19 tests passed (exit code 0).

**Conclusion**: Removing `postsRepository` from `DraftManagerHandler` causes **zero regressions** in the adversarial test suites.

---

## 4. Exact Plan for Remediation Worker

### 4.1 Production Code: `src/modules/telegram/handlers/draft-manager.handler.ts`

1. **Clean Imports**:
   - Line 7: Change `import { Injectable, Optional } from '@nestjs/common';` to `import { Injectable } from '@nestjs/common';`
   - Line 12: Remove `import { PostsRepository } from '../../posts/posts.repository';`

2. **Constructor Signature**:
   Replace lines 20–24:
   ```ts
   // BEFORE:
   constructor(
     private readonly draftManagerService: DraftManagerService,
     private readonly previewService: TelegramPreviewService,
     @Optional() private readonly postsRepository?: PostsRepository,
   ) {}

   // AFTER:
   constructor(
     private readonly draftManagerService: DraftManagerService,
     private readonly previewService: TelegramPreviewService,
   ) {}
   ```

3. **Eliminate `as any` and Direct Repository Calls**:
   Replace lines 113–123:
   ```ts
   // BEFORE:
   let version = versionStr ? parseInt(versionStr, 10) : NaN;
   if (isNaN(version)) {
     let post: { version: number } | null = null;
     if (this.postsRepository) {
       post = await this.postsRepository.findById(postId);
     } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
       post = await (this.draftManagerService as any).getDraft(postId);
     }
     version = post?.version ?? 1;
   }

   // AFTER:
   let version = versionStr ? parseInt(versionStr, 10) : NaN;
   if (isNaN(version)) {
     const post = await this.draftManagerService.getDraft(postId);
     version = post?.version ?? 1;
   }
   ```

### 4.2 Unit Tests: `tests/unit/draft-manager.service.spec.ts`

1. **Remove `mockPostsRepo` variable and initialization**:
   In `describe('DraftManagerHandler', () => { ... })`:
   - Delete `let mockPostsRepo: Partial<PostsRepository>;` (line 190)
   - Delete `mockPostsRepo = { ... };` (lines 216–221)
   - Change `new DraftManagerHandler` call (lines 223–227) to:
     ```ts
     handler = new DraftManagerHandler(
       mockDraftManagerService as DraftManagerService,
       mockPreviewService as TelegramPreviewService,
     );
     ```

2. **Strengthen Test Assertions**:
   In `it('handlePromptDeleteDraft queries post version if versionStr not provided')`:
   Add assertion:
   ```ts
   expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1');
   ```

3. **Add Fallback Test**:
   ```ts
   it('handlePromptDeleteDraft falls back to version 1 if draft is not found in service', async () => {
     (mockDraftManagerService.getDraft as jest.Mock).mockResolvedValueOnce(null);
     const ctx = {
       authUser: { id: 'user-1' },
       answerCallbackQuery: jest.fn().mockResolvedValue(true),
       reply: jest.fn().mockResolvedValue({}),
     } as unknown as BotContext;

     await handler.handlePromptDeleteDraft(ctx, 'draft-unknown');

     expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-unknown');
     const call = (ctx.reply as jest.Mock).mock.calls[0];
     const buttons = call[1]?.reply_markup.inline_keyboard.flat();
     const confirmBtn = buttons.find((b: any) => b.text.includes('Да, удалить'));
     expect(confirmBtn.callback_data).toBe('draft:cdel:draft-unknown:1');
   });
   ```

---

## 5. Verification Checklist for Clean Auditor Verdict

| Check | Target / Criterion | Verification Command | Required Outcome |
|---|---|---|:---:|
| 1. Authenticity & Zero `any` | Zero `as any` in `src/` | `git grep "as any" src/` | 0 matches (exit code 1) |
| 2. Zero `any` in Handler | Zero `any` in `draft-manager.handler.ts` | `git grep "any" src/modules/telegram/handlers/draft-manager.handler.ts` | 0 matches (exit code 1) |
| 3. Layer Separation | No `PostsRepository` in `DraftManagerHandler` | `git grep "PostsRepository" src/modules/telegram/handlers/draft-manager.handler.ts` | 0 matches (exit code 1) |
| 4. Bug Invalidation Check | No hardcoded `:1` in `DraftManagerHandler` | `git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts` | 0 matches (exit code 1) |
| 5. Callback Limit Safety | Granular field editing uses `d:e:` prefix $\le 64$ bytes | `npx jest tests/unit/post-controls.keyboard.spec.ts --config ./tests/jest.json` | 100% pass |
| 6. Handler Unit Suite | `draft-manager.service.spec.ts` passes | `npx jest tests/unit/draft-manager.service.spec.ts --config ./tests/jest.json` | 100% pass |
| 7. Adversarial M5 Suite | All 24 tests pass | `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json` | 24/24 pass |
| 8. Adversarial Preview Suite | All 19 tests pass | `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json` | 19/19 pass |
| 9. TypeScript Compilation | Clean build | `npm run build` | Exit code 0 |
| 10. Full Regression | All 32 unit suites & 4 E2E tiers pass | `npm test && npm run test:e2e` | 100% pass |
