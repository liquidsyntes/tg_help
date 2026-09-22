# Dispatch: m5_worker_3

## Role
Milestone 5 Architectural & Integrity Remediation Worker (`teamwork_preview_worker`)

## Working Directory
`c:/TgHelp/.agents/m5_worker_3`

## Mandatory Reading (Read FIRST)
1. `c:/TgHelp/.agents/ORIGINAL_REQUEST.md` (MANDATORY: read first!)
2. `c:/TgHelp/.agents/PROJECT.md`
3. `c:/TgHelp/AGENTS.md` (specifically §3 Core Architectural Principle, §5 Dependency Direction, §6 TypeScript Rules)
4. `c:/TgHelp/tasks.md`
5. `c:/TgHelp/.agents/m5_auditor_2/report.md` (Forensic Audit Violation Report)
6. `c:/TgHelp/.agents/m5_explorer_4/report.md` (Integrity & Layering Fix Strategy)
7. `c:/TgHelp/.agents/m5_explorer_5/report.md` (Codebase-wide Sweep)
8. `c:/TgHelp/.agents/m5_explorer_6/report.md` (Test Regression Strategy)

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Remediation Objectives
Apply the architectural and typing cleanup to achieve 100% compliance with AGENTS.md §3, §5, §6 and pass the Forensic Integrity Audit:

1. **`src/modules/telegram/handlers/draft-manager.handler.ts`**:
   - Remove `import { PostsRepository } from '../../posts/posts.repository';` and `Optional` from `@nestjs/common`.
   - Remove `@Optional() private readonly postsRepository?: PostsRepository` from constructor.
   - In `handlePromptDeleteDraft`, replace lines 115–122 with:
     ```ts
     let version = versionStr ? parseInt(versionStr, 10) : NaN;
     if (isNaN(version)) {
       const post = await this.draftManagerService.getDraft(postId);
       version = post?.version ?? 1;
     }
     ```
   - Ensure zero occurrences of `as any` or `any` in code.

2. **`src/modules/telegram/handlers/review-queue.handler.ts` & `review-queue.service.ts`**:
   - In `src/modules/telegram/services/review-queue.service.ts`, expose:
     ```ts
     async getPost(postId: string): Promise<Post | null> {
       return this.postsRepository.findById(postId);
     }
     ```
   - In `src/modules/telegram/handlers/review-queue.handler.ts`:
     - Remove `PostsRepository` from imports and constructor.
     - Replace all `this.postsRepository.findById(postId)` calls with `this.reviewQueueService.getPost(postId)`.

3. **`src/modules/telegram/handlers/post-actions.handler.ts`**:
   - In `src/modules/telegram/handlers/post-actions.handler.ts`:
     - Remove `PostsRepository` from imports and constructor.
     - Replace `this.postsRepository.findById` calls with `this.postsService.getPostWithRelations(postId)` or `this.postsService.getPost(postId)`.
   - Ensure zero handlers in `src/modules/telegram/handlers/` directly inject repositories.

4. **Unit Test Updates (`tests/unit/draft-manager.service.spec.ts`)**:
   - Update `DraftManagerHandler` test suite:
     - Remove `mockPostsRepo`.
     - Instantiate `new DraftManagerHandler(mockDraftManagerService, mockPreviewService)`.
     - In test `'handlePromptDeleteDraft queries post version if versionStr not provided'`, assert:
       ```ts
       expect(mockDraftManagerService.getDraft).toHaveBeenCalledWith('draft-1');
       ```
   - If `review-queue.handler` or `post-actions.handler` tests exist with `postsRepository` in constructors, update their instantiations to match the new constructor signatures.

5. **Verification Checklist**:
   - `git grep "as any" src/` -> 0 matches.
   - `git grep "\bany\b" src/` -> 0 code matches (only in comments).
   - `git grep "postsRepository" src/modules/telegram/handlers/` -> 0 matches.
   - `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json` -> 24/24 pass.
   - `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json` -> 19/19 pass.
   - `npm test` -> 100% pass (32 suites).
   - `npm run test:e2e` -> 100% pass (34 tests).
   - `npm run build` -> Clean exit 0.

6. **Deliverables**:
   - Record exact changes in `c:/TgHelp/.agents/m5_worker_3/changes.md`.
   - Record handoff report in `c:/TgHelp/.agents/m5_worker_3/handoff.md`.
   - Send completion message to parent orchestrator via send_message.
