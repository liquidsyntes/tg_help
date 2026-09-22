````md
# DECISIONS.md

# Architecture and Engineering Decisions

This document records important architectural and engineering decisions for the
Telegram Content Publisher Bot.

The purpose of this file is to preserve the reasoning behind major choices so
future contributors and AI coding agents understand not only WHAT the system
does, but WHY it is designed this way.

This file should contain decisions that materially affect:

- architecture;
- data integrity;
- publishing reliability;
- permissions;
- concurrency;
- deployment;
- persistence;
- integrations;
- extensibility;
- developer workflow.

Minor implementation details do not need to be recorded here.

---

# Decision Statuses

Use one of the following statuses:

```text
Proposed
Accepted
Superseded
Deprecated
Rejected
````

---

# Decision Template

New decisions should follow this structure:

```md
## ADR-XXX: Decision title

Status: Accepted
Date: YYYY-MM-DD

### Context

What problem or constraint required a decision?

### Decision

What was chosen?

### Alternatives considered

What other approaches were considered?

### Rationale

Why was this option selected?

### Consequences

What becomes easier or harder because of this decision?

### Revisit when

Under what conditions should this decision be reconsidered?
```

---

# ADR-001: Use NestJS as the Backend Framework

Status: Accepted

### Context

The project requires more than a simple Telegram bot.

The backend must support:

* users;
* roles and permissions;
* posts;
* templates;
* media;
* review workflow;
* scheduled publication;
* queues;
* audit logging;
* notifications;
* future REST API;
* future web frontend;
* future AI integrations.

A minimal event-handler-based application would likely become difficult to
maintain as these capabilities grow.

### Decision

Use:

```text
NestJS
+
TypeScript
```

as the primary backend framework.

### Alternatives considered

* plain Node.js;
* Express;
* Fastify without NestJS;
* grammY-only application;
* Python + FastAPI;
* Python + aiogram.

### Rationale

NestJS provides:

* modular architecture;
* dependency injection;
* guards;
* configuration management;
* integration patterns;
* testability;
* background worker compatibility;
* REST API support;
* clear separation between transport and business logic.

This fits the expected complexity of the project.

### Consequences

Positive:

* clearer module boundaries;
* easier testing;
* easier future API development;
* more predictable architecture.

Negative:

* higher initial complexity;
* more boilerplate than a small standalone Telegram bot.

### Revisit when

Reconsider only if the project becomes dramatically simpler or NestJS becomes a
significant technical limitation.

---

# ADR-002: Use grammY for Telegram Integration

Status: Accepted

### Context

The bot requires:

* commands;
* inline keyboards;
* callback queries;
* media handling;
* conversations / wizard-style flows;
* middleware;
* Telegram API integration.

### Decision

Use:

```text
grammY
```

as the Telegram bot framework.

### Alternatives considered

* Telegraf;
* direct Telegram Bot API;
* custom HTTP integration.

### Rationale

grammY provides a clean TypeScript API, strong typing and a flexible middleware
model.

It is suitable for a modular application where Telegram should remain only a
transport layer.

### Consequences

Telegram-specific code should remain isolated inside the Telegram integration
module.

Core business services must not depend on grammY context objects.

### Revisit when

Reconsider if grammY introduces blockers for required Telegram functionality or
maintenance quality declines significantly.

---

# ADR-003: PostgreSQL Is the Primary Source of Truth

Status: Accepted

### Context

The system must survive:

* application restarts;
* worker restarts;
* Redis reconnects;
* container restarts;
* Telegram retries.

Critical editorial state must not disappear.

### Decision

Use PostgreSQL as the authoritative storage for durable application state.

Durable data includes:

```text
users
channels
permissions
posts
drafts
review state
media metadata
scheduled publication state
publication results
audit history
```

### Alternatives considered

* Redis as primary storage;
* in-memory state;
* filesystem JSON;
* MongoDB;
* SQLite.

### Rationale

The domain is strongly relational and transactional.

Important operations frequently affect multiple related entities.

PostgreSQL provides:

* transactions;
* foreign keys;
* constraints;
* JSONB;
* indexing;
* reliable persistence;
* strong consistency.

### Consequences

Redis must never be treated as the only copy of important editorial data.

Application recovery must be possible from PostgreSQL.

### Revisit when

Only if the domain changes substantially or PostgreSQL becomes a proven
bottleneck.

---

# ADR-004: Use Prisma ORM

Status: Accepted

### Context

The application needs a structured and type-safe way to access PostgreSQL.

### Decision

Use Prisma for:

* schema definition;
* migrations;
* database access;
* generated TypeScript types.

### Alternatives considered

* TypeORM;
* MikroORM;
* Sequelize;
* Knex;
* raw SQL.

### Rationale

Prisma provides strong TypeScript integration and makes common relational
operations easy to maintain.

### Consequences

Schema changes must go through Prisma migrations.

Generated Prisma code must not be manually modified.

For performance-critical operations, raw SQL may still be used where justified.

### Revisit when

Reconsider if Prisma prevents required database functionality or produces
unacceptable performance limitations.

---

# ADR-005: Redis Is Infrastructure, Not Durable Business Storage

Status: Accepted

### Context

Redis is required for queueing, locking, rate limiting and caching.

There is a risk that short-lived implementation convenience could lead to Redis
being used as the primary storage for drafts or workflow state.

### Decision

Redis may be used for:

```text
BullMQ
locks
cache
rate limiting
short-lived UI state
temporary coordination
```

Redis must NOT be the only storage for:

```text
drafts
post content
review state
scheduled publication state
publication history
permissions
```

### Rationale

Redis is excellent for ephemeral coordination but critical editorial state must
be recoverable from PostgreSQL.

### Consequences

Any Redis data required for correct recovery must also have a durable
representation in PostgreSQL.

---

# ADR-006: Publication Must Run Through BullMQ

Status: Accepted

### Context

Telegram publication can fail because of:

* network errors;
* Telegram outages;
* rate limits;
* temporary permission issues;
* worker interruption.

Publishing directly inside a Telegram callback would couple user interaction to
an unreliable external operation.

### Decision

All real publication operations must be executed through BullMQ jobs.

Flow:

```text
Telegram action
↓
Application service
↓
Validation
↓
Publication job
↓
BullMQ
↓
Worker
↓
Telegram API
↓
Persist result
```

### Alternatives considered

* direct publication in Telegram handlers;
* `setTimeout`;
* cron-only scheduling;
* PostgreSQL polling worker;
* custom queue implementation.

### Rationale

BullMQ provides:

* retries;
* delayed jobs;
* backoff;
* worker separation;
* job visibility;
* locking support.

### Consequences

Publication becomes asynchronous.

The UI must communicate that a publication request may be queued before final
success.

### Revisit when

Reconsider if BullMQ becomes operationally problematic or if a different queue
system is adopted for broader infrastructure reasons.

---

# ADR-007: Separate App and Publication Worker

Status: Accepted

### Context

Telegram interaction and Telegram publishing have different operational
requirements.

A long-running publication must not block bot interaction.

### Decision

Run at least two logical processes:

```text
app
worker
```

The app:

* processes Telegram updates;
* handles user interaction;
* creates jobs.

The worker:

* processes publication jobs;
* performs Telegram API publication;
* retries failures;
* persists publication results.

### Rationale

This provides failure isolation and allows independent scaling.

### Consequences

Deployment must support separate app and worker processes.

The worker must be able to operate independently of the bot update process.

---

# ADR-008: Telegram Is a Transport Layer

Status: Accepted

### Context

A common Telegram bot anti-pattern is placing all logic inside command and
callback handlers.

This leads to tightly coupled and untestable code.

### Decision

Telegram handlers must remain thin.

They may:

* parse input;
* resolve user context;
* invoke application services;
* render UI responses.

They must not contain core business rules.

### Rationale

Business logic should be reusable by:

* Telegram;
* future web frontend;
* REST API;
* automated jobs;
* tests.

### Consequences

Application services must accept transport-independent input types.

Do not pass grammY Context objects deep into the domain layer.

---

# ADR-009: Channel-Level Permissions

Status: Accepted

### Context

The system may eventually support multiple Telegram channels.

A user may have different responsibilities in different channels.

### Decision

Separate global system access from channel-specific permissions.

Conceptually:

```text
users.system_role
channel_members.role
channel_members.can_publish
channel_members.can_approve
```

### Alternatives considered

* one global role per user;
* permissions encoded only in Telegram menus.

### Rationale

A user may later be:

```text
Editor in Channel A
Author in Channel B
Viewer in Channel C
```

This should not require redesigning authorization.

### Consequences

Every channel-related action must resolve channel membership and permissions.

UI visibility alone is not sufficient authorization.

---

# ADR-010: Explicit Post State Machine

Status: Accepted

### Context

Posts move through an editorial workflow.

Uncontrolled status updates can create invalid states.

### Decision

Post status transitions must be explicit and validated.

Expected states:

```text
DRAFT
PENDING_REVIEW
NEEDS_REVISION
APPROVED
SCHEDULED
PUBLISHING
PUBLISHED
REJECTED
CANCELLED
PUBLISH_FAILED
```

Expected transitions:

```text
DRAFT
→ PENDING_REVIEW

PENDING_REVIEW
→ APPROVED
→ NEEDS_REVISION
→ REJECTED

NEEDS_REVISION
→ PENDING_REVIEW

APPROVED
→ SCHEDULED
→ PUBLISHING

SCHEDULED
→ PUBLISHING
→ CANCELLED

PUBLISHING
→ PUBLISHED
→ PUBLISH_FAILED

PUBLISH_FAILED
→ PUBLISHING
→ CANCELLED
```

### Alternatives considered

* arbitrary enum updates;
* status controlled directly from handlers.

### Rationale

Explicit transitions make the workflow:

* testable;
* auditable;
* predictable;
* safer.

### Consequences

Status updates should go through a workflow/domain service.

Direct database status mutation should be avoided.

---

# ADR-011: Autosave Drafts After Meaningful Steps

Status: Accepted

### Context

Users may interrupt post creation at any point.

Telegram sessions may disappear or restart.

### Decision

Persist draft progress after every meaningful completed step.

Examples:

```text
title entered
→ save

body entered
→ save

media added
→ save
```

### Alternatives considered

* save only when the wizard finishes;
* keep wizard state in memory;
* store all wizard state only in Redis.

### Rationale

The user should be able to stop and continue later without losing work.

### Consequences

Draft creation generates more database writes.

This is acceptable because correctness and recoverability are more important.

---

# ADR-012: Use Optimistic Locking for Post Editing

Status: Accepted

### Context

More than one user may open the same post.

Without concurrency control, one user can overwrite another user's changes.

### Decision

Posts use a version number.

Updates must validate the expected version.

Conceptually:

```sql
UPDATE posts
SET
  ...,
  version = version + 1
WHERE
  id = :id
  AND version = :expected_version;
```

### Alternatives considered

* last-write-wins;
* pessimistic locking;
* no concurrency handling.

### Rationale

Optimistic locking is appropriate because simultaneous edits are possible but
should be relatively uncommon.

### Consequences

The UI must handle edit conflicts and ask the user to reload the latest version.

---

# ADR-013: Single Canonical Telegram Renderer

Status: Accepted

### Context

Preview and real publication must look the same.

Separate preview and publication formatting implementations would eventually
diverge.

### Decision

Use one renderer for both preview and publication.

Conceptually:

```text
Post
+
Template
+
Media
↓
TelegramRenderer
↓
TelegramPayload
```

### Alternatives considered

* one renderer for preview and another for publication;
* formatting directly inside handlers.

### Rationale

One canonical renderer eliminates a major source of inconsistencies.

### Consequences

Renderer output must be reusable by both UI preview and worker publication.

---

# ADR-014: Render Structured TelegramPayload, Not Only Text

Status: Accepted

### Context

A publication can contain more than one Telegram message.

Example:

```text
media group
+
long text
```

Telegram caption limits may force publication to be split.

### Decision

Renderer output should be a structured publication payload.

Example:

```json
{
  "messages": [
    {
      "type": "media_group",
      "items": []
    },
    {
      "type": "text",
      "html": "..."
    }
  ]
}
```

### Rationale

This models actual Telegram publication behavior more accurately than storing
only one rendered text field.

### Consequences

The publishing worker must support multi-message logical publications.

---

# ADR-015: Publication Is Idempotent

Status: Accepted

### Context

Queue systems generally provide at-least-once processing.

The same job may run more than once because of:

* repeated user actions;
* job retries;
* worker crashes;
* network uncertainty;
* queue redelivery.

### Decision

Publication must use a durable idempotency key.

Recommended format:

```text
publish:{post_id}:{post_version}
```

Where appropriate, enforce uniqueness in PostgreSQL.

### Alternatives considered

* Redis-only locks;
* trusting BullMQ to execute exactly once;
* disabling button after first click.

### Rationale

None of those alternatives gives a strong durable guarantee.

The database is the correct place to enforce publication uniqueness.

### Consequences

Publication services must check existing publication state before sending
messages.

Retries must be safe.

---

# ADR-016: BullMQ Jobs Are At-Least-Once

Status: Accepted

### Context

Workers can crash after an external operation succeeds but before the queue job
is acknowledged.

### Decision

Assume BullMQ jobs may execute multiple times.

Design every publication job to be idempotent.

### Rationale

Exactly-once execution cannot be safely assumed across a queue, database and
external Telegram API.

### Consequences

Correctness must come from state validation and idempotency, not assumptions
about queue execution count.

---

# ADR-017: Preserve Partial Publication Progress

Status: Accepted

### Context

A logical publication can require multiple Telegram API calls.

Example:

```text
sendMediaGroup
↓
sendMessage
```

The first call may succeed while the second fails.

### Decision

Persist successful Telegram message IDs incrementally.

Retries must not blindly resend successful steps.

### Alternatives considered

* retry entire publication from the beginning;
* delete successful messages before retry.

### Rationale

Blind retry can create duplicate channel messages.

Deleting already-published messages introduces additional failure modes and
requires broader Telegram permissions.

### Consequences

The publication worker needs step-aware recovery logic.

---

# ADR-018: Telegram file_id Is Preferred for Reuse

Status: Accepted

### Context

Telegram provides `file_id` values that can be reused for later sends.

### Decision

Store:

```text
telegram_file_id
telegram_file_unique_id
```

for media.

Reuse `file_id` instead of downloading and re-uploading media whenever possible.

### Rationale

This reduces:

* bandwidth;
* latency;
* storage requirements;
* external file handling.

### Consequences

The system should retain enough media metadata to determine how to resend the
file correctly.

---

# ADR-019: Use Telegram HTML Parse Mode

Status: Accepted

### Context

The project requires formatted posts.

Telegram supports multiple parse modes.

### Decision

Use Telegram HTML as the canonical formatting format for MVP.

### Alternatives considered

* Markdown;
* MarkdownV2;
* plain text;
* custom rich text model.

### Rationale

HTML is relatively readable, supports required formatting and is easier to
generate reliably than heavily escaped MarkdownV2.

### Consequences

All user-controlled content must be escaped/sanitized before rendering.

The supported HTML subset must be controlled.

---

# ADR-020: Store Absolute Times, Display in Channel Timezone

Status: Accepted

### Context

Scheduling must work correctly across:

* daylight saving changes;
* server timezone differences;
* future multiple channels.

### Decision

Interpret user-entered time using the channel timezone.

Store the resulting absolute timestamp as:

```text
TIMESTAMPTZ
```

Default channel timezone:

```text
Europe/Kyiv
```

### Alternatives considered

* server local time;
* plain TIMESTAMP;
* storing formatted date strings.

### Rationale

Absolute timestamps eliminate ambiguity during execution.

### Consequences

Timezone conversion must occur explicitly at system boundaries.

The server machine timezone must not affect publication behavior.

---

# ADR-021: Preflight Validation Happens Twice

Status: Accepted

### Context

Conditions can change between scheduling and publication.

For example:

* bot permissions may be revoked;
* post may be cancelled;
* channel may be disabled;
* media may become invalid.

### Decision

Run publication validation:

1. when publication is requested/scheduled;
2. immediately before worker publication.

### Rationale

Early validation improves UX.

Late validation protects correctness.

### Consequences

Some validation logic must be reusable by both application services and worker
code.

---

# ADR-022: Audit Log Is Append-Oriented

Status: Accepted

### Context

The system needs a trustworthy history of important actions.

### Decision

Audit records should represent historical events and normally should not be
edited or overwritten.

Examples:

```text
post_created
post_updated
submitted
approved
revision_requested
rejected
scheduled
published
publication_failed
permission_changed
```

### Rationale

Historical records are useful for:

* debugging;
* accountability;
* future analytics;
* incident investigation.

### Consequences

Current entity state belongs in normal entity tables.

Audit log is not a replacement for current state.

---

# ADR-023: Use Database Transactions for Atomic State Changes

Status: Accepted

### Context

Many operations require multiple database writes.

Example:

```text
change post status
+
create review history
+
create audit event
```

### Decision

Use PostgreSQL transactions when writes together represent one logical state
transition.

### Rationale

Partial persistence could produce inconsistent workflow state.

### Consequences

Transactions must remain short.

Slow Telegram API calls must not be executed inside long-running database
transactions.

---

# ADR-024: Do Not Build Full REST API During MVP

Status: Accepted

### Context

The MVP user interface is Telegram.

A future web frontend may require a larger API.

### Decision

MVP HTTP surface should be minimal.

Required endpoints:

```text
POST /telegram/webhook
GET /health
GET /ready
```

A full content-management REST API is postponed until there is a real client for
it.

### Alternatives considered

Build all future CRUD endpoints during MVP.

### Rationale

Building unused API infrastructure increases scope and maintenance burden.

Application services should still be designed so a future API can reuse them.

### Consequences

The future web panel may require new controllers, but should not require
rewriting business logic.

---

# ADR-025: Webhook in Production, Polling in Local Development

Status: Accepted

### Context

Polling is easy for local development.

Production should have predictable and efficient update delivery.

### Decision

Use:

```text
Production → webhook
Local → polling allowed
```

### Rationale

Webhook mode is better suited for production deployment, while polling improves
developer convenience.

### Consequences

Application business logic must not depend on which transport mode is used.

---

# ADR-026: Docker Compose Is the Standard Runtime Environment

Status: Accepted

### Context

The project depends on several services:

```text
application
worker
PostgreSQL
Redis
```

Development and production-like environments should remain reproducible.

### Decision

Use Docker Compose as the standard project runtime setup.

Expected services:

```text
app
worker
postgres
redis
```

### Rationale

This reduces environment drift between developers, staging and production.

### Consequences

The application must not depend on host-specific paths or globally installed
software.

---

# ADR-027: Separate Local, Staging and Production Environments

Status: Accepted

### Context

Telegram bots and channels represent real external resources.

Testing against production could accidentally publish live content.

### Decision

Maintain at least:

```text
local
staging
production
```

Staging should use:

* separate bot token;
* separate test channel;
* separate PostgreSQL database;
* separate Redis.

### Rationale

This protects live content and allows safe end-to-end testing.

### Consequences

Environment configuration must be explicit and isolated.

---

# ADR-028: Avoid Premature Web Panel Development

Status: Accepted

### Context

A web panel is planned but not required for MVP.

### Decision

Do not build the web frontend until the Telegram-based MVP proves the editorial
workflow.

### Rationale

The main uncertainty is product workflow, not frontend technology.

Building both interfaces simultaneously increases scope and duplicates UX work.

### Consequences

Application services must still remain transport-independent so a web frontend
can be added later.

---

# ADR-029: Templates Are Data, Not Handler Code

Status: Accepted

### Context

The system needs multiple post formats and may add more later.

### Decision

Store template definitions in PostgreSQL using versioned JSON-based schemas and
rendering configuration.

### Alternatives considered

Hard-code each template directly in Telegram handlers.

### Rationale

Data-driven templates allow new ordinary content formats without rewriting core
workflow logic.

### Consequences

Template schemas require validation and versioning.

Historical posts must remain interpretable even after template changes.

---

# ADR-030: Version Templates

Status: Accepted

### Context

Templates can evolve over time.

Changing a template must not unexpectedly change existing drafts or published
content.

### Decision

Templates have explicit version numbers.

Posts should preserve enough information to identify or reproduce the template
version used.

### Rationale

Historical content needs stable rendering semantics.

### Consequences

Template updates should create a new logical version rather than silently
changing historical meaning.

---

# ADR-031: Preserve Post Version for Publication

Status: Accepted

### Context

A post may change after a publication request or while waiting in a queue.

### Decision

Publication jobs must be associated with the specific post version intended for
publication.

Recommended idempotency key:

```text
publish:{post_id}:{post_version}
```

### Rationale

This prevents ambiguous behavior when content changes during publication
processing.

### Consequences

If the post changes after scheduling, the application must explicitly define
whether the existing schedule is invalidated or updated.

For MVP, scheduled publication should always publish the approved/scheduled
version rather than silently switching to a later unapproved edit.

---

# ADR-032: Scheduled Approved Content Must Not Change Silently

Status: Accepted

### Context

An Editor may approve and schedule version 5 of a post.

An Author or Editor could later modify the post.

Publishing modified version 6 without another review would violate editorial
expectations.

### Decision

Once a specific version is approved or scheduled, that approval applies to that
version.

Any content-changing edit after approval must either:

```text
invalidate approval
```

or:

```text
create a new version requiring re-approval
```

### Rationale

Approval must refer to exact content, not merely the post ID.

### Consequences

Editing an approved/scheduled post requires explicit workflow handling.

Recommended MVP behavior:

```text
editing APPROVED or SCHEDULED content
→ cancel current approval/schedule
→ new version
→ DRAFT or NEEDS_REVISION
```

unless performed by an Editor through an explicitly privileged workflow.

---

# ADR-033: Database Constraints Enforce Critical Invariants

Status: Accepted

### Context

Application-level validation can fail under concurrency.

### Decision

Where practical, enforce critical rules at database level.

Examples:

```text
UNIQUE users.telegram_id
UNIQUE channels.telegram_chat_id
UNIQUE publication_jobs.idempotency_key
FOREIGN KEY relationships
NOT NULL required fields
```

### Rationale

Database constraints remain effective under concurrent requests and application
bugs.

### Consequences

Application errors caused by constraint violations must be translated into
useful domain errors.

---

# ADR-034: Soft Delete Editorial Content

Status: Accepted

### Context

Deleting drafts and editorial content permanently can make audit and incident
investigation difficult.

### Decision

Use soft deletion for posts where practical.

Typical field:

```text
deleted_at
```

### Alternatives considered

Immediate hard delete.

### Rationale

Soft delete preserves history and reduces accidental data loss.

### Consequences

Normal queries must consistently exclude deleted posts.

Publication workers must refuse deleted posts.

Periodic hard deletion may be introduced later under a retention policy.

---

# ADR-035: Notification Failure Must Not Corrupt Core State

Status: Accepted

### Context

Notifications are secondary side effects.

For example, a post may publish successfully while sending the success
notification fails.

### Decision

Core workflow state and publication state must not be rolled back solely because
a notification could not be delivered.

### Rationale

The Telegram channel publication is more important than an auxiliary status
message.

### Consequences

Notification failures should be logged and may have their own retry mechanism.

---

# ADR-036: Structured Logging

Status: Accepted

### Context

The system includes:

* Telegram updates;
* queues;
* workers;
* database operations;
* external Telegram API calls.

Unstructured logs become difficult to trace.

### Decision

Use structured JSON logging with contextual identifiers.

Examples:

```text
request_id
telegram_update_id
user_id
post_id
channel_id
job_id
operation
```

### Rationale

This makes distributed debugging significantly easier.

### Consequences

Avoid relying on free-form `console.log` messages in production code.

---

# ADR-037: Explicit Health and Readiness Endpoints

Status: Accepted

### Context

The application runs in containerized environments and depends on external
services.

### Decision

Expose separate endpoints:

```text
GET /health
GET /ready
```

`/health` answers whether the process is alive.

`/ready` answers whether the instance can serve its intended role.

### Rationale

This supports deployment automation and monitoring.

### Consequences

Readiness checks may include critical dependencies such as PostgreSQL and Redis.

---

# ADR-038: No Production Secrets in Repository

Status: Accepted

### Context

The application requires highly sensitive credentials.

### Decision

Never commit real:

```text
BOT_TOKEN
DATABASE_URL credentials
REDIS credentials
API keys
private keys
```

Use environment variables or a secrets manager.

### Consequences

`.env.example` contains only names and safe example values.

Secret scanning should eventually be added to CI.

---

# ADR-039: MVP Before Future Platform Features

Status: Accepted

### Context

The roadmap includes:

* AI assistant;
* web frontend;
* analytics;
* multiple channels;
* external integrations;
* crossposting.

Implementing all future capabilities during MVP would substantially increase
scope and risk.

### Decision

Implement architecture that permits future expansion, but do not build unused
future features prematurely.

### Rationale

The first goal is proving the editorial workflow and reliable Telegram
publication.

### Consequences

A clean extension point is sufficient.

Unused infrastructure is not.

---

# ADR-040: Reliability Is More Important Than Cleverness

Status: Accepted

### Context

The most damaging failures in this system would be:

* duplicate publications;
* wrong publication;
* publishing unapproved content;
* losing a draft;
* missing scheduled publication;
* corrupting workflow state.

### Decision

When choosing between a simpler explicit implementation and a clever but less
predictable abstraction, prefer the explicit reliable implementation.

Engineering priorities:

```text
correctness
data integrity
publication safety
idempotency
recoverability
auditability
maintainability
performance
```

### Consequences

Some operations may use additional database state or validation even when a
shorter implementation exists.

---

# Open Decisions

The following questions are intentionally not finalized yet and should receive
their own ADR when implementation requires a concrete choice.

---

## OPEN-001: Editing an Approved or Scheduled Post

Possible approaches:

### Option A

Any edit invalidates approval and schedule.

```text
APPROVED / SCHEDULED
→ edit
→ DRAFT
```

Pros:

* safest;
* simplest mental model.

Cons:

* Editor must reapprove small corrections.

### Option B

Editors may perform privileged edits without reapproval.

Pros:

* faster editorial workflow.

Cons:

* approval semantics become more complex.

Recommended MVP direction:

```text
Option A
```

unless real editorial workflow demonstrates a need for Option B.

---

## OPEN-002: Post Version Storage

Possible approaches:

### Option A

Keep only:

```text
posts.version
```

and audit metadata.

### Option B

Create full:

```text
post_versions
```

snapshots.

Option B gives stronger revision history and safer publication/version
reconstruction but adds storage and complexity.

Recommended direction:

Start with `posts.version`.

Add `post_versions` before advanced editorial history or rollback features.

---

## OPEN-003: Multi-Message Publication Recovery Strategy

Possible approaches:

### Option A

Persist every publication step and resume from the first incomplete step.

### Option B

Attempt cleanup of successful Telegram messages and restart the publication.

Recommended direction:

```text
Option A
```

because cleanup introduces additional API calls and failure modes.

---

## OPEN-004: Dynamic Template Rendering Format

Potential choices include:

* simple interpolation;
* custom rendering schema;
* Handlebars-like templates;
* application-defined rendering strategies.

Do not introduce an unrestricted executable template language.

Template rendering must remain deterministic and safe.

---

## OPEN-005: Telegram Button / Link Support

Decide whether post templates should support:

* inline URL buttons;
* callback buttons;
* no publication buttons in MVP.

Any implementation must clearly distinguish:

```text
editorial bot controls
```

from:

```text
buttons published to channel readers
```

---

## OPEN-006: Analytics Data Collection

Decide whether future analytics should come from:

* Telegram Bot API capabilities;
* Telegram channel statistics integrations;
* external analytics services;
* custom tracked links.

Do not design the MVP database around analytics that do not yet exist.

---

# How to Add a New Decision

Add a new ADR when a change affects one or more of:

```text
architecture
persistence
workflow semantics
security
permissions
publication reliability
queue behavior
database schema strategy
integration strategy
deployment model
```

Do not create ADRs for trivial decisions such as:

```text
function names
small UI copy changes
local refactoring
minor validation changes
```

unless they establish a project-wide rule.

---

# Changing an Existing Decision

Do not silently rewrite an old accepted decision as if the previous decision
never existed.

If architecture changes substantially:

1. keep the old ADR;
2. mark it `Superseded`;
3. create a new ADR;
4. reference the old ADR.

Example:

```text
ADR-006
Status: Superseded by ADR-047
```

This preserves architectural history.

---

# Decision Review Rule

Before introducing a new major dependency, persistence model, queue mechanism,
permission model or publishing flow, check this file first.

If the proposed implementation conflicts with an accepted ADR:

* do not silently implement the conflicting approach;
* either preserve the existing decision;
* or explicitly supersede it with a new decision and rationale.

---

# Current Architectural Summary

At the current stage, the intended architecture is:

```text
Telegram
    ↓
grammY transport
    ↓
NestJS application services
    ↓
Domain workflow
    ↓
PostgreSQL
    ↓
BullMQ / Redis
    ↓
Publication worker
    ↓
Telegram Bot API
```

Key guarantees:

```text
PostgreSQL is authoritative
Redis is not durable business storage
Telegram handlers stay thin
publication runs through worker
publication is idempotent
post workflow is explicit
permissions are checked server-side
preview and publication share one renderer
scheduled state survives restart
important actions are auditable
```

These guarantees should remain stable unless a future ADR explicitly replaces
them.

```

Я бы сделал именно один `DECISIONS.md` на старте, а не сразу папку с сорока отдельными ADR-файлами. Для проекта такого размера это проще читать. Если документ со временем разрастётся, его легко превратить в `docs/adr/001-nestjs.md`, `002-postgresql.md`, `003-bullmq.md` и так далее.

Самые важные места здесь — даже не выбор NestJS или Prisma. Это ADR про версию поста, одобрение конкретной версии, идемпотентность и частичную публикацию. Именно там скрыты неприятные логические ошибки, которые проявляются уже после того, как бот начинает реально использоваться несколькими людьми.
```
