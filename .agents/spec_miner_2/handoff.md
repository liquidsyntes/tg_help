# Handoff Report — spec_miner_2

**Agent**: `spec_miner_2` (teamwork_preview_spec_miner)  
**Parent Agent**: `orchestrator_1` / parent (`6f35b072-3fac-43df-87fc-95e48993acc2`)  
**Task**: Survey and document architectural constraints, database schemas, queue behaviors, concurrency rules, and validation standards for the Telegram Content Publisher Bot MVP.  
**Deliverable File**: `c:/TgHelp/.agents/spec_miner_2/report.md`

---

## 1. Observation

Direct observations from the authoritative specifications:

1. **Mandatory User Requirements & Acceptance Criteria** (`c:/TgHelp/.agents/ORIGINAL_REQUEST.md`):
   - Lines 18-20: *"Implement the Telegram bot MVP according to the AGENTS.md rules and tasks.md spec. The bot must support authorization by Telegram ID, role-based access control (Super Admin, Editor, Author), and an interactive post creation wizard with autosave. Posts must go through a structured state machine (DRAFT → PENDING_REVIEW → APPROVED → PUBLISHING → PUBLISHED) and be sent to Telegram reliably using BullMQ workers."*
   - Lines 21-23: *"Use PostgreSQL (via Prisma) as the single source of truth for users, channels, permissions, post templates, post states, media, and audit logs. The architecture must strictly separate Telegram transport logic from business logic. All state transitions must use optimistic concurrency control."*
   - Lines 30-38: Explicit acceptance criteria: Users rejected on `/start` if unauthorized; draft saved to PostgreSQL after every step; state transitions managed by domain service with audit table; Telegram API never called directly from callbacks (BullMQ only); unique idempotency keys in DB (`publish:{postId}:{version}`); worker retries with backoff and marks `PUBLISH_FAILED` if retries exhaust.

2. **Core Architectural Principle & Dependency Direction** (`c:/TgHelp/AGENTS.md`):
   - Lines 79-83: *"Telegram is a transport layer. Telegram handlers must NOT contain core business logic."*
   - Lines 87-94: Prescribed flow: `Telegram Update -> Telegram Handler -> Application / Domain Service -> Repository / Queue / Integration`.
   - Lines 180-192: Dependency direction: `Transport -> Application -> Domain / business rules -> Infrastructure interfaces -> Concrete infrastructure`.
   - Lines 198-208: Handlers must pass command DTOs (`ApprovePostCommand`) rather than `ctx: Context` into business services.
   - Lines 1763-1783: Worker separation — `app` and `worker` must be runnable as independent processes via Docker Compose.

3. **Database as Single Source of Truth & Concurrency** (`c:/TgHelp/AGENTS.md` & `tasks.md`):
   - AGENTS.md Lines 401-436: Database is the durable source of truth; application must survive restart, worker crash, Redis reconnect; Redis is only for cache/locks/queues.
   - AGENTS.md Lines 468-496: Optimistic Concurrency Control — `posts` table must include `version INTEGER` and updates must check `WHERE id = ? AND version = ?`.
   - tasks.md Lines 809-828: Core tables required: `users`, `channels`, `channel_members`, `posts`, `post_templates`, `post_media`, `post_reviews`, `publication_jobs`, `audit_logs`, and recommended `post_versions`.

4. **Wizard Autosave Pattern** (`c:/TgHelp/AGENTS.md` & `tasks.md`):
   - AGENTS.md Lines 440-464: Draft creation is incremental; after each step (title, body, media, metadata) save to PostgreSQL; do not wait until wizard completion.
   - tasks.md Lines 317-320: *"После каждого успешно заполненного шага изменения автоматически записываются в PostgreSQL. In-memory session не является источником истины."*

5. **Publishing Queue, Idempotency & Partial Publication** (`c:/TgHelp/AGENTS.md` & `tasks.md`):
   - AGENTS.md Lines 698-724: Never publish directly from Telegram callback handlers; user action -> BullMQ -> worker -> Telegram API.
   - AGENTS.md Lines 728-754: Idempotency identity `publish:{post_id}:{post_version}` enforced via database unique constraint.
   - AGENTS.md Lines 787-804 & tasks.md Lines 755-766: Partial publication tracking — store `telegram_message_ids` after each API call to allow safe resumption without duplicate sends.

6. **HTML Sanitization & Limits** (`c:/TgHelp/AGENTS.md`):
   - Lines 609-636: Supported Telegram HTML tags strictly controlled (`b`, `i`, `u`, `s`, `code`, `pre`, `a`, `blockquote`); sanitization and tag balancing required.
   - Lines 639-663: Telegram limits centralized in `src/common/constants/telegram-limits.ts`.

---

## 2. Logic Chain

1. **From Observation 1 & 2**: Because Telegram updates are inherently transport-level JSON packets and grammY handlers are transport adapters, placing business logic in handlers tightly couples business rules to Telegram and prevents independent queue worker execution. Therefore, application services must accept plain domain commands and DTOs with typed primitives (`TelegramUserId = bigint`), and `app` and `worker` must be separate runtimes.
2. **From Observation 1, 3 & 4**: Because server processes or containers may restart at any moment during user wizard interaction, relying on memory or Redis for drafts would cause data loss. Therefore, each completed wizard step must write directly to PostgreSQL with an atomic version increment.
3. **From Observation 3**: Because multiple editors or authors can edit or review the same post simultaneously, concurrent edits without locking cause lost updates. By implementing Optimistic Concurrency Control (`version` column with atomic `WHERE version = :expected`), conflicting edits are detected immediately and rejected with `PostConflictException`.
4. **From Observation 1 & 5**: Because Telegram webhook callbacks and user button clicks can be redelivered or triggered repeatedly, and BullMQ guarantees at-least-once delivery, publication cannot rely on ephemeral locks. Therefore, a durable database table `publication_jobs` with a `UNIQUE` constraint on `idempotency_key` (`publish:{postId}:{version}`) is necessary and sufficient to guarantee exactly-once publication.
5. **From Observation 5**: Because Telegram publications with both media groups and long text require multiple distinct API calls (`sendMediaGroup` followed by `sendMessage`), a network failure between calls would cause duplicates if re-executed from scratch. Storing each successfully dispatched message ID in `publication_jobs.telegram_message_ids` allows the worker to resume safely without re-dispatching already sent messages.
6. **From Observation 6**: Telegram's Bot API rejects malformed HTML with HTTP 400 Bad Request, crashing unsanitized publication attempts. Centralizing validation in an HTML sanitization engine and centralizing Telegram limits prevents unexpected runtime failures during publishing.

---

## 3. Caveats

1. **External S3 / File Storage**: Storing media files locally or on S3 is explicitly out of scope for MVP (tasks.md § 2.1). Instead, the system reuses Telegram's native `file_id` and `file_unique_id`.
2. **Future Web Panel & AI**: Advanced analytics, web dashboard, and AI integrations are planned for post-MVP; the architecture defines clean extension boundaries (Application Services) without prematurely implementing web controllers or AI modules.
3. **Database Migrations in Staging/Dev**: The schema uses PostgreSQL UUIDs for primary keys and `BigInt` for Telegram IDs; SQLite cannot be substituted because `BigInt`, JSONB, and TIMESTAMPTZ support differs.

---

## 4. Conclusion

The architectural blueprint and specification for the Telegram Content Publisher Bot MVP is fully mapped and documented in `c:/TgHelp/.agents/spec_miner_2/report.md`.

Key components established:
1. **Separation of Concerns**: Transport (grammY) $\to$ Application (Commands/Services) $\to$ Domain (Entities/State Machine) $\to$ Infrastructure (Prisma/Redis/BullMQ).
2. **PostgreSQL Schema**: Complete Prisma schema with 10 entities (`User`, `Channel`, `ChannelMember`, `PostTemplate`, `Post`, `PostMedia`, `PostReview`, `PostVersion`, `PublicationJob`, `AuditLog`).
3. **State Machine & OCC**: 10 distinct post statuses with strict transitions, atomic version checks on update, and short-lived database transactions.
4. **Resilient Publishing**: Asynchronous BullMQ worker execution with deterministic idempotency keys (`publish:{postId}:{version}`), exponential backoff retries, and partial publication resume using persisted message IDs.
5. **Autosave**: Step-by-step persistence to PostgreSQL ensuring zero data loss on restart.
6. **Testing Matrix**: Granular requirements for unit, integration, and full-lifecycle E2E tests.

---

## 5. Verification Method

To independently verify these conclusions and validate subsequent implementation:

1. **Document Inspection**:
   - Inspect `c:/TgHelp/.agents/spec_miner_2/report.md` for the complete Prisma schema, module layout, and the 30 discovered features and 18 edge cases.
   - Inspect `c:/TgHelp/AGENTS.md` and verify all referenced rule numbers (§ 1 through § 84) align with the documented architectural guidelines.
   - Inspect `c:/TgHelp/tasks.md` and verify that the lifecycle states, role capabilities, wizard steps, and acceptance criteria correspond exactly.

2. **Schema & Code Validation (Post-Implementation)**:
   - Run `npx prisma validate` to confirm schema integrity.
   - Run `npx prisma migrate dev` against local PostgreSQL container.
   - Run unit tests: `npm test` verifying OCC conflict exceptions, HTML sanitization, and transition rules.
   - Run E2E tests: `npm run test:e2e` confirming the complete lifecycle from draft creation to simulated BullMQ publication.

3. **Invalidation Conditions**:
   - Any implementation where a Telegram handler directly executes `prisma.post.create` or `bot.api.sendMessage` for publishing.
   - Any implementation storing draft state exclusively in Node.js memory or Redis sessions without immediate PostgreSQL writes.
   - Any publication job lacking a unique database-backed idempotency key.
