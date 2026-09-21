# Handoff Report: Functional Specification & Feature Inventory

**Agent:** `spec_miner_1` (Teamwork Specification Miner)  
**Task ID:** spec_miner_1  
**Recipient:** `parent` (`orchestrator_1` / `6f35b072-3fac-43df-87fc-95e48993acc2`)  
**Timestamp:** 2026-09-21T03:35:30Z  
**Type:** Hard Handoff (Task Complete)

---

## 1. Observation

1. **Authoritative Specification Inputs:**
   - `c:/TgHelp/.agents/ORIGINAL_REQUEST.md` (Lines 11, 18–26, 29–42):
     > "Build a Telegram Content Publisher Bot MVP with role-based access, draft autosave, a structured review workflow, and queued idempotent publishing to a Telegram channel."
     > R1: Core Bot & Publishing Flow (Telegram ID auth, RBAC Super Admin/Editor/Author, wizard autosave, state machine, BullMQ).
     > R2: PostgreSQL/Prisma single source of truth, separation of transport and business logic, OCC versioning.
   - `c:/TgHelp/tasks.md` (Lines 20–48, 76–93, 98–179, 182–237, 290–367, 412–437, 440–487, 489–531, 533–591, 624–670, 672–767, 809–856):
     > Defines 10 post states (`DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `PUBLISH_FAILED`, `CANCELLED`) and exact allowed transitions.
     > Defines channel fields, `Europe/Kyiv` default timezone, `channel_members` role structure (`EDITOR`, `AUTHOR`, `VIEWER`), and `can_publish`, `can_approve` flags.
     > Outlines wizard flow steps 1 to 6, autosave at every step to PostgreSQL, modular field editing, templates schema, canonical renderer, BullMQ publication queue, idempotency key `publish:{post_id}:{post_version}`, partial publishing resume with `telegram_message_ids`, and append-only audit logs.
   - `c:/TgHelp/AGENTS.md` (Lines 78–117, 309–331, 334–398, 439–464, 468–496, 500–569, 609–662, 703–784, 808–853, 2105–2123):
     > Invariants: Telegram as transport layer only; handlers do not contain business logic; server-side permission checks; OCC with `WHERE id = ? AND version = ?`; canonical `TelegramRenderer` producing `TelegramPayload`; Telegram limits centralized; BullMQ worker idempotency and partial publication resilience; append-only audit logs; safe retries with backoff; stale Telegram UI protection.

2. **Artifact Produced:**
   - `c:/TgHelp/.agents/spec_miner_1/report.md` (14 sections, ~480 lines) containing complete functional specification, dual-tier RBAC matrix, FSM state diagram and transition table, wizard UX step breakdown, template schema JSON, canonical rendering pipeline, Prisma data model (10 models), 48 enumerated features (table with category, description, inputs, outputs, errors, source), 20 concrete edge cases/failure modes, and a 4-tier verification matrix.

---

## 2. Logic Chain

1. *From Observation 1 (`tasks.md` §4, §5 & `AGENTS.md` §8, §9):* Authentication relies solely on Telegram ID (bigint) and permissions are evaluated on both system level (`users.system_role`) and channel level (`channel_members`). Storing or relying on client-side Telegram state or UI buttons is forbidden. Therefore, Feature F-01, F-02, and F-03 specify strict server-side resolution and RBAC validation.
2. *From Observation 1 (`tasks.md` §6 & `AGENTS.md` §10):* The 10 post statuses and explicit transitions dictate a formal Finite State Machine managed exclusively by `PostWorkflowService`. Invalid transitions must trigger explicit domain exceptions. Atomic PostgreSQL transactions must bundle status changes, review records, and audit events.
3. *From Observation 1 (`tasks.md` §9, §10, §12 & `AGENTS.md` §11, §12, §13):* The post creation wizard requires autosave after every completed field or step directly to PostgreSQL. In-memory sessions are strictly forbidden as sources of truth. To prevent concurrent editing conflicts between editors and authors, OCC with `version INTEGER` is mandatory.
4. *From Observation 1 (`tasks.md` §14, §15, §16 & `AGENTS.md` §14, §15, §16, §17, §18):* Dynamic templates stored in `post_templates` decouple UI from post structure. A single canonical renderer (`TelegramRenderer`) produces `TelegramPayload` (supporting multi-message payloads when media groups and text exceed limits), ensuring preview and publication never diverge.
5. *From Observation 1 (`tasks.md` §19, §20, §21, §22, §23 & `AGENTS.md` §20, §21, §22, §23, §24, §25):* Direct Telegram publication from callback handlers is strictly prohibited. Publication must flow through BullMQ workers with database-enforced unique idempotency keys (`publish:{post_id}:{post_version}`), preflight validation, exponential backoff retries, and recording of `telegram_message_ids` to support safe partial publication resume without duplicate channel posts.
6. *From Observation 1 & 2:* Synthesizing these rules yields 48 granular features and 20 edge cases that fully define the MVP product boundaries.

---

## 3. Caveats

1. **Non-MVP Boundaries:** As noted in `tasks.md` §2.1 and `AGENTS.md` §81, web frontend, AI assistants, Google Drive/Sheets integration, RSS, visual template builder, and Stories are out of scope for MVP. The schema and architecture support them as future extension points without premature implementation.
2. **Channel Selection UI:** For users with access to multiple channels, an inline selection keyboard is specified; if the user has access to exactly 1 channel, Step 1 is bypassed automatically.
3. **Draft Cleanup:** Soft delete (`deleted_at`) is specified for draft deletion; physical DB deletion of published posts or audit records is strictly prevented.

---

## 4. Conclusion

The functional specification and complete feature inventory for the Telegram Content Publisher Bot MVP are fully mined, verified against authoritative sources (`tasks.md`, `AGENTS.md`, and `ORIGINAL_REQUEST.md`), and documented in `c:/TgHelp/.agents/spec_miner_1/report.md`. The design provides an unambiguous foundation for the architecture and milestone breakdown in `c:/TgHelp/.agents/PROJECT.md`.

---

## 5. Verification Method

To independently verify the completeness and accuracy of this specification:
1. Inspect `c:/TgHelp/.agents/spec_miner_1/report.md`.
2. Cross-reference Section 4 (State Transition Table) with `tasks.md` §6 and `AGENTS.md` §10.
3. Cross-reference Section 11 (Prisma Schema) with `tasks.md` §25 and `AGENTS.md` §4, §11, §19, §21, §26.
4. Cross-reference Section 12 (Features Discovered Table, F-01 to F-48) with `tasks.md` sections 1 through 36 and `ORIGINAL_REQUEST.md`.
5. Cross-reference Section 13 (Edge Cases E-01 to E-20) with `AGENTS.md` critical invariants (§83) and acceptance scenarios in `tasks.md` §35.
