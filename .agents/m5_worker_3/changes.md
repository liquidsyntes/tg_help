# Changes: Milestone 5 Architectural & Integrity Remediation

**Worker**: `m5_worker_3`  
**Date**: 2026-09-22  
**Mission**: Remediate Forensic Auditor (`m5_auditor_2`) Integrity Violations and achieve 100% compliance with AGENTS.md §3, §5, §6.

---

## 1. Summary of Modifications

### 1.1 `src/modules/telegram/handlers/draft-manager.handler.ts`
- **Removed Repository Injection**: Removed `PostsRepository` import and `@Optional() private readonly postsRepository?: PostsRepository` from constructor.
- **Removed Type Bypasses**: Removed two explicit `as any` casts (`(this.draftManagerService as any).getDraft`).
- **Clean Service Call**: In `handlePromptDeleteDraft`, resolved dynamic version directly via strongly typed `await this.draftManagerService.getDraft(postId)`:
  ```ts
  let version = versionStr ? parseInt(versionStr, 10) : NaN;
  if (isNaN(version)) {
    const post = await this.draftManagerService.getDraft(postId);
    version = post?.version ?? 1;
  }
  ```
- **Result**: Exactly 0 `any` / `as any` occurrences in file, 0 repository dependencies in handler.

### 1.2 `src/modules/telegram/services/review-queue.service.ts`
- **Exposed Public Method**: Exposed `getPost(postId: string): Promise<Post | null>`:
  ```ts
  /**
   * Retrieves a post by ID for review inspection.
   */
  async getPost(postId: string): Promise<Post | null> {
    return this.postsRepository.findById(postId);
  }
  ```
- **Import**: Added `Post` to `@prisma/client` imports.

### 1.3 `src/modules/telegram/handlers/review-queue.handler.ts`
- **Removed Repository Injection**: Removed `PostsRepository` from imports and constructor. Constructor now accepts 4 mandatory dependencies (`reviewQueueService`, `previewService`, `postWorkflow`, `redis`) and optional `logger`.
- **Delegated Post Retrieval**: Replaced all direct `this.postsRepository.findById` invocations with `this.reviewQueueService.getPost`:
  - `handleApprove`: lines 83 and 128
  - `handleRequestRevisionPrompt`: line 158
  - `handleConfirmReject`: line 246
- **Result**: Exactly 0 repository dependencies in handler.

### 1.4 `src/modules/posts/posts.service.ts`
- **Added Public Service Method**:
  ```ts
  /**
   * Retrieves a post by ID with all relations, or null if not found.
   */
  async getPostWithRelations(id: string, includeDeleted = false): Promise<Post | null> {
    return this.postsRepository.findById(id, includeDeleted);
  }
  ```
- Preserves clean unidirectional dependency (`posts.service` does not import from transport `telegram` module).

### 1.5 `src/modules/telegram/handlers/post-actions.handler.ts`
- **Removed Repository Injection**: Removed `PostsRepository` from imports and constructor. Constructor now accepts 8 mandatory dependencies and optional `logger`.
- **Delegated Post Retrieval**: Replaced all 12 direct `this.postsRepository.findById` invocations with `this.postsService.getPostWithRelations`.
- **Result**: Exactly 0 repository dependencies in handler.

### 1.6 `tests/unit/draft-manager.service.spec.ts`
- Removed unused `mockPostsRepo` declaration and initialization from `DraftManagerHandler` test suite.
- Instantiated `new DraftManagerHandler(mockDraftManagerService, mockPreviewService)`.
- In `'handlePromptDeleteDraft queries post version if versionStr not provided'`, asserted `expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1')`.
- Added test case verifying fallback to version 1 when `getDraft` returns `null`.

### 1.7 `tests/unit/adversarial-empirical-m5.spec.ts`
- In Dimension 4, replaced `mockPostsRepo` with `mockPostsService` (mocking `getPostWithRelations`) and `mockReviewQueueService` (mocking `getPost`).
- Updated `new PostActionsHandler(...)` and `new ReviewQueueHandler(...)` to match new constructor signatures.

### 1.8 `tests/unit/adversarial-empirical-m5-preview.spec.ts`
- In Dimension 1, added `getPost: jest.fn().mockImplementation((id: string) => postsRepository.findById!(id))` to `reviewQueueService` mock.
- Updated `new ReviewQueueHandler(...)` instantiation to pass 4 arguments, removing `postsRepository`.

---

## 2. Verification Summary

| Check | Target | Empirical Result | Status |
|---|---|---|:---:|
| Zero `as any` in `src/` | `git grep "as any" src/` | 0 matches (exit code 1) | PASS |
| Zero `any` in code in `src/` | `git grep -nE "\bany\b" src/` | 6 comment matches, 0 code matches | PASS |
| Zero repository in handlers | `git grep "postsRepository" src/modules/telegram/handlers/` | 0 matches (exit code 1) | PASS |
| Case-insensitive repository scan | `git grep -i "repository" src/modules/telegram/handlers/` | 0 matches (exit code 1) | PASS |
| Adversarial M5 Suite | `npx jest tests/unit/adversarial-empirical-m5.spec.ts` | 24 passed, 24 total | PASS |
| Adversarial Preview Suite | `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts` | 19 passed, 19 total | PASS |
| Unit Test Suite | `npm test` | 32 suites passed, 502 passed, 502 total | PASS |
| Programmatic E2E Suite | `npm run test:e2e` | 22 suites passed, 34 passed across 4 tiers | PASS |
| NestJS Build | `npm run build` | Clean compilation (exit code 0) | PASS |
