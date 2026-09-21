## 2026-09-21T08:46:18Z

You are m3_explorer_2, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m3_explorer_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md (§15, §16, §17)
- c:/TgHelp/AGENTS.md (§15, §16, §17, §18)
- c:/TgHelp/src/common/constants/telegram-limits.ts

Your mission:
Investigate and design TelegramRenderer, HtmlSanitizer, and multi-message splitting for Milestone 3:
1. Design HtmlSanitizer:
   - Allowed Telegram HTML tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>.
   - Tag balancing, attribute sanitization (only href on <a>), entity escaping for < and > outside allowed tags.
   - Strip prohibited/dangerous tags (<script>, <div>, <img onclick=...>, etc.).
2. Design TelegramRenderer:
   - Canonical rendering pipeline: converts Post + PostTemplate + PostMedia[] into a structured TelegramPayload.
   - Guarantee that Preview and Publication use the exact same renderer!
3. Design Multi-Message Splitting:
   - Telegram limits: caption max 1024 characters, message text max 4096 characters.
   - When a post has media and the text body exceeds 1024 chars, split into:
     Message 1: Media (or Media Group) with optional short caption / title (<= 1024).
     Message 2: Remaining long text body (<= 4096).
4. Formulate interfaces, DTOs, and recommend concrete implementation steps for the Worker.

Write your report to c:/TgHelp/.agents/m3_explorer_2/report.md and handoff to c:/TgHelp/.agents/m3_explorer_2/handoff.md.
Use send_message to notify parent orchestrator when complete.
