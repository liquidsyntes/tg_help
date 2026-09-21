## 2026-09-21T19:04:19Z
You are m5_explorer_2, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m5_explorer_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (§3, §7, §11, §12, §13, §14, §19)
- c:/TgHelp/tasks.md (§7, §8, §9, §10, §11, §12, §18)

Your mission:
Investigate and design Post Creation Wizard, Autosave, and Media Handling for Milestone 5:
1. Interactive Post Creation Wizard:
   - Channel selection (if user belongs to multiple channels, or auto-select default channel).
   - Template selection (list active templates from TemplatesService).
   - Dynamic field collection loop: prompt each field defined in template schema, validate via TemplateValidator, provide empathetic Russian validation hints on error.
2. Immediate PostgreSQL Autosave (AGENTS.md §11, §12):
   - Persist state to PostgreSQL posts table immediately after EACH meaningful step (channel selected -> save, template selected -> save, each field entered -> save, media attached -> save).
   - Support draft interruption and resumption (user can stop anytime and resume via /drafts or My Drafts menu).
3. Media Attachment Flow:
   - Photo, video, document-as-video, media group (2-10 items).
   - Zero-download file_id persistence via MediaService.
4. Formulate interfaces, state transitions, DTOs, and concrete implementation recommendations for the Worker.

Write your report to c:/TgHelp/.agents/m5_explorer_2/report.md and handoff to c:/TgHelp/.agents/m5_explorer_2/handoff.md.
Use send_message to notify parent orchestrator when complete.
