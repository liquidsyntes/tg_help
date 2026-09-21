````md
# AGENTS.md

# Telegram Content Publisher Bot

This file defines the rules for AI coding agents working in this repository.

These instructions are authoritative for implementation work unless a task
explicitly states otherwise.

The product specification is defined separately in the project documentation.
This file describes HOW changes should be implemented.

---

# 1. Project Overview

The project is a Telegram-based editorial publishing system.

Primary capabilities:

- user authorization by Telegram ID;
- role and permission management;
- draft creation;
- dynamic post templates;
- autosave;
- media handling;
- editorial review;
- revision workflow;
- scheduling;
- reliable Telegram publication;
- retry handling;
- audit logging;
- notifications;
- future support for multiple channels;
- future web frontend;
- future AI integrations.

Primary stack:

```text
Node.js 22+
TypeScript
NestJS
grammY
PostgreSQL
Prisma
Redis
BullMQ
Docker
````

The architecture must remain modular and suitable for future expansion.

---

# 2. Sources of Truth

When implementing a task, use the following order of authority:

1. The current user request / issue.
2. `AGENTS.md`.
3. Product specification / technical specification.
4. `ARCHITECTURE.md`.
5. Existing tests.
6. Existing implementation.

If the implementation contradicts the specification, do not blindly copy
existing code.

Identify the inconsistency and implement the intended architecture unless the
task explicitly requires backward compatibility.

Never silently redefine product behavior.

---

# 3. Core Architectural Principle

Telegram is a transport layer.

Telegram handlers must NOT contain core business logic.

Correct:

```text
Telegram Update
    ↓
Telegram Handler
    ↓
Application / Domain Service
    ↓
Repository / Queue / Integration
```

Incorrect:

```text
Telegram Handler
    ↓
Prisma
    ↓
Telegram API
    ↓
Redis
```

Handlers should primarily:

* parse Telegram updates;
* validate basic input shape;
* identify the current user;
* call application services;
* render responses;
* map application errors to user-friendly messages.

Business rules belong in services/modules.

---

# 4. Module Boundaries

Expected structure:

```text
src/
  modules/
    auth/
    users/
    roles/
    channels/
    posts/
    templates/
    media/
    reviews/
    publishing/
    scheduling/
    notifications/
    audit/
    analytics/
    telegram/
    admin/

  infrastructure/
    database/
    redis/
    queues/
    logger/
    config/
    telegram-api/

  common/
    guards/
    decorators/
    enums/
    dto/
    utils/
    exceptions/
```

The exact folder structure may evolve, but separation of responsibilities must
remain.

Do not create large "god services".

Avoid modules that simultaneously:

* process Telegram updates;
* perform database queries;
* render templates;
* publish Telegram messages;
* manage queues.

Split responsibilities instead.

---

# 5. Dependency Direction

Prefer dependency flow:

```text
Transport
   ↓
Application
   ↓
Domain / business rules
   ↓
Infrastructure interfaces
   ↓
Concrete infrastructure
```

Infrastructure must not define business behavior.

Business services should not depend on Telegram update objects.

Bad:

```ts
async approvePost(ctx: Context)
```

Preferred:

```ts
async approvePost(input: ApprovePostCommand)
```

Telegram-specific data should be converted before entering business logic.

---

# 6. TypeScript Rules

Use TypeScript strict mode.

Do not introduce:

```ts
any
```

unless there is a documented and unavoidable integration boundary.

Prefer:

```ts
unknown
```

followed by validation.

Avoid unsafe casts:

```ts
value as SomeType
```

unless runtime validity has already been established.

Use explicit domain types where possible.

Example:

```ts
type TelegramUserId = bigint;
type PostId = string;
type ChannelId = string;
```

Prefer discriminated unions for state-dependent structures.

---

# 7. Validation

All external input must be treated as untrusted.

Validate:

* Telegram messages;
* callback payloads;
* commands;
* REST payloads;
* template JSON;
* user-entered text;
* dates;
* URLs;
* media metadata;
* environment variables.

Use DTO/schema validation at system boundaries.

Do not assume callback data is valid because the bot generated it.

Do not trust values stored in Telegram buttons.

Permissions must always be checked on the server.

---

# 8. Authentication

Telegram ID is the primary Telegram identity.

Every protected operation must:

1. resolve the user;
2. ensure the user exists;
3. ensure the user is active;
4. resolve channel membership if applicable;
5. verify the required permission.

Never authorize a user using:

```text
username
first_name
last_name
Telegram display name
```

These are not stable authorization identifiers.

---

# 9. Permission Model

Do not rely only on a global role.

The architecture must support channel-level permissions.

Conceptually:

```text
users.system_role
channel_members.role
channel_members.can_publish
channel_members.can_approve
```

`SUPER_ADMIN` may bypass channel-level restrictions where explicitly intended.

Other users must be checked against the relevant channel.

Hiding a Telegram button is NOT a permission check.

Always validate permissions again when the action is executed.

---

# 10. Post State Machine

Post status transitions are controlled business operations.

Expected lifecycle:

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

APPROVED
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

Never update status casually:

```ts
await prisma.post.update({
  data: { status: 'PUBLISHED' }
});
```

Prefer a dedicated transition service that:

* validates the current status;
* validates permissions;
* applies the transition;
* writes audit history;
* performs required side effects.

Example:

```ts
await postWorkflow.transition({
  postId,
  action: PostAction.APPROVE,
  actorId,
});
```

Invalid transitions must fail explicitly.

---

# 11. Database Is the Source of Truth

Do not keep critical application state only in memory.

The application must survive:

* application restart;
* worker restart;
* Redis reconnect;
* container restart.

Persistent state includes:

* users;
* channels;
* permissions;
* drafts;
* wizard progress where required;
* post content;
* post status;
* review information;
* media;
* scheduled publication information;
* publication results;
* audit events.

Redis may be used for:

* cache;
* short-lived UI state;
* locks;
* queues;
* rate limiting.

Redis must not be the only durable storage of editorial state.

---

# 12. Autosave

Draft creation should be incremental.

After a user successfully completes a meaningful step, persist it.

Example:

```text
title entered
→ save

body entered
→ save

media uploaded
→ save

metadata changed
→ save
```

Do not wait until the final wizard step to persist the entire post.

A user must be able to interrupt creation and continue later.

---

# 13. Concurrency

Assume two users may modify the same post.

Use optimistic concurrency control where appropriate.

Posts should have a version field:

```text
version INTEGER
```

Updates should verify the expected version.

Conceptually:

```sql
UPDATE posts
SET
  content_json = ...,
  version = version + 1
WHERE
  id = ?
  AND version = ?
```

If no row is updated, treat it as a conflict.

Do not silently overwrite another user's edits.

---

# 14. Template System

Post templates must not be hard-coded into Telegram handlers.

Templates belong in the template system/database.

Templates should describe:

* fields;
* field types;
* required fields;
* ordering;
* validation;
* hints;
* supported media;
* rendering configuration.

Example structure:

```json
{
  "fields": [
    {
      "key": "title",
      "type": "text",
      "required": true,
      "maxLength": 256
    }
  ]
}
```

Adding a new ordinary template should not require rewriting the entire publishing
pipeline.

---

# 15. Rendering

There must be one canonical rendering pipeline.

Concept:

```text
Post
+
Template
+
Media
↓
Renderer
↓
TelegramPayload
```

Preview and publication must use the same renderer.

Do not implement separate formatting logic for:

```text
preview
```

and:

```text
publication
```

Otherwise preview can diverge from the actual channel post.

---

# 16. Telegram Payload

A publication is not necessarily one Telegram message.

Represent the rendered result as a structured payload.

Example:

```ts
interface TelegramPayload {
  messages: TelegramOutgoingMessage[];
}
```

Possible message types:

```text
text
photo
video
document
animation
media_group
```

A logical publication may contain:

```text
media group
+
separate long text message
```

The publishing layer must support this.

---

# 17. Telegram HTML

Use Telegram HTML parse mode.

Sanitize and validate HTML before publication.

Never pass arbitrary user HTML directly to Telegram.

Supported formatting should be explicitly controlled.

Examples:

```html
<b></b>
<i></i>
<u></u>
<s></s>
<code></code>
<pre></pre>
<a></a>
<blockquote></blockquote>
```

Escape special characters correctly.

Formatting errors should become domain/application errors with understandable
user messages.

---

# 18. Telegram Limits

Do not hard-code Telegram limits throughout the codebase.

Centralize them.

Example:

```text
src/common/constants/telegram-limits.ts
```

Centralized constraints may include:

* message length;
* caption length;
* media group size;
* supported media types;
* callback data size;
* file constraints.

When Telegram behavior differs by message type, represent that distinction
explicitly.

---

# 19. Media

Store Telegram file references where possible.

Persist:

```text
telegram_file_id
telegram_file_unique_id
media_type
file_name
mime_type
file_size
caption
sort_order
```

Prefer reusing Telegram `file_id` rather than downloading and uploading the same
file again.

Do not assume all videos arrive as Telegram `video`.

Some files may arrive as:

```text
document
```

even when they contain video.

---

# 20. Publishing

Never publish directly from a Telegram callback handler.

Correct flow:

```text
User action
↓
permission validation
↓
post validation
↓
create publication job
↓
BullMQ
↓
worker
↓
Telegram API
↓
save result
↓
notify users
```

The worker owns actual publication.

---

# 21. Idempotency

Publishing must be idempotent.

A post must not be published twice because of:

* repeated button clicks;
* Telegram retry;
* network retry;
* worker restart;
* queue retry;
* race condition.

Each publication operation must have an idempotency identity.

Recommended pattern:

```text
publish:{post_id}:{post_version}
```

Where suitable, enforce uniqueness at the database level.

Do not rely only on Redis locks for permanent idempotency.

Database constraints are preferred for durable guarantees.

---

# 22. Queue Jobs

BullMQ jobs must be safe to retry.

Workers should assume jobs may execute more than once.

A job handler must not rely on exactly-once execution.

Expected principles:

```text
at-least-once delivery
+
idempotent handler
=
safe processing
```

Use:

* retries;
* exponential backoff;
* locking;
* durable publication state;
* error logging.

After retry exhaustion, preserve enough information for manual retry.

---

# 23. Partial Publication

A logical post may require multiple Telegram API calls.

Example:

```text
sendMediaGroup()
sendMessage()
```

If the first succeeds and the second fails, do not blindly restart everything.

Store Telegram message IDs after each successful step.

Retries should resume safely where technically possible.

Never duplicate already-published messages just because the final step failed.

---

# 24. Scheduling

Store absolute publication times using timezone-aware database types.

Preferred:

```text
TIMESTAMPTZ
```

User-entered dates should be interpreted in the channel timezone.

Default:

```text
Europe/Kyiv
```

Convert to an absolute timestamp before scheduling.

Do not store ambiguous local datetime values without timezone context.

Validate that scheduled dates are not in the past.

---

# 25. Preflight Validation

Publication validation should occur at least:

1. when the publication is scheduled or requested;
2. immediately before actual publication.

Preflight checks may include:

* post still exists;
* post is not deleted;
* publication is not cancelled;
* post status allows publication;
* channel is active;
* Telegram chat ID exists;
* bot still has required permissions;
* media references are usable;
* rendered payload is valid.

---

# 26. Audit Logging

Important actions must create audit entries.

Examples:

```text
post_created
post_updated
media_added
media_removed
submitted_for_review
revision_requested
approved
rejected
scheduled
schedule_cancelled
publication_started
publication_completed
publication_failed
user_created
user_blocked
permission_changed
template_changed
settings_changed
```

Audit logging should contain useful context but must not leak secrets.

Audit history should be append-oriented.

Do not rewrite old audit records to represent current state.

---

# 27. Notifications

Notifications are side effects of domain events.

Avoid spreading Telegram notification calls across business services.

Prefer:

```text
Domain operation
↓
event / application result
↓
Notification service
```

Notifications should not determine whether the core transaction succeeds unless
the notification itself is the requested operation.

Failure to send a secondary notification should not corrupt publication state.

---

# 28. Transactions

Use database transactions when multiple related writes form one logical state
transition.

Examples:

```text
post status change
+
review history entry
+
audit record
```

or:

```text
publication result
+
Telegram message IDs
+
status update
```

Do not leave partially updated database state when it can reasonably be avoided.

Keep transactions short.

Do not perform slow external Telegram API requests inside long-running database
transactions.

---

# 29. Prisma

Use Prisma migrations for schema changes.

Do not manually modify production database schema.

When changing Prisma models:

1. update `schema.prisma`;
2. create a migration;
3. review generated SQL;
4. update affected application code;
5. update fixtures/seeds;
6. update tests.

Avoid destructive migrations unless explicitly required.

If a migration can destroy or rewrite production data, call this out clearly.

---

# 30. Database Constraints

Use the database to enforce invariants where practical.

Examples:

```text
unique Telegram user ID
unique Telegram channel ID
unique idempotency key
foreign keys
non-null required fields
indexes for frequently queried statuses
```

Do not enforce critical uniqueness only in application code.

---

# 31. Soft Delete

Posts may use:

```text
deleted_at
```

If soft delete is implemented:

* normal queries must exclude deleted records;
* publication jobs must refuse deleted posts;
* deleted posts must not silently return to active workflow;
* audit history must remain available.

---

# 32. Error Handling

Separate:

```text
validation errors
authorization errors
conflict errors
domain errors
external API errors
infrastructure errors
unexpected errors
```

User-facing errors must be understandable.

Internal errors must contain enough context for debugging.

Do not expose:

```text
stack traces
database connection strings
tokens
raw authorization headers
internal secrets
```

to Telegram users.

---

# 33. Logging

Use structured logs.

Preferred contextual fields:

```text
request_id
telegram_update_id
user_id
channel_id
post_id
job_id
module
operation
```

Do not rely on large unstructured strings when structured fields are available.

Good:

```json
{
  "event": "publication_failed",
  "postId": "...",
  "jobId": "...",
  "attempt": 3
}
```

Avoid:

```text
Something failed!!!
```

---

# 34. Sensitive Data

Never commit:

```text
BOT_TOKEN
DATABASE_URL with credentials
REDIS_URL with credentials
API keys
SENTRY secret keys
private keys
passwords
production cookies
```

Secrets must come from:

```text
environment variables
```

or a secrets manager.

`.env` must not be committed.

`.env.example` may contain variable names but no real credentials.

---

# 35. Environment Validation

Environment variables must be validated at application startup.

The app should fail fast when required configuration is invalid.

Examples:

```text
BOT_TOKEN missing
DATABASE_URL invalid
REDIS_URL missing
DEFAULT_TIMEZONE invalid
```

Do not allow the application to start in a partially configured state when that
would cause runtime failures later.

---

# 36. Telegram Webhook

Production should use Telegram webhook mode.

Webhook requests should validate the Telegram secret token where configured.

Do not expose unrestricted internal administrative APIs publicly.

Local development may use polling.

Do not build application logic that depends specifically on polling or webhook.

Transport mode should remain replaceable.

---

# 37. API

For MVP, only expose HTTP endpoints that are currently required.

Examples:

```text
POST /telegram/webhook
GET /health
GET /ready
```

Do not build a large CRUD REST API "for the future" unless requested.

When a future web frontend is implemented, it should reuse application services
rather than duplicating business logic.

---

# 38. Health and Readiness

Distinguish:

```text
health
```

from:

```text
readiness
```

Health answers whether the process is alive.

Readiness should reflect whether required dependencies are available enough for
the instance to serve traffic.

Relevant dependencies may include:

```text
PostgreSQL
Redis
queue
```

Avoid making health endpoints unnecessarily expensive.

---

# 39. Tests

Every meaningful business rule change should include or update tests.

Testing layers:

## Unit

Focus on:

```text
permission rules
state transitions
template validation
rendering
HTML sanitation
idempotency decisions
date/time conversion
```

## Integration

Focus on:

```text
Prisma + PostgreSQL
Redis
BullMQ
repositories
worker behavior
```

## E2E

Focus on important user flows.

Critical flow:

```text
Author creates draft
↓
autosave
↓
submit for review
↓
Editor requests revision
↓
Author edits
↓
submit again
↓
Editor approves
↓
schedule
↓
worker publishes
↓
PUBLISHED
```

---

# 40. Testing Bug Fixes

When fixing a bug:

1. understand the root cause;
2. add a test reproducing the bug where practical;
3. make the test fail;
4. implement the fix;
5. verify the test passes;
6. run relevant regression tests.

Avoid changing code first and adding an unrelated test afterwards.

---

# 41. Commands

Before assuming a command exists, inspect:

```text
package.json
```

Prefer repository-defined scripts.

Expected scripts may include:

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run prisma:migrate
```

Do not invent package scripts and report them as existing.

If a required standard script does not exist and adding it improves the project,
it may be added as part of the relevant task.

---

# 42. Before Making Changes

Before editing code:

1. inspect the relevant module;
2. inspect related DTOs/types;
3. inspect Prisma models when persistence is involved;
4. inspect tests;
5. inspect surrounding services;
6. understand the existing dependency direction.

Do not rewrite a module solely because another design appears cleaner.

Prefer the smallest coherent change that preserves architecture.

---

# 43. Avoid Unrelated Refactoring

Do not perform unrelated cleanup during a targeted task.

Example:

If asked to fix scheduling, do not simultaneously:

* rename all DTOs;
* reorganize all modules;
* replace grammY;
* rewrite logging;
* change formatting conventions.

Small local cleanup directly necessary for the requested change is acceptable.

Large refactors require explicit justification.

---

# 44. Code Style

Prefer:

* small functions;
* descriptive names;
* explicit return types for public service methods;
* dependency injection;
* readonly dependencies;
* domain-oriented naming;
* early validation;
* shallow control flow.

Avoid:

* deeply nested `if`;
* duplicated permission checks;
* duplicated Telegram rendering logic;
* magic strings;
* magic numeric limits;
* giant switch statements when a strategy/registry fits better.

---

# 45. Comments

Comments should explain WHY, not restate WHAT the code does.

Bad:

```ts
// Increment attempts
attempts++;
```

Useful:

```ts
// BullMQ may redeliver the same job after a worker crash.
// The DB idempotency key prevents a second Telegram publication.
```

Do not over-comment obvious code.

---

# 46. Naming

Use consistent English names in source code.

Examples:

```text
Post
PostTemplate
PublicationJob
Review
ChannelMember
Notification
AuditLog
```

UI text may be Russian.

Do not mix transliterated Russian into identifiers.

Avoid identifiers such as:

```text
postik
redaktor
publikaciya
```

---

# 47. Dates and Timezones

Never assume server local timezone is the publication timezone.

Never derive business behavior from:

```ts
new Date().getHours()
```

without understanding timezone semantics.

Use explicit timezone conversion.

Tests involving time should use deterministic/fixed clocks where practical.

---

# 48. External API Isolation

Telegram API calls should be wrapped behind an integration/service abstraction.

Avoid direct Bot API calls scattered throughout the project.

Prefer:

```text
TelegramPublisher
TelegramChannelService
TelegramMediaService
```

or equivalent abstractions.

This improves:

* testing;
* retries;
* observability;
* future API changes.

---

# 49. Network Failures

Assume all external calls can fail.

Telegram API failures may be:

* retryable;
* permanent;
* permission-related;
* invalid payload;
* rate-limited.

Do not retry permanent validation errors indefinitely.

Use retry policies based on error category.

---

# 50. Rate Limits

Handle Telegram rate limits explicitly.

If Telegram returns a retry delay, respect it where supported.

Do not create tight retry loops.

Queue retries must use backoff.

---

# 51. Callback Buttons

Callback handlers must be idempotent where an action may be repeated.

Users may:

* double-click;
* press an old button;
* receive delayed callback processing.

Each handler must validate current database state before performing an action.

Example:

An old `Approve` button must not approve a post that is already cancelled or
published.

---

# 52. Stale Telegram UI

Telegram messages are not authoritative application state.

Old inline keyboards may remain visible after state changes.

Every action must verify current state in PostgreSQL.

Where useful, update or remove stale keyboards after a successful state
transition.

---

# 53. User Experience

Users should always understand:

* which post they are editing;
* current status;
* current step;
* what actions are available;
* what happened after an action.

Prefer concise, explicit messages.

Do not expose internal enum names when a friendly label exists.

Bad:

```text
Status: PENDING_REVIEW
```

Preferred UI:

```text
Статус: На согласовании
```

Internal logs may use enum values.

---

# 54. Destructive Actions

Require confirmation for destructive actions such as:

```text
delete draft
cancel publication
remove user
archive template
```

Where practical, prefer soft delete for user-created content.

---

# 55. Documentation

When behavior or architecture changes, update relevant documentation.

Possible files:

```text
README.md
ARCHITECTURE.md
API.md
DEPLOYMENT.md
AGENTS.md
```

Do not update documentation for changes that do not affect documented behavior.

But do not leave documentation knowingly incorrect.

---

# 56. README Expectations

README should explain:

```text
project purpose
technology stack
requirements
local setup
environment variables
database setup
Redis setup
Prisma migration
bot startup
worker startup
webhook setup
tests
Docker usage
```

Commands in README must actually exist.

---

# 57. Migrations and Production Safety

Before creating destructive migrations, consider existing production data.

Potentially dangerous operations include:

```text
DROP COLUMN
DROP TABLE
changing nullable → required
changing enum values
changing primary keys
changing unique constraints
```

When needed, prefer staged migrations:

```text
add field
↓
backfill
↓
deploy compatible code
↓
add constraint
↓
remove old field later
```

---

# 58. Backwards Compatibility

Backward compatibility is important for:

* existing database rows;
* scheduled jobs;
* stored templates;
* serialized JSON;
* callback payloads still visible in Telegram.

When changing serialized structures, consider existing data.

Do not assume all persisted data was created by the newest application version.

---

# 59. JSONB Changes

Fields stored in JSONB require special care.

Examples:

```text
content_json
schema_json
rendering_config_json
payload_json
```

When changing their shape:

* define migration/compatibility strategy;
* validate at read boundaries;
* do not assume all historical rows match the newest schema.

Version structures when appropriate.

---

# 60. Template Versioning

Published or existing posts should not unexpectedly change because a template
was later edited.

Prefer associating a post with a template version or preserving sufficient
rendering information.

Template updates must not retroactively corrupt old publications.

---

# 61. Post Versioning

If `post_versions` is implemented, use it for meaningful content revisions.

Suggested fields:

```text
id
post_id
version
content_json
rendered_text
changed_by
created_at
```

Do not create unnecessary versions for purely technical reads.

---

# 62. Performance

Do not prematurely optimize the MVP.

However, avoid obvious scalability problems:

* N+1 queries;
* loading all posts without pagination;
* unbounded audit queries;
* unbounded Telegram history lists;
* large JSON blobs loaded unnecessarily;
* blocking queue workers with unrelated work.

Lists exposed to users should be paginated.

---

# 63. Database Indexing

Add indexes based on actual query patterns.

Likely candidates:

```text
posts.status
posts.author_id
posts.channel_id
posts.scheduled_at
publication_jobs.status
publication_jobs.scheduled_for
post_reviews.post_id
audit_logs.entity_id
channel_members.user_id
channel_members.channel_id
```

Avoid adding indexes blindly to every column.

---

# 64. Pagination

All potentially growing collections should support pagination.

Examples:

```text
drafts
publications
audit history
users
templates
review queue
```

Do not fetch an unlimited dataset into memory.

---

# 65. Worker Separation

The Telegram application process and publication worker must be logically
separable.

Expected deployment:

```text
app
worker
postgres
redis
```

The app enqueues publication work.

The worker performs publication work.

Do not require the Telegram bot process to remain alive for already scheduled
jobs to execute if the worker is healthy.

---

# 66. Graceful Shutdown

Application and workers should shut down gracefully.

On shutdown:

* stop receiving new work;
* close queue workers;
* close database connections;
* close Redis connections;
* allow active operations to finish where safe.

Avoid abrupt termination during publication if graceful handling is possible.

---

# 67. Docker

The project must remain runnable through Docker Compose.

Do not introduce host-specific assumptions.

Avoid relying on:

```text
developer machine global packages
hardcoded Windows paths
hardcoded Linux home paths
local-only services
```

All required services should be documented and reproducible.

---

# 68. Local / Staging / Production

Maintain clear environment separation.

Never point local or staging configuration at production resources by default.

Staging should use:

* separate Telegram bot;
* separate test channel;
* separate PostgreSQL database;
* separate Redis.

---

# 69. No Hidden Production Actions

Do not perform production-impacting operations without explicit instruction.

This includes:

* running production migrations;
* deleting production data;
* publishing real Telegram posts;
* changing real bot webhook configuration;
* rotating credentials;
* modifying live channel permissions.

Code may be prepared for these operations without executing them.

---

# 70. Do Not Commit Generated Secrets

Before completing work, inspect changed files for accidental secrets.

Pay particular attention to:

```text
.env
docker-compose overrides
logs
debug output
test fixtures
README examples
```

Use dummy values in documentation.

---

# 71. Dependencies

Before adding a dependency, ask:

1. Is it necessary?
2. Does an existing dependency already solve this?
3. Is the package actively maintained?
4. Is the functionality simple enough to implement locally?
5. Does the dependency materially increase runtime or security surface?

Do not add packages for trivial utility functions.

Avoid multiple libraries solving the same problem.

---

# 72. Dependency Updates

Do not mass-update dependencies as part of an unrelated task.

If a dependency must be updated for the task:

* update the minimal set;
* inspect breaking changes;
* run tests;
* mention the update in the completion summary.

---

# 73. Git Discipline

Prefer focused changes.

A logical change should not modify unrelated files without reason.

Never discard or overwrite uncommitted user work.

Do not use destructive Git commands unless explicitly requested.

Avoid:

```bash
git reset --hard
git clean -fd
```

unless the task explicitly requires them and consequences are understood.

---

# 74. Existing Changes

Before editing a file, consider whether it already contains user modifications.

Preserve unrelated work.

When a file has concurrent or unexpected modifications, adapt the patch rather
than replacing the whole file.

---

# 75. Generated Files

Do not manually edit generated files unless required.

Examples may include:

```text
Prisma generated client
compiled JavaScript
coverage output
build artifacts
lockfile internals
```

Change source configuration and regenerate instead.

Lockfiles should be updated through the package manager.

---

# 76. Implementation Workflow

For substantial tasks:

1. inspect current architecture;
2. locate relevant modules;
3. identify affected data model;
4. identify state transitions;
5. identify permission implications;
6. identify Telegram/UI implications;
7. identify queue implications;
8. implement the smallest coherent solution;
9. add/update tests;
10. run relevant validation;
11. review changed files;
12. update documentation if required.

---

# 77. Definition of Done for Code Changes

A task is not complete merely because code compiles.

Where applicable, verify:

```text
implementation matches requested behavior
permissions are enforced
invalid state transitions are rejected
persistent state survives restart
duplicate publication is prevented
errors are handled
tests pass
types pass
lint passes
build passes
documentation remains correct
```

Run the narrowest useful checks first, then broader checks when appropriate.

---

# 78. Before Finalizing a Change

Review:

```text
git diff
```

Look specifically for:

* accidental unrelated changes;
* debugging output;
* commented-out code;
* secrets;
* duplicate logic;
* unhandled error cases;
* missing tests;
* incorrect migrations;
* stale documentation.

Do not leave temporary code such as:

```ts
console.log(...)
TODO fix later
throw new Error('test')
```

unless explicitly intentional.

---

# 79. Agent Response After Work

When reporting completed implementation, summarize:

1. what changed;
2. important architectural decisions;
3. files/modules affected;
4. tests/checks run;
5. anything not completed or requiring follow-up.

Do not claim tests passed if they were not executed.

Do not claim behavior was verified when it was only inferred.

---

# 80. When Requirements Are Ambiguous

Prefer existing documented product behavior.

When multiple implementations are possible:

1. preserve architecture;
2. choose the simplest solution compatible with future expansion;
3. avoid speculative features;
4. avoid broad refactoring.

Do not invent major product behavior that was not requested.

---

# 81. MVP First

Do not implement future roadmap features unless required by the current task.

Examples of future features:

```text
AI assistant
web frontend
advanced analytics
Google Drive
Notion
Google Sheets
RSS
S3
crossposting
Telegram Stories
complex multi-stage editorial workflow
```

Architecture may prepare clean extension points.

Do not build unused infrastructure prematurely.

---

# 82. Primary Engineering Priorities

When trade-offs are required, prioritize:

1. correctness;
2. data integrity;
3. publication safety;
4. idempotency;
5. clear permission boundaries;
6. recoverability;
7. maintainability;
8. user experience;
9. performance;
10. abstraction for hypothetical future needs.

A slightly simpler system that publishes correctly once is better than a more
abstract system that risks duplicate or inconsistent publications.

---

# 83. Critical Invariants

The following invariants must never be violated:

1. An unauthorized user cannot perform protected operations.
2. A user cannot bypass channel permissions through Telegram callback data.
3. A post cannot move through an invalid workflow transition.
4. A post must not be published twice because the same operation was retried.
5. Restarting the app must not erase drafts or scheduled publication state.
6. Preview and publication must use the same rendering rules.
7. Scheduled publication must not depend solely on in-memory timers.
8. Telegram handlers must not become the primary location of business logic.
9. Secrets must never be committed to the repository.
10. Important state transitions must be auditable.
11. A stale Telegram button must not override current database state.
12. A failed retry must not duplicate already successful Telegram messages.
13. Database migrations must not silently destroy production data.
14. User-visible success must not be reported before the corresponding durable
    operation has succeeded.

---

# 84. Final Rule

When uncertain, optimize for a system that is:

```text
predictable
recoverable
idempotent
testable
auditable
```

Do not optimize for cleverness.

Prefer explicit business rules over hidden conventions.

```

Я бы ещё рекомендовал рядом с этим `AGENTS.md` держать три отдельных документа: `MVP_SPEC.md` — то ТЗ, которое мы переработали выше; `ARCHITECTURE.md` — уже фактическая архитектура реализованного проекта, а не планы; `DECISIONS.md` или папку `docs/adr/` — для архитектурных решений вроде «почему BullMQ», «почему единый renderer», «как устроена идемпотентность».

Сам `AGENTS.md` я намеренно сделал строгим. Особенно важны разделы 3, 10, 16–23, 51–52 и 83. Они не дают агенту постепенно превратить проект в типичного Telegram-бота, где половина бизнес-логики сидит в `bot.on(...)`, Redis используется как база данных, а двойное нажатие «Опубликовать» создаёт два одинаковых поста.
```
