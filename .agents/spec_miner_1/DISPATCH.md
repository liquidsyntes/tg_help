## 2026-09-21T03:33:48Z

You are spec_miner_1, a teamwork_preview_spec_miner.
Your working directory is: c:/TgHelp/.agents/spec_miner_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/tasks.md

Your mission:
Extract a comprehensive, structured functional specification and complete feature inventory for the Telegram Content Publisher Bot MVP.
Analyze:
1. User roles and permissions (Super Admin, Editor, Author, channel-level permissions vs system-level).
2. Channels model (production, staging, timezones, Europe/Kyiv default).
3. Post state machine lifecycle (DRAFT, PENDING_REVIEW, APPROVED, NEEDS_REVISION, REJECTED, SCHEDULED, PUBLISHING, PUBLISHED, PUBLISH_FAILED, CANCELLED) and allowed transitions.
4. Post creation wizard flow (step-by-step UX, field inputs, autosave requirements at each step).
5. Post templates (dynamic templates, fields, validation, rendering).
6. Media types and handling (single, media group, caption limits, document vs video).
7. Review & revision workflow (rejection, feedback notes, resubmission).
8. Scheduling and publishing semantics.
9. Enumerate EVERY distinct feature into a table: Feature #, Name, Description, Source section.

Write your detailed report to c:/TgHelp/.agents/spec_miner_1/report.md and a handoff report to c:/TgHelp/.agents/spec_miner_1/handoff.md.
When finished, use send_message to notify the parent orchestrator with a summary of findings and the path to your report.
