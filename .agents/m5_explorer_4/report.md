# Architectural Analysis Report: Integrity & Layering Remediation

**Agent**: `m5_explorer_4` (teamwork_preview_explorer)  
**Mission**: Formulate an architectural fix strategy to remediate the Forensic Auditor's Integrity Violation in `DraftManagerHandler` and `DraftManagerService`.  
**Date**: 2026-09-22  
**Status**: COMPLETE  

---

## 1. Executive Summary

The Forensic Auditor (`m5_auditor_2`) issued an **INTEGRITY VIOLATION** verdict on the Milestone 5 remediation due to two violations in `src/modules/telegram/handlers/draft-manager.handler.ts`:
1. **Zero-Any Rule Breach (AGENTS.md §6, PROJECT.md §Stack)**: Two explicit `as any` type bypasses at lines 118–119 (`(this.draftManagerService as any).getDraft`).
2. **Layering & Dependency Direction Breach (AGENTS.md §3, §5)**: Ingestion of `@Optional() private readonly postsRepository?: PostsRepository` directly into a transport handler and executing direct database queries (`await this.postsRepository.findById(postId)`).

This investigation verified the exact root cause, confirmed that `DraftManagerService` already provides the strongly typed public method `getDraft(postId: string): Promise<Post | null>`, and formulated the minimal, non-breaking, step-by-step remediation plan for `m5_worker_3`.

---

## 2. Root Cause Analysis & Empirical Evidence

### 2.1 Direct Repository Injection into Transport Handler
- **Location**: `src/modules/telegram/handlers/draft-manager.handler.ts:12, 23`
- **Code**:
  ```ts
  import { Injectable, Optional } from '@nestjs/common';
  ...
  import { PostsRepository } from '../../posts/posts.repository';
  ...
  export class DraftManagerHandler {
    constructor(
      private readonly draftManagerService: DraftManagerService,
      private readonly previewService: TelegramPreviewService,
      @Optional() private readonly postsRepository?: PostsRepository,
    ) {}
  ```
- **Violation**: `AGENTS.md` §3 explicitly specifies:
  > *Telegram is a transport layer. Telegram handlers must NOT contain core business logic.*  
  > *Correct:* `Telegram Update -> Telegram Handler -> Application / Domain Service -> Repository`  
  > *Incorrect:* `Telegram Handler -> Prisma / Telegram API / Redis`
  
  Injecting `PostsRepository` into `DraftManagerHandler` bypasses the application service layer. Transport handlers must never communicate directly with persistence repositories.

### 2.2 `as any` Type Bypasses
- **Location**: `src/modules/telegram/handlers/draft-manager.handler.ts:118–119`
- **Code**:
  ```ts
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
  ```
- **Violation**:
  - `AGENTS.md` §6: *"Use TypeScript strict mode. Do not introduce: `any` unless there is a documented and unavoidable integration boundary."*
  - `PROJECT.md` § Stack: *"TypeScript strict mode (no `any`, domain-typed IDs)"*.
  - `ORIGINAL_REQUEST.md` & Audit Dispatch: *"Ensure zero `any` types"*.
  - Across the entire `src/` codebase, lines 118–119 of `draft-manager.handler.ts` are the **only** instances of `as any` in production code.

### 2.3 Ready Availability of Strongly Typed Service Method
- **Location**: `src/modules/telegram/services/draft-manager.service.ts:227–229`
- **Code**:
  ```ts
  /**
   * Retrieves a draft by ID.
   */
  async getDraft(postId: string): Promise<Post | null> {
    return this.postsRepository.findById(postId);
  }
  ```
- **Finding**: `DraftManagerService` already encapsulates repository access to retrieve drafts. It is already injected into `DraftManagerHandler` as `private readonly draftManagerService: DraftManagerService`. No type bypass, runtime `typeof` check, or repository injection is required.

---

## 3. Remediated Architecture & Clean Fix Strategy

### 3.1 Architectural Invariant Flow
```text
Telegram Callback: "draft:del:<postId>" (or legacy without version)
       ↓
DraftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr?)
       ↓
if (isNaN(version)) -> await this.draftManagerService.getDraft(postId)
       ↓
DraftManagerService.getDraft(postId) -> this.postsRepository.findById(postId)
       ↓
version = post?.version ?? 1
       ↓
Render Confirmation Keyboard: "draft:cdel:<postId>:<version>"
```

### 3.2 Target Code Edits

#### Edit A: `src/modules/telegram/handlers/draft-manager.handler.ts`
1. Remove `Optional` import from `@nestjs/common`.
2. Remove `import { PostsRepository } from '../../posts/posts.repository';`.
3. Clean constructor signature to 2 dependencies: `draftManagerService` and `previewService`.
4. Simplify version resolution in `handlePromptDeleteDraft`:
   ```ts
   let version = versionStr ? parseInt(versionStr, 10) : NaN;
   if (isNaN(version)) {
     const post = await this.draftManagerService.getDraft(postId);
     version = post?.version ?? 1;
   }
   ```

#### Edit B: `tests/unit/draft-manager.service.spec.ts`
1. Remove `mockPostsRepo` variable and assignment from `describe('DraftManagerHandler')`.
2. Instantiate `handler = new DraftManagerHandler(mockDraftManagerService as DraftManagerService, mockPreviewService as TelegramPreviewService);`.
3. In test `'handlePromptDeleteDraft queries post version if versionStr not provided'`, add assertion:
   ```ts
   expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1');
   ```

---

## 4. Step-by-Step Instructions for Worker (`m5_worker_3`)

### Step 1: Modify `src/modules/telegram/handlers/draft-manager.handler.ts`
Apply the following diff:

```diff
@@ -7,7 +7,7 @@
-import { Injectable, Optional } from '@nestjs/common';
+import { Injectable } from '@nestjs/common';
 import { InlineKeyboard } from 'grammy';
 import { BotContext } from '../interfaces/bot-context.interface';
 import { DraftManagerService } from '../services/draft-manager.service';
 import { TelegramPreviewService } from '../services/telegram-preview.service';
-import { PostsRepository } from '../../posts/posts.repository';
 import { WizardKeyboardBuilder } from '../keyboards/wizard.keyboard';
@@ -20,5 +19,4 @@ export class DraftManagerHandler {
   constructor(
     private readonly draftManagerService: DraftManagerService,
     private readonly previewService: TelegramPreviewService,
-    @Optional() private readonly postsRepository?: PostsRepository,
   ) {}
@@ -113,10 +111,6 @@ export class DraftManagerHandler {
     let version = versionStr ? parseInt(versionStr, 10) : NaN;
     if (isNaN(version)) {
-      let post: { version: number } | null = null;
-      if (this.postsRepository) {
-        post = await this.postsRepository.findById(postId);
-      } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
-        post = await (this.draftManagerService as any).getDraft(postId);
-      }
+      const post = await this.draftManagerService.getDraft(postId);
       version = post?.version ?? 1;
     }
```

### Step 2: Modify `tests/unit/draft-manager.service.spec.ts`
Apply the following diff:

```diff
@@ -188,3 +188,2 @@ describe('DraftManagerHandler', () => {
   let mockDraftManagerService: Partial<DraftManagerService>;
   let mockPreviewService: Partial<TelegramPreviewService>;
-  let mockPostsRepo: Partial<PostsRepository>;
 
@@ -216,7 +215,0 @@ describe('DraftManagerHandler', () => {
-    mockPostsRepo = {
-      findById: jest.fn().mockResolvedValue({
-        id: 'draft-1',
-        version: 3,
-      } as any),
-    };
-
@@ -224,5 +216,4 @@ describe('DraftManagerHandler', () => {
     handler = new DraftManagerHandler(
       mockDraftManagerService as DraftManagerService,
       mockPreviewService as TelegramPreviewService,
-      mockPostsRepo as PostsRepository,
     );
@@ -271,2 +262,3 @@ describe('DraftManagerHandler', () => {
     await handler.handlePromptDeleteDraft(ctx, 'draft-1');
 
+    expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1');
     const call = (ctx.reply as jest.Mock).mock.calls[0];
```

### Step 3: Verification Commands
Run the following commands to confirm clean remediation:
1. `git grep "\bany\b" src/`
   - Verify that NO `any` types remain in production code (only in doc comments like "any error").
2. `git grep "postsRepository" src/modules/telegram/handlers/draft-manager.handler.ts`
   - Verify 0 matches.
3. `npm run build`
   - Must exit 0.
4. `npm test`
   - All 32 suites, 501 tests must pass (100% pass rate).
5. `npm run test:e2e`
   - All 4 tiers, 34 tests must pass.
