# Environment & Repository Survey Report

**Project**: Telegram Content Publisher Bot MVP  
**Investigator**: explorer_1  
**Timestamp**: 2026-09-21T03:40:00Z  
**Workspace**: `c:/TgHelp`

---

## 1. Executive Summary

The project workspace `c:/TgHelp` is currently a pristine greenfield repository containing the authoritative rulebook (`AGENTS.md`) and the comprehensive product/technical specification (`tasks.md`). No source code, build manifests, package configurations, or container files exist yet.

The local system environment has been thoroughly surveyed and tested:
- **Node.js**: `v24.14.1` (satisfies the `Node.js 22+` constraint from `AGENTS.md`).
- **npm**: `11.16.0`.
- **Git**: `2.51.0.windows.1` installed; git repository is not yet initialized.
- **Docker**: Docker CLI `29.8.0` and Compose `v5.5.1` are installed. However, Docker Desktop engine is inactive due to Windows headless / Session 0 isolation preventing the GUI launcher.
- **Active Backend Services (PostgreSQL & Redis)**:
  - **PostgreSQL 18** is active in WSL2 and forwarded to Windows host at `127.0.0.1:5432`. Dedicated role `tghelp` and database `tghelp` have been provisioned and verified.
  - **Redis 8.0.5** is active in WSL2 and forwarded to Windows host at `127.0.0.1:6379`. Direct TCP connection and Node.js ping (`+PONG`) verified.

The development environment is immediately primed for project scaffolding and implementation.

---

## 2. Workspace Layout & Existing Assets

### 2.1 File System Inspection (`c:/TgHelp`)

| File / Path | Size | Description |
|---|---|---|
| `AGENTS.md` | 38,321 bytes | Mandatory implementation standards: architecture, post state machine, idempotency, strict typing, error handling, testing. |
| `tasks.md` | 21,887 bytes | Functional requirements for MVP: roles, draft wizard with autosave, review flow, scheduling, BullMQ publishing. |
| `.agents/` | Directory | Teamwork agent metadata directory (`ORIGINAL_REQUEST.md`, agent briefs, handoffs). |

### 2.2 Missing Project Scaffolding
- **Package Manifest**: No `package.json` or lockfiles (`package-lock.json`).
- **TypeScript Configuration**: No `tsconfig.json` or `tsconfig.build.json`.
- **NestJS Configuration**: No `nest-cli.json`.
- **Docker**: No `docker-compose.yml` or `Dockerfile`.
- **Environment**: No `.env` or `.env.example`.
- **Source Code**: No `src/`, `prisma/`, or `test/` directories.
- **Git**: Not initialized (`.git` does not exist).

---

## 3. System Tools & Runtime Environment

### 3.1 Tool Versions

| Tool | Version / Status | Command Run | Output | Compliance / Notes |
|---|---|---|---|---|
| **Node.js** | `v24.14.1` | `node -v` | `v24.14.1` | Meets `Node.js 22+` requirement in `AGENTS.md`. |
| **npm** | `11.16.0` | `npm -v` | `11.16.0` | Modern npm with workspaces and npx support. |
| **Git** | `2.51.0.windows.1` | `git --version` | `git version 2.51.0.windows.1` | Git installed; repository not initialized (`fatal: not a git repository`). |
| **Docker CLI** | `29.8.0` | `docker -v` | `Docker version 29.8.0, build 88096ef` | Available. |
| **Docker Compose** | `v5.5.1` | `docker compose version` | `Docker Compose version v5.5.1` | Available. |
| **Docker Daemon** | Stopped / Inactive | `docker ps` | `failed to connect to docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Windows Session 0 / non-interactive context causes `Docker Desktop.exe` GUI to exit. |
| **WSL 2** | `Ubuntu (Running)`, `docker-desktop (Stopped)` | `wsl -l -v` | Ubuntu v2 Running | WSL2 subsystem active and operational. |

### 3.2 Service Availability & Connectivity

1. **PostgreSQL**:
   - Running cluster: PostgreSQL 18 (`18/main`) inside WSL2 Ubuntu on port `5432`.
   - Windows host TCP test: `Test-NetConnection -ComputerName localhost -Port 5432` -> `TcpTestSucceeded : True`.
   - Isolation & Credentials:
     - Dedicated Role: `tghelp` (PASSWORD: `tghelp_pass`)
     - Dedicated Database: `tghelp`
     - Connection URI: `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public`
   - Verified via `psql`: `SELECT current_database(), current_user;` -> `tghelp | tghelp`.

2. **Redis**:
   - Running daemon: Redis 8.0.5 (`redis-server`) inside WSL2 Ubuntu on port `6379`.
   - Windows host TCP test: `Test-NetConnection -ComputerName localhost -Port 6379` -> `TcpTestSucceeded : True`.
   - Verified via Node.js on Windows:
     ```bash
     node -e "const net = require('net'); const client = net.createConnection({ port: 6379, host: '127.0.0.1' }, () => client.write('PING\r\n')); client.on('data', d => { console.log(d.toString()); client.end(); });"
     # Output: +PONG
     ```
   - Connection URI: `redis://127.0.0.1:6379`.

---

## 4. Scaffolding & Architectural Blueprint

In accordance with `AGENTS.md` and `tasks.md`, the project must be scaffolded with clean module separation, strict typing, and resilient infrastructure.

### 4.1 Dependency Architecture

#### Core Production Dependencies
- **Framework**: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config`
- **Telegram Transport**: `grammy`, `@grammyjs/runner` (or webhook/polling adapter)
- **Persistence & ORM**: `@prisma/client`, `prisma`
- **Queues & Async Jobs**: `bullmq`, `@nestjs/bullmq`, `ioredis`
- **Validation & Serialization**: `class-validator`, `class-transformer` or `zod`
- **Timezone & Dates**: `luxon` (supports `Europe/Kyiv` and absolute `TIMESTAMPTZ` conversions)
- **Security & Sanitization**: Telegram HTML sanitizer / validator

#### Development & Testing Dependencies
- **Nest CLI & Tools**: `@nestjs/cli`, `@nestjs/schematics`, `@nestjs/testing`
- **TypeScript**: `typescript` (strict mode), `ts-node`, `@types/node`
- **Testing**: `jest`, `ts-jest`, `@types/jest`, `supertest`, `@types/supertest`
- **Quality**: `eslint`, `prettier`

> **Note on Node v24 Engine Warnings**: During CLI testing (`npx @nestjs/cli@12.0.3`), npm reported `@angular-devkit/core` engine recommendations for Node 24.15+. Scaffolding via a direct, fully-defined `package.json` with tested dependency ranges is strongly recommended over interactive CLI prompts.

### 4.2 Module Layout (`src/`)

```text
src/
├── main.ts
├── app.module.ts
├── modules/
│   ├── auth/              # Telegram ID resolution, user verification
│   ├── users/             # User service, system roles (SUPER_ADMIN, EDITOR, AUTHOR)
│   ├── roles/             # Channel-level permission checks
│   ├── channels/          # Channel registry, timezone, chat ID
│   ├── posts/             # Post domain service, state machine, OCC version check
│   ├── templates/         # Post templates (News, Article, Digest), schema validation
│   ├── media/             # Media storage references (file_id reuse, grouping)
│   ├── reviews/           # Review workflow (submit, approve, request revision, reject)
│   ├── publishing/        # Publication coordinator, idempotency key generation
│   ├── scheduling/        # Date parsing with Europe/Kyiv timezone, scheduling jobs
│   ├── notifications/     # Event-driven bot notifications for authors/editors
│   ├── audit/             # Append-only audit logger
│   └── telegram/          # grammY bot setup, update handlers, interactive wizard
├── infrastructure/
│   ├── database/          # PrismaService, transaction management
│   ├── redis/             # Redis connection manager
│   ├── queues/            # BullMQ publishing queue, worker, retry backoff
│   ├── logger/            # Contextual structured logging
│   ├── config/            # Startup environment validation (fail-fast)
│   └── telegram-api/      # Telegram Bot API client wrapper
└── common/
    ├── constants/         # telegram-limits.ts
    ├── enums/             # PostStatus, Role, MediaType, AuditEvent
    ├── dto/               # Strict DTOs for commands and requests
    ├── guards/            # Permission and authorization guards
    ├── exceptions/        # Domain and infrastructure exceptions
    └── utils/             # Telegram HTML sanitizer, date converters
```

### 4.3 Database Schema & Invariants (`prisma/schema.prisma`)

Key entities required by the specification:
1. `User`: `id` (UUID), `telegram_user_id` (BigInt, unique), `system_role` (`SUPER_ADMIN`, `EDITOR`, `AUTHOR`), `is_active`.
2. `Channel`: `id`, `telegram_chat_id` (String/BigInt, unique), `title`, `timezone` (default `Europe/Kyiv`), `is_active`.
3. `ChannelMember`: `id`, `user_id`, `channel_id`, `role`, `can_publish`, `can_approve` (compound unique `[user_id, channel_id]`).
4. `PostTemplate`: `id`, `key` (unique), `name`, `schema_json`, `rendering_config_json`.
5. `Post`:
   - `id` (UUID)
   - `channel_id`, `author_id`, `template_id`
   - `title`, `content_json`
   - `status`: `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`
   - `version` (Int, default 1) — mandatory for Optimistic Concurrency Control (OCC)
   - `scheduled_at` (DateTime, TIMESTAMPTZ)
   - `published_at` (DateTime)
   - `deleted_at` (DateTime, soft delete support)
6. `Media`: `id`, `post_id`, `telegram_file_id`, `telegram_file_unique_id`, `media_type`, `file_name`, `sort_order`.
7. `Review`: `id`, `post_id`, `reviewer_id`, `action`, `comment`, `created_at`.
8. `PublicationJob`:
   - `id` (UUID)
   - `post_id`, `post_version`
   - `idempotency_key` (unique): `publish:{post_id}:{post_version}`
   - `status`: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`
   - `attempt_count`, `telegram_message_ids_json`, `last_error`
9. `AuditLog`: `id`, `actor_id`, `event_type`, `entity_type`, `entity_id`, `payload_json`, `created_at`.

### 4.4 Containerization Strategy (`docker-compose.yml`)

Even though local WSL2 services provide instant zero-friction PostgreSQL and Redis on localhost, standard `docker-compose.yml` must be supplied to satisfy Requirement R3:
- Service `postgres`: `postgres:17-alpine`, ports `5432:5432`, environment variables, healthcheck.
- Service `redis`: `redis:7-alpine`, ports `6379:6379`, healthcheck.
- Clear setup documentation in `README.md` explaining both:
  1. Docker Compose workflow for standard containerized environments.
  2. Native / WSL2 direct connection workflow for environments where Docker Desktop daemon is not running.

---

## 5. Implementation Roadmap for Orchestrator

1. **Step 1: Scaffolding & Configuration**
   - Initialize Git repository and `.gitignore`.
   - Create `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`.
   - Install dependencies (`npm install`).
   - Create `docker-compose.yml`, `.env.example`, and `.env`.
2. **Step 2: Database Layer & Prisma**
   - Create `prisma/schema.prisma` with all required models and indices.
   - Run `npx prisma generate` and `npx prisma db push` or initial migration.
   - Implement seed script (`prisma/seed.ts`) populating default post templates and Super Admin user.
3. **Step 3: Core Domain & Infrastructure Services**
   - Implement `PrismaService`, `ConfigService` (fail-fast validation).
   - Implement `PostWorkflowService` (state machine transitions, OCC version validation, audit logging).
   - Implement `RendererService` (canonical Telegram HTML rendering).
4. **Step 4: Queues, Worker & Idempotent Publishing**
   - Configure BullMQ queue and worker.
   - Implement `PublicationService` with database idempotency check (`publish:{post_id}:{version}`).
   - Support retry policies and partial publication resumption.
5. **Step 5: grammY Telegram Transport & Wizard**
   - Build bot transport module, role/permission guards, and command routing.
   - Implement interactive post creation wizard with step-by-step autosave.
   - Implement review and scheduling button workflows.
6. **Step 6: Automated Verification & Tests**
   - Unit tests: permissions, state machine, OCC conflicts, HTML sanitization, idempotency.
   - E2E tests: end-to-end draft creation -> autosave -> review -> approval -> scheduled publish -> simulated worker delivery.
