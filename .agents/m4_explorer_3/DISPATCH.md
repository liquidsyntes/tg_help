## 2026-09-21T13:56:47Z

You are m4_explorer_3, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m4_explorer_3

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (specifically §23 Partial Publication, §24 Scheduling, §25 Preflight Validation, §27 Notifications, §39 Tests)
- c:/TgHelp/tasks.md (specifically §23, §24, §25, §27)
- c:/TgHelp/.agents/TEST_READY.md

Your mission:
Investigate and design Scheduling, Preflight Validation, and Partial Publication Resume for Milestone 4:
1. Timezone-Aware Scheduling:
   - Design SchedulingService: accept publication datetime in channel timezone (Europe/Kyiv by default via Luxon), validate that scheduled time is in the future.
   - Convert to absolute UTC TIMESTAMPTZ and store in post.scheduledAt.
   - Transition post state APPROVED -> SCHEDULED with OCC increment and audit log.
   - Enqueue delayed BullMQ job (delay = scheduledTime - Date.now()).
   - Support cancelSchedule: cancel delayed job, transition SCHEDULED -> CANCELLED or back to APPROVED.
2. Two-Stage Preflight Validation:
   - Design PreflightService:
     - Stage 1 (at schedule/enqueue time): verify post is APPROVED, template is valid, media is present if required, channel exists.
     - Stage 2 (immediately before send in worker): verify post exists and is not soft-deleted, status is still APPROVED/SCHEDULED/PUBLISHING, channel is active, bot still has admin rights, media references still usable.
3. Partial Publication Resume (AGENTS.md §23):
   - Multi-message publications (e.g. Media Group + overflow long text message).
   - After each successful API call, persist Telegram message ID(s) in PublicationJob.telegramMessageIds.
   - If message 1 (sendMediaGroup) succeeds and message 2 (sendMessage) fails:
     On worker retry, inspect telegramMessageIds: skip message 1, resume dispatch from message 2.
     Never duplicate already-published messages in the channel.
4. Editorial Notifications:
   - Trigger NotificationService on publication success (PUBLISHED) or terminal failure (PUBLISH_FAILED) to notify author and editors.
5. Formulate interfaces, DTOs, and a step-by-step implementation roadmap for the Worker.

Write your findings to c:/TgHelp/.agents/m4_explorer_3/report.md and handoff to c:/TgHelp/.agents/m4_explorer_3/handoff.md.
Notify parent orchestrator via send_message when complete.
