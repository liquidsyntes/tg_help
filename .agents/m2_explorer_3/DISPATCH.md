## 2026-09-21T04:08:36Z
You are m2_explorer_3, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m2_explorer_3

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§24, §26)
- c:/TgHelp/AGENTS.md (§26, §27, §33, §34)

Your mission:
Investigate and design the Audit Logging and Domain Event Notification services for Milestone 2:
1. Design AuditLogService (src/modules/audit/):
   - Append-only recording of all domain actions in audit_logs: post_created, post_updated, media_added, media_removed, submitted, approved, revision_requested, rejected, scheduled, schedule_cancelled, publication_started, published, publication_failed, publication_cancelled, user_added, permission_changed.
   - Ensure payload JSON is sanitized (secrets such as tokens/passwords never recorded).
   - Append-only semantics: no update or delete operations on audit logs.
2. Design NotificationService (src/modules/notifications/):
   - Decoupled notification dispatch on domain events: notifying editors on post submitted for review, notifying author on post approved/rejected/revision requested, notifying on publication complete/failed.
   - Autosave silent rule: explicitly ensure routine draft autosaves emit zero notifications.
   - Fault tolerance: failure to send a secondary notification must NOT roll back core business transactions.
3. Formulate how transactions combine post state transition + review record + audit log inside prisma.$transaction.
4. Recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m2_explorer_3/report.md and handoff to c:/TgHelp/.agents/m2_explorer_3/handoff.md.
Use send_message to notify parent orchestrator when complete.
