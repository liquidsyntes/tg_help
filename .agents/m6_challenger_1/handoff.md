# Handoff Report — Milestone 6 Phase 2: Tier 5 Adversarial Hardening (Domain Track)

**Agent**: `m6_challenger_1`  
**Role**: `teamwork_preview_challenger` (Critic, Specialist)  
**Date**: 2026-09-22  
**Handoff Type**: Hard (Task Complete)

---

## 1. Observation

1. **Source Code Inspected**:
   - `src/modules/posts/posts.repository.ts`: Lines 54-105 implement `updateWithOcc(postId, expectedVersion, data, tx)`. Uses `updateMany` checking `id`, `version: expectedVersion`, and `deletedAt: null`. If count is 0, checks if post is missing/deleted (throws `ValidationException`), otherwise throws `PostConflictException`.
   - `src/modules/posts/post-workflow.service.ts`: Lines 30-41 define `ALLOWED_TRANSITIONS` for the 10 post statuses. Lines 223-265 execute an atomic `$transaction` containing `updateWithOcc`, `reviewsService.createReview`, and `auditService.record`.
   - `src/modules/publishing/publishing.service.ts`: Lines 35-123 implement `enqueuePublish`. Generates `idempotencyKey = publish:${post.id}:${post.version}`. Handles `P2002` race collisions via `findUniqueOrThrow`. Adds job to BullMQ queue with `jobId: idempotencyKey`.
   - `src/modules/publishing/publishing.processor.ts`: Lines 118-177 implement multi-message dispatch loop with partial publication resume: `sentMessageIds.length >= accumulatedExpectedIds + expectedCount`. Lines 219-329 classify errors via `TelegramErrorClassifier`, handle rate-limiting with `moveToDelayed`, transition post to `PUBLISH_FAILED` on permanent failure or retry exhaustion, and throw `UnrecoverableError`.
2. **New Test Suite Created**:
   - `tests/unit/adversarial-empirical-m6-domain.spec.ts` (22 test cases, 4 dimensions).
3. **Command Execution**:
   - `npx jest tests/unit/adversarial-empirical-m6-domain.spec.ts --config ./tests/jest.json`
     ```text
     PASS tests/unit/adversarial-empirical-m6-domain.spec.ts (5.299 s)
     Test Suites: 1 passed, 1 total
     Tests:       22 passed, 22 total
     Snapshots:   0 total
     Time:        5.299 s
     ```
   - Regression validation across related suites:
     `npx jest tests/unit/adversarial-empirical-m4.spec.ts tests/unit/adversarial-empirical-m4-concurrency.spec.ts tests/unit/adversarial-empirical-m6-domain.spec.ts --config ./tests/jest.json`
     ```text
     Test Suites: 3 passed, 3 total
     Tests:       82 passed, 82 total
     ```
   - Global E2E runner:
     `node --experimental-strip-types tests/e2e/run-all-e2e.ts`
     ```text
     ALL E2E TEST TIERS PASSED (100% SUCCESS — 34 / 34 PASSED)
     ```

---

## 2. Logic Chain

1. **Partial Resume Invariant**: In `PublishingProcessor`, `sentMessageIds` tracks all message IDs successfully delivered to Telegram. If a 4-part publication experiences failure at Part 2 in Attempt 1 and Part 3 in Attempt 2, the worker inspects `sentMessageIds.length >= accumulatedExpectedIds + expectedCount` and skips previously delivered parts without re-sending them to Telegram. Test 1.1 proved this empirically across 3 attempts with 0 duplicate deliveries.
2. **Crash-After-Send Resilience**: If a crash occurs after message dispatch but before the post transitions to `PUBLISHED` (Observation 1, `PublishingProcessor:118-177`), Attempt 2 observes `sentMessageIds.length >= 1`, emits 0 calls to Telegram, transitions the post to `PUBLISHED`, and updates `PublicationJob` to `COMPLETED` (Test 1.2).
3. **Concurrency & Idempotency Collisions**: In `PublishingService:35-123`, 50 simultaneous callers check `findUnique` simultaneously and race to `create`. The single winner succeeds, while the remaining 49 collide with Prisma error `P2002`. The catch block recovers via `findUniqueOrThrow`, returning the exact winner's job. BullMQ `queue.add` is called exactly once (Test 2.1).
4. **Manual Retry OCC Decoupling**: When a publication fails, the post transitions to `PUBLISHING` (v+1) then `PUBLISH_FAILED` (v+2). The new idempotency key for manual retry is `publish:{postId}:{v+2}`. This cleanly decouples the new publication job from the old failed job (`publish:{postId}:{v}`) without collision or state mutation (Test 2.2).
5. **Permanent vs Retryable Error Demarcation**: Permanent Telegram errors (400, 401, 403, 404) immediately fail the post, mark the DB job `FAILED`, emit `PostPublicationFailedEvent`, and throw `UnrecoverableError` on attempt 1 (Test 3.1). Transient errors re-throw for exponential backoff on attempts 1-2, and only fail on attempt 3 (exhaustion) (Test 3.5).
6. **OCC Invariants & State Machine Safety**: In `PostsRepository:61-105`, 20 concurrent update requests on the same expected version yield exactly 1 success and 19 `PostConflictException`s (Test 4.1). Soft-deleted posts are rejected immediately (Test 4.3). All 21 illegal state machine transitions are rejected with `InvalidPostStateTransitionException` (Test 4.5).

---

## 3. Caveats

- **Mock Isolation**: Tests in `tests/unit/adversarial-empirical-m6-domain.spec.ts` use high-fidelity mocks for Prisma, BullMQ, and Telegram Publisher to execute hermetically and deterministically in under 6 seconds without external network dependencies.
- **Worker Process Boundary**: Worker execution is verified via direct invocation of `PublishingProcessor.process` simulating BullMQ delivery tokens and job options, rather than running a live Redis server.

---

## 4. Conclusion

The domain, state machine, and publishing track satisfies all architectural specifications (AGENTS.md §10, §13, §20-23, tasks.md §20-23). The implementation is verified to be robust against:
1. Partial publication duplicate messaging across arbitrary multi-part payloads.
2. High-concurrency double-click storms and race conditions on idempotency keys.
3. Rapid error classification between immediate unrecoverable failure and retry backoff.
4. OCC atomic version integrity and strict state machine lifecycle enforcement.

No defects or unhandled critical edge cases were found in the production implementation.

---

## 5. Verification Method

To independently verify these findings:

```pwsh
# 1. Run the Tier 5 adversarial domain suite:
npx jest tests/unit/adversarial-empirical-m6-domain.spec.ts --config ./tests/jest.json

# 2. Run regression checks across related adversarial domain suites:
npx jest tests/unit/adversarial-empirical-m4.spec.ts tests/unit/adversarial-empirical-m4-concurrency.spec.ts tests/unit/adversarial-empirical-m6-domain.spec.ts --config ./tests/jest.json

# 3. Run global E2E runner:
node --experimental-strip-types tests/e2e/run-all-e2e.ts
```

Invalidation conditions:
- Any test in `tests/unit/adversarial-empirical-m6-domain.spec.ts` fails.
- Telegram publisher is called more than once for the same message part during partial publication retry.
- More than 1 `PublicationJob` or BullMQ job is created during concurrent `enqueuePublish` requests for the same post version.
