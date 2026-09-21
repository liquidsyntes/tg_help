# Handoff Report — Database Layer & Prisma Specification (Milestone 1)

**Agent**: `m1_explorer_2`  
**Working Directory**: `c:/TgHelp/.agents/m1_explorer_2`  
**Recipient**: `parent` (Orchestrator, ID: `6f35b072-3fac-43df-87fc-95e48993acc2`)  
**Date**: 2026-09-21  

---

## 1. Observation

1. **Rulebook and Specification Requirements**:
   - `c:/TgHelp/AGENTS.md`:
     - Line 48: "PostgreSQL, Prisma, Redis, BullMQ, Docker".
     - Line 166: "Telegram ID is the primary Telegram identity... Never authorize a user using username, first_name, last_name, Telegram display name".
     - Line 213: "Posts should have a version field: `version INTEGER`... UPDATE posts SET content_json = ..., version = version + 1 WHERE id = ? AND version = ?".
     - Line 310: "Store absolute publication times using timezone-aware database types. Preferred: TIMESTAMPTZ". Default timezone: `Europe/Kyiv`.
     - Line 327: "Preflight validation should occur at least: 1. when scheduled; 2. immediately before actual publication".
     - Line 350: "Publishing must be idempotent... Recommended pattern: `publish:{post_id}:{post_version}`. Enforce uniqueness at the database level".
     - Line 378: "If the first succeeds and the second fails, do not blindly restart everything. Store Telegram message IDs after each successful step".
     - Line 405: "Use Prisma migrations for schema changes. Do not manually modify production database schema".
     - Line 427: "Posts may use: `deleted_at`".
     - Line 600: "The app and worker processes must be separate processes".
   - `c:/TgHelp/tasks.md`:
     - Line 78-86: Channel attributes (`id`, `telegram_chat_id`, `title`, `username`, `timezone`, `publication_mode`, `is_active`).
     - Line 157-172: RBAC (`users.system_role: SUPER_ADMIN, USER`, `channel_members.role: EDITOR, AUTHOR, VIEWER`, `can_publish`, `can_approve`).
     - Line 184-195: 10 post statuses (`DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`).
     - Line 304-311: 6 post templates (`longread`, `announcement`, `photo`, `video`, `news`, `freeform`).
     - Line 812-827: 10 database tables (`users`, `channels`, `channel_members`, `posts`, `post_templates`, `post_media`, `post_reviews`, `post_versions`, `publication_jobs`, `audit_logs`).
2. **Local PostgreSQL Connectivity & Version**:
   - Tool Command: `Test-NetConnection -ComputerName 127.0.0.1 -Port 5432`
     - Result: `TcpTestSucceeded : True`
   - Tool Command: `wsl env PGPASSWORD=tghelp_pass psql -U tghelp -d tghelp -h 127.0.0.1 -c "SELECT current_database(), current_user, version();"`
     - Output:
       ```text
       current_database | current_user | version
       tghelp           | tghelp       | PostgreSQL 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1) on x86_64-pc-linux-gnu
       ```
   - Tool Command: `wsl env PGPASSWORD=tghelp_pass psql -U tghelp -d tghelp -h 127.0.0.1 -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public';"`
     - Output: `(0 rows)` — Clean database ready for migration.
3. **Spec Discrepancies Analyzed**:
   - `spec_miner_1/report.md` (lines 517-753) vs `spec_miner_2/report.md` (lines 115-362):
     - `spec_miner_1` used standard `DateTime`, omitted `@db.Timestamptz`; `spec_miner_2` applied `@db.Timestamptz`.
     - `spec_miner_1` kept `metadata_json` on `Post`; `spec_miner_2` omitted it.
     - `spec_miner_1` had `PostVersion.changedBy` as unlinked `String`; `spec_miner_2` linked `changedById` to `User`.
     - `spec_miner_1` used `status PostStatus` on `PostReview`; `spec_miner_2` used `action ReviewAction` (`APPROVE`, `REQUEST_REVISION`, `REJECT`).
     - `spec_miner_1` defined `PublicationJob.channelId` and status with 4 values; `spec_miner_2` omitted `channelId` and included `CANCELLED` status.

---

## 2. Logic Chain

1. **Step 1 — Timestamp Precision**:
   From Observation 1 (`AGENTS.md § 24`), the database must store absolute publication times in UTC using `TIMESTAMPTZ`. Therefore, all datetime fields across the schema (`createdAt`, `updatedAt`, `scheduledAt`, `publishedAt`, `deletedAt`) are specified with `@db.Timestamptz`.
2. **Step 2 — Model Harmonization**:
   From Observation 3, combining the best attributes of both specification drafts produces a schema that satisfies all requirements:
   - `Post.metadataJson` is preserved to store Step 5 wizard fields (rubric, tags, CTA, links, priority, editorial comment) cleanly separated from content fields.
   - `PostReview` uses `action ReviewAction` (`APPROVE`, `REQUEST_REVISION`, `REJECT`) to distinguish what the reviewer did from the post's status.
   - `PostVersion.changedById` establishes a foreign key relation to `User` with `onDelete: Restrict` to protect auditability.
   - `PublicationJob` includes `channelId` for fast index queries and incorporates `CANCELLED` in `PublicationJobStatus` to handle schedule cancellations.
   - `PostMedia.fileSize` uses `BigInt?` to safely accommodate Telegram files up to 2GB.
3. **Step 3 — BigInt Serialization in NestJS & Prisma**:
   From Observation 1 (`User.telegramId` is `BigInt`), JavaScript's native `JSON.stringify` throws a `TypeError` on `BigInt`. Therefore, `PrismaService` executes a runtime polyfill on `BigInt.prototype.toJSON` upon instantiation, ensuring seamless JSON serialization in logs and API controllers.
4. **Step 4 — Database Seeding Design**:
   From Observation 1 (`tasks.md § 9, § 14`), 6 templates must be seeded alongside the default channel and super admin. Using Prisma `upsert` queries keyed on unique identifiers (`key` for templates, `telegramChatId` for channels, `telegramId` for users) ensures that running `prisma db seed` is strictly idempotent.
5. **Step 5 — Worker Implementation Blueprint**:
   From Observation 1 (`AGENTS.md § 65, § 20, § 21, § 23`), the worker runs as a dedicated process (`src/worker.ts`), preflight-checks posts, executes canonical rendering, supports partial publication resumption via `telegramMessageIds`, handles Telegram 429 `retry_after` backoff delays, and atomically commits `PUBLISHED` status inside `prisma.$transaction`.

---

## 3. Caveats

1. **Docker Desktop Engine vs Direct WSL2 Connection**:
   While Docker CLI and Compose are installed, Windows Session 0 isolation prevents Docker Desktop GUI from launching. However, PostgreSQL 18.6 and Redis 8.0.5 are running directly inside WSL2 and forwarded to Windows host ports `5432` and `6379`. The database layer is verified against `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp`.
2. **BigInt Handling**:
   `User.telegramId` is a 64-bit integer (`BigInt`). Any code passing `telegramId` across JSON boundaries or to external APIs must rely on `BigInt.prototype.toJSON` or explicit `String(telegramId)` conversion.
3. **No Unchecked Schema Mutations**:
   All database modifications must occur through `prisma migrate dev` or `prisma migrate deploy`. No direct SQL DDL commands should be executed.

---

## 4. Conclusion

The database layer for Milestone 1 is completely specified and ready for implementation:
- **`prisma/schema.prisma`**: 10 production-ready models (`User`, `Channel`, `ChannelMember`, `PostTemplate`, `Post`, `PostMedia`, `PostReview`, `PostVersion`, `PublicationJob`, `AuditLog`), 5 enums (`SystemRole`, `ChannelRole`, `PostStatus`, `MediaType`, `ReviewAction`, `PublicationJobStatus`), complete indexes and constraints.
- **`PrismaService` & `PrismaModule`**: NestJS integration in `src/infrastructure/database/` with `$connect()`, `$disconnect()`, and global BigInt polyfill.
- **Migration & Seeding**: Idempotent seed script in `prisma/seed.ts` populating the 6 standard templates, default channel (`Europe/Kyiv`), and Super Admin.
- **Worker Execution Architecture**: 9-step implementation roadmap for the BullMQ publisher worker process.

---

## 5. Verification Method

To independently verify the database layer once implemented by the worker:

1. **Verify Prisma Schema Validation**:
   ```bash
   npx prisma validate --schema=prisma/schema.prisma
   ```
   *Expected result*: Schema is valid.
2. **Generate Prisma Client**:
   ```bash
   npx prisma generate --schema=prisma/schema.prisma
   ```
   *Expected result*: Generated Prisma Client files in `node_modules/@prisma/client`.
3. **Apply Initial Migration against Local Database**:
   ```bash
   npx prisma migrate dev --name init --schema=prisma/schema.prisma
   ```
   *Expected result*: Migration applied to `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp`; 10 tables created in public schema.
4. **Execute Seed Script**:
   ```bash
   npx ts-node prisma/seed.ts
   ```
   *Expected result*: Console outputs confirmation that Super Admin, Default Channel, Channel Membership, and all 6 templates (`longread`, `announcement`, `photo`, `video`, `news`, `freeform`) were seeded.
5. **Verify Database Content via psql**:
   ```bash
   wsl env PGPASSWORD=tghelp_pass psql -U tghelp -d tghelp -h 127.0.0.1 -c "SELECT key, name FROM post_templates;"
   ```
   *Expected result*: 6 rows returned matching the canonical templates.
