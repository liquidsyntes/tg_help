## 2026-09-22T00:04:16Z
You are m6_worker_1, a teamwork_preview_worker.
Your working directory is: c:/TgHelp/.agents/m6_worker_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (§6, §10, §11, §12, §13, §21)
- c:/TgHelp/tasks.md (§12)
- c:/TgHelp/.agents/m6_challenger_2/report.md and handoff.md (Specific OCC finding)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Mission:
Apply the recommended OCC versioning fix identified by m6_challenger_2 and verify that all unit and E2E tests pass 100%.

1. Inspect `src/modules/telegram/services/draft-manager.service.ts`:
   - In `submitEditedField()` (around line 205-211), `this.postsService.autosaveStep` was being passed `post.version` (fresh DB version) instead of `session.expectedVersion ?? post.version`.
   - Update `submitEditedField()` so it passes `session.expectedVersion ?? post.version` to `this.postsService.autosaveStep`.
   - Strict TypeScript rules (AGENTS.md §6): NO `as any`, NO `any` in `src/`. Keep strict type safety.

2. Update `tests/unit/adversarial-empirical-m6-transport.spec.ts`:
   - In test `3.6.2` (around lines 889-917), update the test expectations:
     - The author starts editing with post at version 5 (`session.expectedVersion: 5`).
     - A concurrent modification bumps the DB post to version 6.
     - When `submitEditedField` executes, it must pass `session.expectedVersion` (5) to `autosaveStep`.
     - Because `expectedVersion` is 5 while DB version is 6, `mockPostsService.autosaveStep` rejects with `PostConflictException`.
     - Verify that `submitEditedField` raises/propagates `PostConflictException` (or that `mockPostsService.autosaveStep` is called with version 5).
     - Test passes cleanly.

3. Execute verification commands:
   - `npx jest tests/unit/adversarial-empirical-m6-transport.spec.ts --config ./tests/jest.json`
   - `npm test` (all 34+ test suites must pass 100%)
   - `npm run test:e2e` (all 34 E2E test cases across Tiers 1-4 must pass 100%)
   - `npm run build` (NestJS build must exit 0 cleanly with zero TypeScript errors)

Report all changes in `c:/TgHelp/.agents/m6_worker_1/changes.md` and write a full handoff report to `c:/TgHelp/.agents/m6_worker_1/handoff.md`.
Use send_message to notify parent orchestrator when complete.
