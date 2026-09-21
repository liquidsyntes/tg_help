## 2026-09-21T09:01:07Z

You are m3_reviewer_2, a teamwork_preview_reviewer.
Your working directory is: c:/TgHelp/.agents/m3_reviewer_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md
- c:/TgHelp/tasks.md
- c:/TgHelp/.agents/m3_worker_1/changes.md
- c:/TgHelp/.agents/m3_worker_1/handoff.md

Your mission:
Review the Milestone 3 Canonical Rendering and Media modules:
1. Verify Canonical Rendering (src/modules/rendering/):
   - Check AGENTS.md §15: Single canonical pipeline for both Preview and Publication. Ensure no divergent rendering code.
   - Check HtmlSanitizer: strictly whitelists Telegram HTML tags (<b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>), normalizes aliases, restricts <a> href to https://, http://, tg://, strips scripts and dangerous event handlers, auto-balances unclosed tags via LIFO stack, and escapes entities without double escaping.
   - Check HtmlSplitter: splits at natural boundaries, enforces caption <= 1024 and text <= 4096, auto-closes active tags at Part 1 and reopens at Part 2.
   - Check TelegramRenderer: produces structured TelegramPayload with TelegramOutgoingMessage[].
2. Verify Media Module (src/modules/media/):
   - Check zero-download principle: Telegram file_id is stored and reused directly without downloading/uploading binaries.
   - Check media group constraints: 2-10 items, sequential sortOrder ASC, album compatibility (photo+video ok, documents only with documents, animations rejected from groups).
   - Check document-as-video handling: detects uncompressed videos sent as documents, prevents illegal sendVideo call on document file_id, routes via sendDocument, prevents mixing with photos in albums.
   - Check gapless sortOrder renormalization on item deletion.
   - Check PostsService backward-compatible delegation.
3. Run npm run build, npm test tests/unit/rendering.spec.ts, and npm test tests/unit/media.spec.ts.
4. Render your verdict: APPROVE or REQUEST_CHANGES.

Write report to c:/TgHelp/.agents/m3_reviewer_2/report.md and handoff to c:/TgHelp/.agents/m3_reviewer_2/handoff.md.
Notify parent orchestrator with your verdict via send_message.
