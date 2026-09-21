# BRIEFING — 2026-09-21T08:50:35Z

## Mission
Investigate and design TelegramRenderer, HtmlSanitizer, and multi-message splitting for Milestone 3 publishing pipeline.

## 🔒 My Identity
- Archetype: explorer
- Roles: teamwork_preview_explorer
- Working directory: c:/TgHelp/.agents/m3_explorer_2
- Original parent: 6f35b072-3fac-43df-87fc-95e48993acc2
- Milestone: Milestone 3

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Follow AGENTS.md §15, §16, §17, §18
- Canonical rendering pipeline: Preview and Publication MUST use the exact same renderer
- Allowed Telegram HTML tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>
- Strict Telegram limits (caption 1024, message 4096)

## Current Parent
- Conversation ID: 6f35b072-3fac-43df-87fc-95e48993acc2
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `src/common/constants/telegram-limits.ts` (caption 1024, text 4096, media group 2..10)
  - `AGENTS.md` (§15, §16, §17, §18, §23)
  - `tasks.md` (§15, §16, §17, §18)
  - `prisma/schema.prisma` (Post, PostTemplate, PostMedia, PublicationJob)
  - `prisma/seed.ts` (6 seeded templates: longread, announcement, photo, video, news, freeform)
  - `tests/unit/` (156 passing unit tests)
  - `tests/e2e/` (34 passing E2E tests, including HTML sanitization and partial publishing resume)
- **Key findings**:
  - `HtmlSanitizer` must use a stack-based algorithm to ensure tag balancing and protocol validation (`https://`, `http://`, `tg://` on `<a>`), with safe entity escaping for `<`, `>`, `&`.
  - `TelegramRenderer` must be a unified application service in `src/modules/rendering/` used by both bot preview and publication worker.
  - Multi-message splitting must handle media caption overflow (>1024) into Message 1 (Media/Media Group with summary $\le 1024$) and Message 2 (Body text $\le 4096$), with automatic HTML tag balancing across split boundaries.
  - `TelegramPayload` structured with part indices and stored in `publication_jobs.telegram_message_ids` enables safe partial publishing resumes.
- **Unexplored areas**: None for this milestone. Complete specification documented in `report.md` and `handoff.md`.

## Key Decisions Made
- Designed deterministic `HtmlSanitizer` and `HtmlSplitter` in native TypeScript without external dependencies.
- Standardized `TelegramPayload` discriminated union types across all outgoing Telegram message forms (`text`, `photo`, `video`, `document`, `animation`, `media_group`).
- Formulated partial publishing worker resume algorithm using PostgreSQL `publication_jobs.telegram_message_ids`.

## Artifact Index
- `c:/TgHelp/.agents/m3_explorer_2/DISPATCH.md` — Dispatch logs
- `c:/TgHelp/.agents/m3_explorer_2/progress.md` — Liveness heartbeat and progress tracking
- `c:/TgHelp/.agents/m3_explorer_2/report.md` — Detailed investigation report
- `c:/TgHelp/.agents/m3_explorer_2/handoff.md` — 5-component handoff report
