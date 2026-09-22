# Milestone 5 Remediation Changes

**Author**: `m5_worker_2` (teamwork_preview_worker)  
**Date**: 2026-09-22  
**Mission**: Remediate defects uncovered by Challenger 1 in Milestone 5

---

## 1. Summary of Changes

### 1.1 Fix Draft Deletion Confirmation Version (`draft-manager.handler.ts` & `telegram-bot.service.ts`)
- **Problem**: In `draft-manager.handler.ts:108`, `expectedVersion` was hardcoded to `:1` in `draft:cdel:${postId}:1`. Any draft that had undergone step-by-step autosave (advancing version to $\ge 2$) triggered a `PostConflictException` upon confirmation from the `/drafts` list, making deletion impossible.
- **Remediation**:
  1. `src/modules/telegram/handlers/draft-manager.handler.ts`:
     - Line 56: Encoded draft version in the delete callback: `draft:del:${d.id}:${d.version}`.
     - Updated `handlePromptDeleteDraft(ctx, postId, versionStr?)`:
       - Accepts optional `versionStr`. If present, parses it to integer.
       - If not present or invalid, queries `postsRepository.findById(postId)` or `draftManagerService.getDraft(postId)` to obtain the dynamic post version.
       - Replaced hardcoded `:1` with dynamic version: `draft:cdel:${postId}:${version}`.
       - Zero occurrences of `:1` remain in `draft-manager.handler.ts`.
     - Injected `@Optional() private readonly postsRepository?: PostsRepository` into `DraftManagerHandler`.
  2. `src/modules/telegram/services/draft-manager.service.ts`:
     - Added `getDraft(postId: string): Promise<Post | null>` method to retrieve the post by ID.
  3. `src/modules/telegram/telegram-bot.service.ts`:
     - Updated regex to match `draft:del`: `/^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$/`.
     - Extracted `versionStr` and passed it to `draftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr)`.
     - Kept fallback prefix splitting for general draft deletion callbacks.

### 1.2 Callback Data Safety in Granular Field Editing (`post-actions.handler.ts` & `telegram-bot.service.ts`)
- **Problem**: Inline callback data `draft:edit:${post.id}:${field.key}` had a 48-byte prefix (`draft:edit:` [11] + UUID [36] + `:` [1]), leaving only 16 bytes for field keys before breaching Telegram's 64-byte callback limit.
- **Remediation**:
  1. `src/modules/telegram/handlers/post-actions.handler.ts`:
     - Line 209: Shortened callback prefix from `draft:edit:${post.id}:${field.key}` to `d:e:${post.id}:${field.key}`.
     - Reduces prefix length to 41 bytes (`d:e:` [4] + UUID [36] + `:` [1]), leaving 23 bytes for field keys.
  2. `src/modules/telegram/telegram-bot.service.ts`:
     - Updated callback query router: `if (data.startsWith('d:e:') || data.startsWith('draft:edit:'))`.
     - Preserves full backward compatibility while supporting the shortened prefix.

### 1.3 Test Enhancements
- `tests/unit/draft-manager.service.spec.ts`:
  - Added test for `DraftManagerService.getDraft(postId)`.
  - Added test suite for `DraftManagerHandler`:
    - `handleListDrafts includes draft version in draft:del callback data`.
    - `handlePromptDeleteDraft uses versionStr if provided`.
    - `handlePromptDeleteDraft queries post version if versionStr not provided`.
    - `handleConfirmDeleteDraft parses dynamic version and calls deleteDraft`.
- `tests/unit/post-controls.keyboard.spec.ts`:
  - Added test verifying `d:e:` callback data length remains strictly $\le 64$ bytes across standard and extended field keys.

---

## 2. Verification Results

| Suite | Command | Expected | Actual | Result |
|---|---|---|---|:---:|
| Adversarial Suite (M5) | `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json` | 24 passed | 24 passed | **PASS** |
| Preview Adversarial Suite (M5) | `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json` | 19 passed | 19 passed | **PASS** |
| Full Unit Suites | `npm test` | 32 suites passed, 501 tests passed | 32 suites passed, 501 tests passed | **PASS** |
| Full E2E Suites | `npm run test:e2e` | 4 tiers passed, 34 tests passed | 4 tiers passed, 34 tests passed | **PASS** |
| TypeScript Build | `npm run build` | Clean exit 0 | Clean exit 0 | **PASS** |
| Invalidation Check | `git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts` | 0 matches | 0 matches | **PASS** |
