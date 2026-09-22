# Dispatch: m5_explorer_4

## Role
M5 Remediation Explorer 1 — Integrity & Layering Fix Strategy (`teamwork_preview_explorer`)

## Working Directory
`c:/TgHelp/.agents/m5_explorer_4`

## Mandatory Reading (Read FIRST)
1. `c:/TgHelp/.agents/ORIGINAL_REQUEST.md` (MANDATORY: read first!)
2. `c:/TgHelp/.agents/PROJECT.md`
3. `c:/TgHelp/AGENTS.md` (specifically §3 Core Architectural Principle, §5 Dependency Direction, §6 TypeScript Rules)
4. `c:/TgHelp/tasks.md`
5. `c:/TgHelp/.agents/m5_auditor_2/report.md` (FULL AUDIT EVIDENCE REPORT — DO NOT OMIT OR FILTER)
6. `c:/TgHelp/.agents/m5_auditor_2/handoff.md`
7. `c:/TgHelp/.agents/m5_worker_2/changes.md`
8. `src/modules/telegram/handlers/draft-manager.handler.ts`
9. `src/modules/telegram/services/draft-manager.service.ts`

## Forensic Audit Findings to Remediate
The Forensic Auditor (`m5_auditor_2`) reported an INTEGRITY VIOLATION with binary veto on Check 1:
1. Two explicit `as any` type bypasses in `src/modules/telegram/handlers/draft-manager.handler.ts:118-119` (`(this.draftManagerService as any).getDraft`).
2. Direct repository injection in a transport handler: `DraftManagerHandler` constructor injects `@Optional() private readonly postsRepository?: PostsRepository` and directly queries the repository (`await this.postsRepository.findById(postId)`), violating AGENTS.md §3 and §5.

## Investigation Objective
1. Inspect `src/modules/telegram/handlers/draft-manager.handler.ts` and `src/modules/telegram/services/draft-manager.service.ts`.
2. Formulate an architectural fix strategy to:
   - Completely eliminate the `postsRepository` injection from `DraftManagerHandler`.
   - Ensure `DraftManagerService` exposes a strongly typed method `getDraft(postId: string): Promise<Post | null>` (already present).
   - In `DraftManagerHandler.handlePromptDeleteDraft`, call `await this.draftManagerService.getDraft(postId)` directly without `as any` or runtime `typeof` checks.
   - Ensure zero `any` types remain in production code.
3. Verify that the fix adheres strictly to AGENTS.md §3 ("Telegram handlers must NOT contain core business logic... Correct: Telegram Update -> Telegram Handler -> Application Service -> Repository") and AGENTS.md §6 ("Do not introduce: any").
4. Formulate the exact code edits for the remediation worker.

## Deliverables
- Write findings to `c:/TgHelp/.agents/m5_explorer_4/report.md`
- Write handoff to `c:/TgHelp/.agents/m5_explorer_4/handoff.md`
- Send completion message to parent orchestrator.

## 2026-09-21T23:45:43Z
Dispatch confirmed. Role: M5 Remediation Explorer 1 — Integrity & Layering Fix Strategy (`teamwork_preview_explorer`).
Target: formulate clean fix for DraftManagerHandler and DraftManagerService.

