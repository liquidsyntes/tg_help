## 2026-09-21T08:46:18Z
You are m3_explorer_3, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m3_explorer_3

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§18)
- c:/TgHelp/AGENTS.md (§19)

Your mission:
Investigate and design MediaService and media handling for Milestone 3:
1. Design MediaService:
   - Persist Telegram file_id, file_unique_id, media_type, file_name, mime_type, file_size, sort_order in post_media.
   - Reusing Telegram file_id without downloading or re-uploading files.
2. Media Group Rules:
   - Media groups contain 2 to 10 media items.
   - Ordering via sort_order.
3. Document-as-Video Handling:
   - Detecting when a user sends a video as an uncompressed document (document with video/mp4, video/quicktime, etc.).
   - Flagging or mapping so the renderer and publisher handle it correctly without crashing.
4. Formulate interfaces, DTOs, and recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m3_explorer_3/report.md and handoff to c:/TgHelp/.agents/m3_explorer_3/handoff.md.
Use send_message to notify parent orchestrator when complete.
