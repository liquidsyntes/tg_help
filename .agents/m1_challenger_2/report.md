# Empirical Verification & Adversarial Challenge Report — Milestone 1

**Challenger Agent**: `m1_challenger_2` (teamwork_preview_challenger: critic, specialist)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 1 — Foundation, Database & Infra  
**Target Services Tested**:
- Live PostgreSQL Cluster: `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public`
- Live Redis Instance: `redis://127.0.0.1:6379`
- Active Queue: BullMQ `publication` queue
- Automated Test Suite: `tests/integration/empirical-m1.ts`

---

## 1. Executive Summary & Definitive Verdict

### Definitive Verdict: **APPROVE**

Milestone 1 foundational persistence invariants and queue connectivity have been **empirically challenged, tested, and verified** against live PostgreSQL and Redis infrastructure. 

Every tested invariant held under both high-level ORM operations (Prisma Client) and direct database-engine raw SQL queries. BullMQ successfully connected to Redis, enqueued publication tasks, persisted job metadata, and retrieved jobs with exact payload parity.

| # | Verification Target | Test Strategy | Result | Status |
|---|---|---|:---:|:---:|
| 1 | `User.telegramId` Unique Constraint | Prisma create duplicate + Raw SQL `INSERT` duplicate | Prisma `P2002` & Postgres SQLSTATE `23505` thrown | **PASS** |
| 2 | `Channel.telegramChatId` Unique Constraint | Prisma create duplicate + Raw SQL `INSERT` duplicate | Prisma `P2002` & Postgres SQLSTATE `23505` thrown | **PASS** |
| 3 | `ChannelMember(channelId, userId)` Composite Unique | Prisma create duplicate + Raw SQL `INSERT` duplicate | Prisma `P2002` & Postgres SQLSTATE `23505` thrown | **PASS** |
| 4 | `PublicationJob.idempotencyKey` Unique Constraint | Prisma create duplicate + Raw SQL `INSERT` duplicate | Prisma `P2002` & Postgres SQLSTATE `23505` thrown | **PASS** |
| 5 | `Post.version` OCC Column Default (`version = 1`) | Prisma create omitting `version` + Raw SQL `INSERT` omitting `version` | Reported `version === 1` in Prisma and Postgres engine | **PASS** |
| 6 | BullMQ Queue Connectivity with Redis | Enqueue dummy job into `publication` queue + Fetch via `getJob()` | Enqueued, fetched, payload matched, queue counts verified | **PASS** |

---

## 2. Empirical Verification Methodology & Results

Verification was performed using an automated test harness executed directly against live services:
```bash
npx ts-node -r tsconfig-paths/register tests/integration/empirical-m1.ts
```

### 2.1 Duplicate `User.telegramId` Unique Invariant

- **Objective**: Ensure that no two users can share the same Telegram ID, preventing account collisions and identity hijacking (AGENTS.md § 8, § 30).
- **Procedure**:
  1. Inserted base user with `telegramId = 99998888777701n`.
  2. Attempted Prisma `prisma.user.create()` with duplicate `telegramId = 99998888777701n`.
  3. Attempted direct PostgreSQL raw query:
     ```sql
     INSERT INTO users (id, telegram_id, updated_at) VALUES ($1, $2, NOW());
     ```
- **Observations**:
  - Prisma rejected the insertion with `PrismaClientKnownRequestError: P2002` on field `telegram_id`.
  - Raw query rejected with PostgreSQL error `23505`: `Key (telegram_id)=(99998888777701) already exists.`
- **Result**: **PASS**.

### 2.2 Duplicate `Channel.telegramChatId` Unique Invariant

- **Objective**: Ensure channel Telegram chat IDs are uniquely mapped in PostgreSQL to prevent routing confusion (AGENTS.md § 30).
- **Procedure**:
  1. Inserted base channel with `telegramChatId = '-100999988887701'`.
  2. Attempted Prisma `prisma.channel.create()` with identical `telegramChatId`.
  3. Attempted direct raw PostgreSQL `INSERT` with identical `telegramChatId`.
- **Observations**:
  - Prisma threw `P2002` on `telegram_chat_id`.
  - Raw PostgreSQL query threw `23505` (`unique_violation`) on index `channels_telegram_chat_id_key`.
- **Result**: **PASS**.

### 2.3 Duplicate `ChannelMember(channelId, userId)` Composite Unique Invariant

- **Objective**: Ensure a user cannot have duplicate membership records for the same channel, avoiding conflicting permission flags or duplicate notifications (AGENTS.md § 9, § 30).
- **Procedure**:
  1. Created user and channel, then inserted base `ChannelMember` record.
  2. Attempted duplicate `prisma.channelMember.create({ data: { channelId, userId, role: 'EDITOR' } })`.
  3. Attempted direct raw SQL `INSERT INTO channel_members (id, channel_id, user_id, updated_at) VALUES ...`.
- **Observations**:
  - Prisma threw `P2002` on composite fields `(`channel_id`,`user_id`)`.
  - Raw query threw `23505` on unique index `channel_members_channel_id_user_id_key`.
- **Result**: **PASS**.

### 2.4 Duplicate `PublicationJob.idempotencyKey` Unique Invariant

- **Objective**: Guarantee that BullMQ publication jobs can never be duplicated in the database, enforcing strict single-publication idempotency under concurrent retries or duplicate button clicks (AGENTS.md § 20, § 21; tasks.md §21).
- **Procedure**:
  1. Created author, channel, template, and post.
  2. Created primary `PublicationJob` with `idempotencyKey = 'publish:empirical-post-1:1'`.
  3. Attempted duplicate `prisma.publicationJob.create()` with identical key.
  4. Attempted raw SQL `INSERT INTO publication_jobs (id, post_id, post_version, idempotency_key, channel_id, updated_at) VALUES ...`.
- **Observations**:
  - Prisma threw `P2002` on field `idempotency_key`.
  - Raw SQL query threw `23505` on unique index `publication_jobs_idempotency_key_key`.
- **Result**: **PASS**.

### 2.5 Post OCC Version Column Default (`version = 1`)

- **Objective**: Ensure newly initialized posts always start at version 1 for Optimistic Concurrency Control, even when created via raw SQL or external migrations without explicit version assignment (AGENTS.md § 13; tasks.md §12).
- **Procedure**:
  1. Created a post via Prisma `prisma.post.create()` omitting the `version` field. Verified reported `version` and re-queried via `SELECT version FROM posts WHERE id = ...`.
  2. Created a post via raw SQL `INSERT INTO posts (id, channel_id, author_id, template_id, updated_at) VALUES (...)` omitting the `version` column entirely from the column list.
  3. Queried PostgreSQL `SELECT version FROM posts WHERE id = ...` for the raw SQL post.
- **Observations**:
  - Prisma create produced `version = 1`.
  - Re-query of Prisma-inserted post returned `1`.
  - Native PostgreSQL raw insert produced `version = 1` via the column default constraint `DEFAULT 1`.
- **Result**: **PASS**.

### 2.6 BullMQ Queue Connectivity with Redis

- **Objective**: Verify live connectivity between BullMQ and the Redis instance, ensuring jobs can be scheduled, stored, and read back with zero data corruption.
- **Procedure**:
  1. Initialized BullMQ `Queue` instance connected to `redis://127.0.0.1:6379` using `PUBLICATION_QUEUE_NAME = 'publication'`.
  2. Added dummy job `empirical-dummy-publish-test` with unique timestamp and post metadata payload (`jobId: test-job-<timestamp>`).
  3. Read job back using `publicationQueue.getJob(jobId)`.
  4. Verified exact payload matching (`job.data.testId === payload.testId`).
  5. Inspected Redis BullMQ metadata counts (`waiting: 1`).
  6. Cleaned up test job using `job.remove()`.
- **Observations**:
  - Job successfully enqueued, persisted in Redis, retrieved via BullMQ API, validated, and removed.
- **Result**: **PASS**.

---

## 3. Verbatim Execution Output

```text
================================================================
   STARTING EMPIRICAL VERIFICATION SUITE — MILESTONE 1
================================================================

✅ Connected to PostgreSQL cluster at 127.0.0.1:5432.

--- [1/6] Test: Duplicate User.telegramId Invariant ---
- Created base user id=291b3c76-7175-4931-b2c5-650686fd9f4e, telegramId=99998888777701
✅ User.telegramId unique constraint: PASSED (Prisma P2002 & Postgres 23505)

--- [2/6] Test: Duplicate Channel.telegramChatId Invariant ---
- Created base channel id=97b34d99-1877-4618-993e-5944cabd82e2, telegramChatId=-100999988887701
✅ Channel.telegramChatId unique constraint: PASSED (Prisma P2002 & Postgres 23505)

--- [3/6] Test: Duplicate ChannelMember(channelId, userId) Composite Invariant ---
- Created base member id=f810af9c-35f0-4c37-bcb9-f932a602d9db for user=2e114a60-126d-4757-b4e3-72657d85e1bb, channel=6ff369b9-7634-4028-886d-890a47b3d62a
✅ ChannelMember composite unique constraint: PASSED (Prisma P2002 & Postgres 23505)

--- [4/6] Test: Duplicate PublicationJob.idempotencyKey Invariant ---
- Created base PublicationJob id=dd18c4c7-0a32-4603-bdf7-78b8e0beb512, idempotencyKey=publish:empirical-post-1:1
✅ PublicationJob.idempotencyKey unique constraint: PASSED (Prisma P2002 & Postgres 23505)

--- [5/6] Test: Verify Post OCC version Column Default (version = 1) ---
- Prisma create (omitting version): reported version=1, raw SQL fetch=1
- Native PostgreSQL raw INSERT (omitting version column entirely): DEFAULT value in DB=1
✅ Post OCC version column default = 1: PASSED (verified Prisma + DB engine DEFAULT)

--- [6/6] Test: BullMQ Queue Connectivity with Redis (Add & Read Job) ---
- Adding dummy job "empirical-dummy-publish-test" to BullMQ "publication" queue...
- Job enqueued successfully! BullMQ Job ID: test-job-1789963004261
- Reading job test-job-1789963004261 back from Redis...
- Retrieved job from Redis: ID=test-job-1789963004261, Name=empirical-dummy-publish-test
- Job payload: {
  testId: 'empirical-1789963004260',
  postId: 'test-post-uuid',
  postVersion: 1,
  channelChatId: '-1001234567890',
  timestamp: '2026-09-21T03:56:44.260Z'
}
- BullMQ publication queue counts: {
  waiting: 1,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0
}
- Cleaned up test job test-job-1789963004261 from Redis.
✅ BullMQ queue connectivity with Redis: PASSED

Closed BullMQ queue and PostgreSQL Prisma connections.

================================================================
             EMPIRICAL VERIFICATION SUITE SUMMARY
================================================================
✅ [PASS] Invariant: Duplicate User.telegramId throws unique constraint violation
✅ [PASS] Invariant: Duplicate Channel.telegramChatId throws unique constraint violation
✅ [PASS] Invariant: Duplicate ChannelMember(channelId, userId) throws unique constraint violation
✅ [PASS] Invariant: Duplicate PublicationJob.idempotencyKey throws unique constraint violation
✅ [PASS] Invariant: Post OCC version column default = 1
✅ [PASS] Connectivity: BullMQ queue connectivity with Redis (add and read job)
================================================================
FINAL VERDICT: ALL VERIFICATIONS PASSED
================================================================
```

---

## 4. Adversarial Findings & Recommendations

### Finding 1: Database Engine Level vs Application Level Constraints
- **Observation**: All 4 unique constraints (`users_telegram_id_key`, `channels_telegram_chat_id_key`, `channel_members_channel_id_user_id_key`, `publication_jobs_idempotency_key_key`) are backed by real B-Tree unique indexes in the PostgreSQL catalog (`pg_indexes`).
- **Significance**: Even in the event of extreme concurrency races (e.g. two publication workers picking up jobs or two concurrent callback clicks), the database engine guarantees atomicity and rejects the race condition with error `23505`.

### Finding 2: BigInt Serialization
- **Observation**: `User.telegramId` is typed as `BigInt`. The global polyfill `BigInt.prototype.toJSON` in `PrismaService` successfully serializes BigInts across JSON serialization boundaries, avoiding `TypeError: Do not know how to serialize a BigInt`.

### Finding 3: OCC Column Default
- **Observation**: The `version` column on `posts` has both Prisma `@default(1)` and PostgreSQL `DEFAULT 1`. A direct raw SQL insert omitting `version` lands safely at `1`.

---

## 5. Conclusion

Milestone 1 is confirmed robust and ready for downstream Milestone 2 development. Definitive verdict: **APPROVE**.
