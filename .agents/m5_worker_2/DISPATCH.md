# Dispatch: m5_worker_2

## Role
Milestone 5 Remediation Worker (`teamwork_preview_worker`)

## Working Directory
`c:/TgHelp/.agents/m5_worker_2`

## Mandatory Reading
1. `c:/TgHelp/.agents/ORIGINAL_REQUEST.md` (MANDATORY: read first!)
2. `c:/TgHelp/.agents/PROJECT.md`
3. `c:/TgHelp/AGENTS.md` (specifically §11, §12, §13, §18, §31, §54)
4. `c:/TgHelp/tasks.md` (specifically §9, §11, §13)
5. `c:/TgHelp/.agents/m5_challenger_1/report.md` (Defect analysis & challenge report)
6. `c:/TgHelp/.agents/m5_challenger_1/handoff.md` (Handoff report & reproduction)
7. `tests/unit/adversarial-empirical-m5.spec.ts` (Adversarial test suite)

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Remediation Objective
Fix the hardcoded version in draft deletion confirmation and ensure callback data budget safety:

1. **Fix Draft Deletion Confirmation Version (`draft-manager.handler.ts` & `telegram-bot.service.ts`)**:
   - In `src/modules/telegram/handlers/draft-manager.handler.ts` line 56:
     Encode current draft version into the delete callback: `draft:del:${d.id}:${d.version}`.
   - In `src/modules/telegram/services/telegram-bot.service.ts` line 129:
     Update regex or callback pattern to extract optional version: `^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$`.
     Pass `version` (or undefined) to `draftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr)`.
   - In `src/modules/telegram/handlers/draft-manager.handler.ts` line 99 & 108:
     Update `handlePromptDeleteDraft(ctx: BotContext, postId: string, versionStr?: string)`:
     If `versionStr` is provided, parse it as integer; if not provided or invalid, query `postsRepository.findById(postId)` or `draftManagerService` to obtain the current post version.
     In line 108, render the callback as: `draft:cdel:${postId}:${version}` (replacing the hardcoded `:1`).
   - In `src/modules/telegram/handlers/draft-manager.handler.ts` line 124:
     Verify that `handleConfirmDeleteDraft` receives and uses the dynamic version when invoking `draftManagerService.deleteDraft(user.id, postId, version)`.

2. **Callback Data Safety in Granular Field Editing (`post-actions.handler.ts`)**:
   - In `src/modules/telegram/handlers/post-actions.handler.ts` line 209:
     Shorten callback prefix from `draft:edit:${post.id}:${field.key}` to `d:e:${post.id}:${field.key}` (or ensure total length is strictly <= 64 bytes).
     Update callback router in `telegram-bot.service.ts` to support `d:e:` (or keep backward compatibility if needed).

3. **Verify Tests**:
   - Run adversarial empirical suite:
     `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json`
     Ensure test 5.1 and all 24 tests pass.
   - Run preview adversarial suite:
     `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json`
     Ensure all 19 tests pass.
   - Run full unit tests:
     `npm test`
   - Run full E2E tests:
     `npm run test:e2e`
   - Run build:
     `npm run build`

4. **Deliverables**:
   - Record exact changes in `c:/TgHelp/.agents/m5_worker_2/changes.md`.
   - Record handoff report in `c:/TgHelp/.agents/m5_worker_2/handoff.md`.
   - Send completion message to parent orchestrator.

## 2026-09-21T23:34:06Z
You are m5_worker_2, a teamwork_preview_worker.
Your working directory is: c:/TgHelp/.agents/m5_worker_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (specifically §11, §12, §13, §18, §31, §54)
- c:/TgHelp/tasks.md (specifically §9, §11, §13)
- c:/TgHelp/.agents/m5_challenger_1/report.md
- c:/TgHelp/.agents/m5_challenger_1/handoff.md
- c:/TgHelp/.agents/m5_worker_2/DISPATCH.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your mission:
Remediate the defect uncovered by Challenger 1 in Milestone 5:
1. Fix Draft Deletion Confirmation Version:
   - In src/modules/telegram/handlers/draft-manager.handler.ts:
     - In line 56, encode draft version in the delete callback: draft:del:${d.id}:${d.version}
     - In handlePromptDeleteDraft, parse versionStr if provided; if not, query postsRepository.findById(postId) or draftManagerService to obtain the current post version.
     - In line 108, pass dynamic version: draft:cdel:${postId}:${version} (replace hardcoded :1).
     - In handleConfirmDeleteDraft, ensure it receives and passes the dynamic version to draftManagerService.deleteDraft.
   - In src/modules/telegram/services/telegram-bot.service.ts:
     - Update the regex for draft:del callback: /^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$/
     - Pass version (if present) to draftManagerHandler.handlePromptDeleteDraft(ctx, postId, versionStr).
2. Callback Data Safety in Granular Field Editing:
   - In src/modules/telegram/handlers/post-actions.handler.ts line 209:
     Shorten callback prefix from draft:edit:${post.id}:${field.key} to d:e:${post.id}:${field.key} (or ensure total length strictly <= 64 bytes).
     Update callback routing in telegram-bot.service.ts to handle d:e: (or keep backward compatibility if needed).
3. Test Verification:
   - Run adversarial suite: npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json (ensure test 5.1 and all 24 pass).
   - Run preview adversarial suite: npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json (ensure all 19 pass).
   - Run full unit tests: npm test (ensure all 32 suites pass).
   - Run full E2E tests: npm run test:e2e (ensure all 34 tests pass).
   - Run build: npm run build (ensure clean exit 0).
4. Documentation:
   - Write changes to c:/TgHelp/.agents/m5_worker_2/changes.md
   - Write handoff report to c:/TgHelp/.agents/m5_worker_2/handoff.md
   - Send completion message to parent orchestrator via send_message.
