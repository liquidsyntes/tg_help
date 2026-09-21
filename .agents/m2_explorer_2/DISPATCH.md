## 2026-09-21T04:08:36Z
You are m2_explorer_2, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m2_explorer_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§6, §10, §12, §13)
- c:/TgHelp/AGENTS.md (§10, §13, §28, §31)

Your mission:
Investigate and design the Post Workflow State Machine, Optimistic Concurrency Control, and Reviews for Milestone 2:
1. Design PostWorkflowService (src/modules/posts/post-workflow.service.ts):
   - 10 Post statuses: DRAFT, PENDING_REVIEW, APPROVED, NEEDS_REVISION, REJECTED, SCHEDULED, PUBLISHING, PUBLISHED, PUBLISH_FAILED, CANCELLED.
   - Allowed transitions map with actor authorization checks:
     - DRAFT -> PENDING_REVIEW (Author, Editor, Admin)
     - PENDING_REVIEW -> APPROVED (Editor, Admin with can_approve)
     - PENDING_REVIEW -> NEEDS_REVISION (Editor, Admin; mandatory non-empty comment)
     - PENDING_REVIEW -> REJECTED (Editor, Admin)
     - NEEDS_REVISION -> PENDING_REVIEW (Author, Editor resubmission)
     - APPROVED -> SCHEDULED (scheduled_at > NOW(), can_publish)
     - SCHEDULED -> CANCELLED (Editor, Admin)
     - APPROVED -> PUBLISHING / SCHEDULED -> PUBLISHING
     - PUBLISHING -> PUBLISHED / PUBLISH_FAILED
     - PUBLISH_FAILED -> PUBLISHING (retry) / CANCELLED
   - Disallowed transitions MUST throw InvalidPostStateTransitionException.
2. Design OCC (Optimistic Concurrency Control) repository updates:
   - Atomic update checking WHERE id = :id AND version = :expectedVersion, updating version = version + 1.
   - Throw PostConflictException if 0 rows updated.
3. Design Soft Deletion (deleted_at = NOW()): normal queries must filter out deleted_at IS NOT NULL.
4. Design ReviewsService (src/modules/reviews/): creating PostReview entries with mandatory comments for NEEDS_REVISION.
5. Recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m2_explorer_2/report.md and handoff to c:/TgHelp/.agents/m2_explorer_2/handoff.md.
Use send_message to notify parent orchestrator when complete.
