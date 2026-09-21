# Project Orchestrator Master Plan: Telegram Content Publisher Bot MVP

## 1. Survey Phase
- Spawn 3 parallel agents:
  - `teamwork_preview_spec_miner` (spec_miner_1): Mine tasks.md and ORIGINAL_REQUEST.md for all functional features, UX wizard flow, states, roles, channels, and limits.
  - `teamwork_preview_spec_miner` (spec_miner_2): Mine AGENTS.md for architectural patterns, NestJS/grammY conventions, Prisma schemas, BullMQ queue rules, idempotency, concurrency, and validation rules.
  - `teamwork_preview_explorer` (explorer_1): Explore current environment, check installed tools (node, npm, docker, postgres, redis), verify repository state, dependencies.

## 2. Architecture & Decomposition
- Synthesize survey findings into `c:/TgHelp/.agents/PROJECT.md` (and copy/maintain at project root if permitted).
- Establish Feature Inventory, Milestones, Interface Contracts, and Code Layout.
- Define Milestones:
  - M1: Foundation, NestJS bootstrap, Config, Docker-compose (Postgres & Redis), Prisma schema & initial migration/client.
  - M2: Domain Models & State Machine (Users, Channels, Permissions, Post State Machine with OCC versioning, Audit Logging).
  - M3: Publishing Queue Engine & Idempotency (BullMQ queue & worker, Telegram Publisher abstraction, simulated failure handling, retry/fail state).
  - M4: Telegram Transport & Interactive Wizard (grammY bot setup, step-by-step wizard with per-step autosave, preview rendering, review commands).
  - M5: E2E Verification & Adversarial Hardening (Unit tests, Programmatic E2E suite covering complete workflow, adversarial test tier).

## 3. Parallel Tracks Execution
- Implementation Track: Execute milestones via sub-orchestrators or Explorer -> Worker -> Reviewer -> Challenger -> Auditor cycle.
- E2E Testing Track: Build test runner and test cases (Tiers 1-4) derived strictly from user requirements.
- Final Milestone: Pass 100% E2E tests + Tier 5 adversarial coverage hardening.

## 4. Final Handover
- Comprehensive verification confirmation and completion report to Sentinel.
