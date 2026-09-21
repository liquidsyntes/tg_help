## 2026-09-21T04:08:36Z
You are m2_explorer_1, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m2_explorer_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§4, §5, §7)
- c:/TgHelp/AGENTS.md (§8, §9)
- c:/TgHelp/src/infrastructure/database/prisma.service.ts

Your mission:
Investigate and design the Auth, Users, Channels, and RBAC modules for Milestone 2:
1. Design AuthService (src/modules/auth/):
   - Authenticate by Telegram ID (BigInt). Verify user exists and isActive = true.
   - Reject unauthenticated users on /start or protected callbacks.
2. Design PermissionService & RBAC (src/modules/auth/):
   - System roles (SUPER_ADMIN, USER) vs Channel roles (EDITOR, AUTHOR, VIEWER).
   - Granular channel permissions: canPublish, canApprove.
   - SUPER_ADMIN system-role bypass rules.
   - Channel permission evaluation logic.
3. Design ChannelsService (src/modules/channels/):
   - Multi-channel support, autoSkipSingleChannel helper (returns the channel if user has access to exactly 1).
   - Timezone parsing and conversion using channel's timezone (default Europe/Kyiv) to UTC TIMESTAMPTZ. Rejection of past dates.
4. Formulate the exact service interfaces, DTOs, and recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m2_explorer_1/report.md and handoff to c:/TgHelp/.agents/m2_explorer_1/handoff.md.
Use send_message to notify parent orchestrator when complete.
