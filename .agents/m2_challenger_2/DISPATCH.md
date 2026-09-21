## 2026-09-21T08:38:46Z
You are m2_challenger_2, a teamwork_preview_challenger.
Your working directory is: c:/TgHelp/.agents/m2_challenger_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/.agents/m2_worker_1/changes.md
- c:/TgHelp/.agents/m2_worker_1/handoff.md

Your mission:
Empirically stress-test Milestone 2 State Machine, OCC, and Reviews against live PostgreSQL:
1. Concurrency Stress (OCC): Simulate two concurrent updates on the same post with initial version 1. Verify that exactly one succeeds and increments version to 2, while the second update receives PostConflictException and leaves version at 2.
2. Review Comment Invariant: Attempt to transition post to NEEDS_REVISION with empty string or whitespace comment; verify it is rejected and post status remains PENDING_REVIEW.
3. Soft Delete Invariant: Soft-delete a post and attempt to update or transition it; verify it is rejected.
4. Transaction Atomicity: Verify that if an audit log write or review insertion fails, the status transition is rolled back completely.
5. Render a definitive verdict: APPROVE or REQUEST_CHANGES.

Write report to c:/TgHelp/.agents/m2_challenger_2/report.md and handoff to c:/TgHelp/.agents/m2_challenger_2/handoff.md.
Use send_message to notify parent orchestrator with your verdict.
