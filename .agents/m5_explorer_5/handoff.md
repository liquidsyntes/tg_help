# Milestone 5 Transport & Typing Integrity Handoff Report

**Agent**: `m5_explorer_5` (teamwork_preview_explorer)  
**Roles**: M5 Remediation Explorer 2 — Codebase-Wide Transport & Typing Integrity Scan  
**Milestone**: M5 Remediation Investigation  
**Date**: 2026-09-22  
**Handoff Type**: Hard (Task Complete)

---

## 1. Observation

1. **`any` Types in `src/`**:
   - Tool execution: `grep -rnE "\bany\b" src/` returned exactly 8 matches.
   - 6 occurrences are in comments (`permission.service.ts:137`, `telegram-publisher.interface.ts:108`, `telegram-error.classifier.ts:27`, `template.validator.ts:24`, `draft-manager.service.ts:65`, `html-sanitizer.service.ts:125`).
   - Verbatim 2 code occurrences located in `src/modules/telegram/handlers/draft-manager.handler.ts`:
     ```ts
     118: } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
     119:   post = await (this.draftManagerService as any).getDraft(postId);
     ```
   - Zero occurrences of `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, or `eslint-disable` in `src/`.

2. **Repository and Prisma Injections in Transport Handlers (`src/modules/telegram/handlers/`)**:
   - Tool execution: `grep -rnE "repository|prisma" src/modules/telegram/handlers/` returned 22 matches across 3 handler files.
   - Handlers with direct repository injections:
     1. `draft-manager.handler.ts:23`: `@Optional() private readonly postsRepository?: PostsRepository`
     2. `review-queue.handler.ts:27`: `private readonly postsRepository: PostsRepository` (invoked at lines 85, 128, 160, 248)
     3. `post-actions.handler.ts:42`: `private readonly postsRepository: PostsRepository` (invoked at lines 80, 108, 179, 201, 232, 274, 316, 364, 400, 469, 505, 535)
   - Handlers with clean transport architecture (0 repository, 0 Prisma):
     1. `start.handler.ts`
     2. `help.handler.ts`
     3. `post-wizard.handler.ts`
   - Zero handlers inject `PrismaService`.

3. **Dead Injections in Application Services**:
   - `src/modules/telegram/services/review-queue.service.ts:29`: `private readonly postsRepository: PostsRepository` is injected into the constructor but never referenced anywhere in `ReviewQueueService`.

4. **Test Suite Baseline**:
   - `npm run build`: Exited with code 0 (clean NestJS compilation).
   - `npm test`: Exited with code 0 (32 test suites passed, 501 tests passed).
   - `npm run test:e2e`: Exited with code 0 (22 test suites passed, 34 tests passed).

---

## 2. Logic Chain

1. **From Observation 1 to Typing Strictness Assessment**:
   - `AGENTS.md` § 6 mandates: *"Use TypeScript strict mode. Do not introduce: any unless there is a documented and unavoidable integration boundary."*
   - `PROJECT.md` § Stack mandates: *"TypeScript strict mode (no any, domain-typed IDs)"*.
   - In `draft-manager.handler.ts:118-119`, `(this.draftManagerService as any).getDraft` accesses a local application service method that is already defined on `DraftManagerService` (`getDraft(postId: string): Promise<Post | null>` at `draft-manager.service.ts:227`).
   - Therefore, the `as any` type cast is completely unnecessary and represents an architectural and typing violation. Replacing it with `await this.draftManagerService.getDraft(postId)` eliminates all literal `any` code in `src/`.

2. **From Observation 2 to Transport Layer Compliance Assessment**:
   - `AGENTS.md` § 3 mandates:
     ```text
     Telegram Update -> Telegram Handler -> Application / Domain Service -> Repository
     ```
     *"Telegram handlers must NOT contain core business logic... Handlers should primarily: parse Telegram updates; validate basic input shape; identify the current user; call application services; render responses; map application errors to user-friendly messages."*
   - Injecting `PostsRepository` directly into `DraftManagerHandler`, `ReviewQueueHandler`, and `PostActionsHandler` bypasses the application service layer.
   - For `DraftManagerHandler`, `DraftManagerService` already provides `getDraft(postId)`. The handler has no need for `PostsRepository`.
   - For `PostActionsHandler`, `PostsService` is already injected in the constructor. The handler can delegate all 11 post reads to `PostsService`.
   - For `ReviewQueueHandler`, `ReviewQueueService` is the dedicated application service. Implementing `getPost(postId)` in `ReviewQueueService` allows `ReviewQueueHandler` to remove `PostsRepository` completely.

3. **From Observation 3 to Cleanup Synergy**:
   - Because `ReviewQueueService` already injects `PostsRepository` in its constructor (Observation 3), utilizing it for `ReviewQueueService.getPost(postId)` simultaneously solves the dead injection issue and satisfies AGENTS.md § 3 for `ReviewQueueHandler`.

---

## 3. Caveats

- **Test Double Alignment**: When `PostsRepository` is removed from the constructor parameter lists of `DraftManagerHandler`, `ReviewQueueHandler`, and `PostActionsHandler`, three unit test files that manually instantiate these handlers (`tests/unit/draft-manager.service.spec.ts`, `tests/unit/adversarial-empirical-m5.spec.ts`, and `tests/unit/adversarial-empirical-m5-preview.spec.ts`) must be updated to pass the corresponding application service mocks without `mockPostsRepo`.
- **Runtime Stability**: All 501 unit tests and 34 E2E tests currently pass. The violations are strictly architectural and typing compliance issues rather than functional runtime breakages.

---

## 4. Conclusion

1. **Typing**: `draft-manager.handler.ts` lines 118–119 contain the only remaining `any` types in `src/`.
2. **Transport Handlers**: Exactly 3 handlers (`draft-manager.handler.ts`, `review-queue.handler.ts`, `post-actions.handler.ts`) violate AGENTS.md § 3 by directly injecting `PostsRepository`.
3. **Actionable Remediation**:
   - Remove `PostsRepository` from `DraftManagerHandler` and delegate to `this.draftManagerService.getDraft(postId)`.
   - Remove `PostsRepository` from `ReviewQueueHandler` and delegate to `this.reviewQueueService.getPost(postId)`.
   - Remove `PostsRepository` from `PostActionsHandler` and delegate to `this.postsService.getPostWithRelations(postId)` (or `getPost`).
   - Align test fixtures in the 3 affected unit test specs.
   - This achieves 100% adherence to AGENTS.md § 3, § 5, and § 6 across the entire codebase.

---

## 5. Verification Method

To independently verify these findings:

1. **Verify `any` usages**:
   ```bash
   grep -rnE "\bany\b" src/
   ```
   *Expected result*: Exactly 2 code lines in `src/modules/telegram/handlers/draft-manager.handler.ts` (lines 118–119), 6 comment lines elsewhere.

2. **Verify repository injections in handlers**:
   ```bash
   grep -rnE "repository|prisma" src/modules/telegram/handlers/
   ```
   *Expected result*: Matches in `draft-manager.handler.ts`, `review-queue.handler.ts`, and `post-actions.handler.ts`. Zero matches in `start.handler.ts`, `help.handler.ts`, and `post-wizard.handler.ts`.

3. **Verify build and test suites**:
   ```bash
   npm run build
   npm test
   npm run test:e2e
   ```
   *Expected result*: Clean build, 501/501 unit tests passing, 34/34 E2E tests passing.

4. **Remediation Invalidation Condition**:
   Once remediation is implemented, `grep -rnE "\bany\b" src/` must yield 0 code matches, and `grep -rnE "repository|prisma" src/modules/telegram/handlers/` must yield 0 matches.
