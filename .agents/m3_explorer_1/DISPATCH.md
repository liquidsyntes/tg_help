## 2026-09-21T08:46:18Z
You are m3_explorer_1, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m3_explorer_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§9, §14)
- c:/TgHelp/AGENTS.md (§14)

Your mission:
Investigate and design TemplatesService and TemplateValidator for Milestone 3:
1. Review the 6 standard templates seeded in prisma/seed.ts: longread, announcement, photo, video, news, freeform.
2. Design dynamic field validation:
   - Field types: text, textarea, number, url.
   - Field constraints: required, minLength, maxLength, regex if applicable.
   - Validation error messages: clear, user-friendly Russian messages.
3. Design template CRUD & retrieval (active templates for post creation, template lookup by key or ID).
4. Formulate interfaces, DTOs, and recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m3_explorer_1/report.md and handoff to c:/TgHelp/.agents/m3_explorer_1/handoff.md.
Use send_message to notify parent orchestrator when complete.
