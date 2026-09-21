# Original User Request

## 2026-09-21T03:32:36Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: [none — teamwork routes from the description]

Build a Telegram Content Publisher Bot MVP with role-based access, draft autosave, a structured review workflow, and queued idempotent publishing to a Telegram channel.

Working directory: c:/TgHelp
Integrity mode: development

## Requirements

### R1. Core Bot & Publishing Flow
Implement the Telegram bot MVP according to the AGENTS.md rules and tasks.md spec. The bot must support authorization by Telegram ID, role-based access control (Super Admin, Editor, Author), and an interactive post creation wizard with autosave. Posts must go through a structured state machine (DRAFT → PENDING_REVIEW → APPROVED → PUBLISHING → PUBLISHED) and be sent to Telegram reliably using BullMQ workers.

### R2. Data Persistence & Architecture
Use PostgreSQL (via Prisma) as the single source of truth for users, channels, permissions, post templates, post states, media, and audit logs. The architecture must strictly separate Telegram transport logic from business logic. All state transitions must use optimistic concurrency control.

### R3. Development Infrastructure
Provide a `docker-compose.yml` that provisions PostgreSQL and Redis. Document the local setup process so the bot can be run and verified locally.

## Acceptance Criteria

### Security & State
- [ ] Users without proper permissions are rejected immediately upon `/start`.
- [ ] Draft progress is saved to PostgreSQL after every completed step in the wizard (in-memory session is not the source of truth).
- [ ] State transitions (e.g. DRAFT to PENDING_REVIEW) are managed by a domain service and logged to an audit table.

### Publishing & Idempotency
- [ ] The Telegram API is never called directly from a callback handler; publication is always executed via a BullMQ worker.
- [ ] Repeatedly triggering "Publish" on an approved post results in only a single publication, enforced via unique idempotency keys in the database.
- [ ] In the event of a simulated Telegram API failure, the worker correctly retries and ultimately marks the post as PUBLISH_FAILED if retries are exhausted.

### Verification
- [ ] Unit tests pass for permission rules, state transitions, HTML sanitization, and publication idempotency.
- [ ] Programmatic E2E tests pass, verifying the complete workflow from draft creation to successful simulated publication.
