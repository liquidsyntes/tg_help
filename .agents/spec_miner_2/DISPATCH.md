## 2026-09-21T03:33:48Z

You are spec_miner_2, a teamwork_preview_spec_miner.
Your working directory is: c:/TgHelp/.agents/spec_miner_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/AGENTS.md

Your mission:
Extract all authoritative architectural constraints, design patterns, database requirements, queue behaviors, concurrency rules, and validation standards for the Telegram Content Publisher Bot MVP.
Analyze:
1. Architectural layers and dependency direction (Telegram transport vs Application vs Domain vs Infrastructure; no business logic in Telegram handlers).
2. Technology stack requirements: Node.js 22+, TypeScript strict mode, NestJS, grammY, PostgreSQL, Prisma, Redis, BullMQ, Docker.
3. Database design & source of truth: users, channels, channel_members, posts, post_versions, post_templates, media, audit_logs, publication_jobs.
4. Concurrency & state safety: Optimistic Concurrency Control (version field, atomic increment & check), database transactions.
5. Autosave architecture (persisting intermediate wizard steps to PostgreSQL, not just in-memory).
6. Publishing architecture: BullMQ workers, idempotency key pattern (publish:{postId}:{version}), retry strategy with exponential backoff, handling simulated/real Telegram API errors, partial publication recovery.
7. HTML sanitation and Telegram limits centralization.
8. Testing specifications: Unit, integration, E2E test requirements.

Write your detailed report to c:/TgHelp/.agents/spec_miner_2/report.md and a handoff report to c:/TgHelp/.agents/spec_miner_2/handoff.md.
When finished, use send_message to notify the parent orchestrator with a summary of findings and the path to your report.
