# Milestone 4 Handoff Report: Review & Adversarial Audit

**Agent**: `m4_reviewer_1` (Roles: `reviewer`, `critic`)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m4_reviewer_1`  
**Milestone**: Milestone 4 (Publishing Engine & BullMQ Idempotency)  
**Verdict**: **APPROVE**

---

## 1. Observation

1. **Idempotency Key & Database Uniqueness**:
   - In `src/modules/publishing/publishing.service.ts`:
     - Line 40: `const idempotencyKey = \`publish:\${post.id}:\${post.version}\`;`
     - Lines 43-54: Checks existing record with `this.prisma.publicationJob.findUnique({ where: { idempotencyKey } })` and returns existing job without creating new DB entries or queue jobs.
     - Lines 71-78: Catches Prisma P2002 duplicate key constraint violation:
       ```typescript
       if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
         return this.prisma.publicationJob.findUniqueOrThrow({ where: { idempotencyKey } });
       }
       ```
     - Line 93: Configures BullMQ job options `{ jobId: idempotencyKey, attempts: 3, backoff: { type: 'exponential', delay: 2000 } }`.
   - In `prisma/schema.prisma`:
     - Line 237: `idempotencyKey String @unique @map("idempotency_key")` on `PublicationJob`.

2. **Two-Stage Preflight Validation**:
   - In `src/modules/publishing/publishing-preflight.service.ts`:
     - Lines 55-160 (`validateStage1`): Validates post status in `[APPROVED, SCHEDULED, PUBLISH_FAILED]`, non-deleted, channel active, `telegramChatId` present, actor has `ChannelPermission.PUBLISH_POST`, template active, content validates against template schema, media group $\le 10$, and canonical dry-run rendering produces $\ge 1$ messages.
     - Lines 166-237 (`validateStage2`): Re-queries fresh post and channel from PostgreSQL inside worker before dispatch, ensures post exists, not soft-deleted, channel active, valid status in `[APPROVED, SCHEDULED, PUBLISHING, PUBLISH_FAILED]`, and throws `TelegramPermanentException` (400) if invalid.

3. **BullMQ Processor Setup & OCC Transitions**:
   - In `src/modules/publishing/publishing.processor.ts`:
     - Line 30: `@Processor(PUBLICATION_QUEUE_NAME, { concurrency: 5 })`
     - Lines 49-57: Graceful worker shutdown:
       ```typescript
       async onModuleDestroy(): Promise<void> {
         if (this.worker) {
           await this.worker.close();
         }
       }
       ```
     - Lines 108-116: Guard against redundant transition during worker retries:
       ```typescript
       if (currentPost.status !== PostStatus.PUBLISHING) {
         currentPost = await this.postWorkflow.transition({
           postId: currentPost.id,
           expectedVersion: currentPost.version,
           targetStatus: PostStatus.PUBLISHING,
           action: PostAction.START_PUBLISHING,
           actorId,
         });
       }
       ```
     - Lines 179-185: Transition to `PUBLISHED` on success with `expectedVersion: currentPost.version`.
     - Lines 286-293: Transition to `PUBLISH_FAILED` on unrecoverable error or retry exhaustion.
     - Lines 135-176: Partial Publication Resume loop tracking `accumulatedExpectedIds`, skipping parts where `sentMessageIds.length >= accumulatedExpectedIds + expectedCount`, and persisting newly assigned message IDs to PostgreSQL after each part.

4. **Independent Test Execution**:
   - Command: `npm run build`
     Result: Exit code 0 (Clean TypeScript compilation).
   - Command: `npm test`
     Result: 18 test suites passed, 18 total; 341 tests passed, 341 total (100% pass rate).
   - Command: `npm run test:e2e`
     Result: 34 tests passed, 22 suites passed, 0 failures across Tiers 1 to 4.

---

## 2. Logic Chain

1. **Durable Idempotency Assurance**:
   - From Observation 1: `idempotencyKey` is derived deterministically from post ID and version (`publish:{post.id}:{post.version}`), which increments under OCC whenever the post content changes.
   - The PostgreSQL unique constraint on `PublicationJob.idempotencyKey` guarantees that no two jobs can ever be inserted for the same post version.
   - In the event of parallel requests (e.g. rapid double clicks), the second insert fails with Prisma error `P2002`, which is caught and resolved to the existing job without adding a second task to BullMQ.
   - Therefore, publication is strictly idempotent across database and queue layers (AGENTS.md §21).

2. **Preflight Boundary Defense**:
   - From Observation 2: Invariants are verified twice. Stage 1 prevents invalid jobs (e.g. missing permissions, invalid schema, inactive channel) from ever entering BullMQ.
   - Stage 2 re-verifies invariants immediately prior to external Telegram API dispatch in the worker. If state changed while the job was queued (e.g. channel deactivated, post soft-deleted), Stage 2 throws a `TelegramPermanentException`.
   - The worker catches this exception, marks the post as `PUBLISH_FAILED`, and throws `UnrecoverableError` to abort without wasteful retries (AGENTS.md §25, §49).

3. **Safe Worker Retries & Partial Resumption**:
   - From Observation 3: If a worker attempt fails due to a network glitch during multi-message publication, message IDs of successfully sent parts are already stored in PostgreSQL.
   - On retry attempt 2 or 3, the post is already in status `PUBLISHING`. The guard `if (currentPost.status !== PostStatus.PUBLISHING)` bypasses `postWorkflow.transition`, preventing an illegal state transition error.
   - The dispatch loop checks `sentMessageIds.length` against expected counts and skips previously dispatched parts, ensuring no message duplication on Telegram channels (AGENTS.md §22, §23).

4. **Integrity & Code Quality**:
   - From Observation 4: Independent build, unit tests, and E2E tests all pass with 100% success rate without manual interventions or mocks in production paths. No hardcoding or dummy facades exist.

---

## 3. Caveats

No caveats. All requirements from the dispatch, `AGENTS.md`, `PROJECT.md`, and `tasks.md` have been comprehensively implemented and independently verified.

---

## 4. Conclusion

Milestone 4 implementation is **APPROVED**.
The publishing pipeline (`PublishingService`, `PublishingPreflightService`, `PublishingProcessor`, `TelegramPublisherService`, and `TelegramErrorClassifier`) is architecturally sound, thoroughly tested, highly resilient against concurrency and network failures, and completely aligned with repository standards.

---

## 5. Verification Method

To independently reproduce this verification:

1. **Compile the project**:
   ```bash
   npm run build
   ```
   *Expected*: Exit code 0, no compilation errors.

2. **Execute all unit tests**:
   ```bash
   npm test
   ```
   *Expected*: 18 test suites passed, 341 tests passed (100%).

3. **Execute all E2E tests**:
   ```bash
   npm run test:e2e
   ```
   *Expected*: 34 tests passed across Tiers 1-4, 0 failures.

4. **Inspect key implementation files**:
   - `src/modules/publishing/publishing.service.ts`
   - `src/modules/publishing/publishing-preflight.service.ts`
   - `src/modules/publishing/publishing.processor.ts`
   - `src/infrastructure/telegram-api/errors/telegram-error.classifier.ts`
