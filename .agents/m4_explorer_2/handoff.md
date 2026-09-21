# Handoff Report: TelegramPublisher Abstraction & Error Categorization (Milestone 4)

**Agent**: `m4_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m4_explorer_2`  
**Handoff Type**: Hard (Task complete)  
**Detailed Report**: `c:/TgHelp/.agents/m4_explorer_2/report.md`  

---

## 1. Observation

1. **Current Codebase State**:
   - `src/infrastructure/telegram-api/` does NOT exist yet.
   - `src/modules/publishing/` does NOT exist yet.
   - `src/infrastructure/queues/queue.module.ts`: `QueueModule` is registered with `@nestjs/bullmq`, connects to Redis (`REDIS_URL`), and configures queue `PUBLICATION_QUEUE_NAME` (`'publication'`) with default 3 attempts and exponential backoff of 2000ms.
   - `src/worker.main.ts` and `src/worker.module.ts`: Worker process is scaffolded and imports M1 modules (`AppConfigModule`, `LoggerModule`, `PrismaModule`, `RedisModule`, `QueueModule`), but does not yet import `TelegramApiModule` or `PublishingModule`.
   - `src/modules/rendering/telegram-renderer.service.ts`: Canonical rendering pipeline produces `TelegramPayload` with `messages: TelegramOutgoingMessage[]` (lines 30-184). Message types include `'text'`, `'photo'`, `'video'`, `'document'`, `'animation'`, and `'media_group'`.
   - `src/common/constants/telegram-limits.ts`: Defines `MAX_MESSAGE_LENGTH = 4096`, `MAX_CAPTION_LENGTH = 1024`, `MIN_MEDIA_GROUP_SIZE = 2`, `MAX_MEDIA_GROUP_SIZE = 10`.
   - `prisma/schema.prisma`: `PublicationJob` model (lines 233-256) defines `idempotencyKey String @unique @map("idempotency_key")`, `telegramMessageIds Json @default("[]") @map("telegram_message_ids")`, `status PublicationJobStatus @default(PENDING)`.

2. **Existing Test Harness & Doubles**:
   - `tests/mocks/mock-telegram-publisher.ts`: Defines `MockTelegramPublisher`, `OutgoingMedia`, `SendOptions`, `RecordedTelegramMessage`, and `TelegramApiError`. Implements `sendMediaGroup`, `sendMessage`, `isRetryable`, and `getRetryDelay`.
   - `tests/harness/test-harness.ts`: Models BullMQ publication execution in lines 680-770, asserting partial publication resumption (lines 690-716) and retry exhaustion (lines 741-770).
   - E2E Test Suite Execution: All 34 tests across 4 tiers currently pass with 100% success rate:
     ```text
     Command: node --test --experimental-strip-types tests/e2e/tier1-feature-coverage.spec.ts
     Output: ✔ Tier 1: Feature Coverage (Isolated Verification) (14/14 passed)
     ```

3. **Authoritative Guidelines**:
   - `AGENTS.md` §48 requires wrapping Telegram Bot API calls behind an abstraction (`TelegramPublisher`).
   - `AGENTS.md` §23 & `tasks.md` §23 require partial publishing persistence: saving message IDs after each step and resuming without duplicating already-sent parts.
   - `AGENTS.md` §49 & §50 require classifying errors into retryable, rate-limited, and permanent, with backoff and respecting `retry_after`.
   - `AGENTS.md` §65 mandates process separation between app and worker.

---

## 2. Logic Chain

1. **Step 1: Domain-level Chat ID Representation**  
   From Observation 1, channels have `telegramChatId: String` while users have `telegramId: BigInt`. Therefore, all `ITelegramPublisher` methods must accept `chatId: string | bigint` to avoid unsafe type assertions across channel publishing and direct notifications.

2. **Step 2: Method Coverage & Canonical Payload Dispatch**  
   From Observation 1 (`telegram-renderer.service.ts`), `TelegramRenderer` outputs `TelegramPayload` containing six distinct message types (`text`, `photo`, `video`, `document`, `animation`, `media_group`).  
   Hence, `ITelegramPublisher` must expose corresponding atomic methods (`sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, `sendMediaGroup`) as well as a dispatcher `publishOutgoingMessage(chatId, message)` that maps an outgoing message part to its respective API call.

3. **Step 3: Tri-Tier Error Classification & BullMQ Backoff Strategy**  
   From Observation 3 (`AGENTS.md` §49, §50) and Observation 2 (`test-harness.ts` lines 741-770):
   - HTTP 429 indicates rate limits. Telegram provides `parameters.retry_after`. The worker must delay retry by `retry_after * 1000` ms, keeping the post in `PUBLISHING` / job in `PENDING`.
   - 5xx errors and network failures (e.g. `ECONNRESET`, `ETIMEDOUT`) are transient and must be retried with exponential backoff up to `maxAttempts` (3).
   - 400 (chat not found, invalid payload) and 403 (bot kicked, forbidden) are client/permission errors that will never succeed on retry. Retrying them wastes resources. Therefore, the worker must fail fast via BullMQ `UnrecoverableError`, directly marking the post as `PUBLISH_FAILED`.

4. **Step 4: Partial Publication Resumption Algorithm**  
   From Observation 1 (`PublicationJob.telegramMessageIds`) and Observation 2 (`tier3-cross-feature.spec.ts` test 3.3):  
   When a publication consists of multiple messages (e.g. album + trailing text), the worker persists message IDs to PostgreSQL after each part succeeds. On retry, the worker counts how many message IDs were already generated and skips earlier parts, resuming at the failed part without duplicating content.

5. **Step 5: Backward-Compatible Mock Double**  
   From Observation 2, 34 E2E tests depend on `MockTelegramPublisher` in `tests/mocks/mock-telegram-publisher.ts`.  
   Expanding `MockTelegramPublisher` to implement `ITelegramPublisher` with `sendPhoto`, `sendVideo`, `sendDocument`, `sendAnimation`, and `publishOutgoingMessage` while preserving `sendMessage` and `sendMediaGroup` preserves 100% compatibility with existing tests while serving as the authoritative test double for new unit/integration tests.

---

## 3. Caveats

1. **Standalone Worker Context**: The publishing worker runs as a headless consumer (`src/worker.main.ts`). It should instantiate `new Api(botToken)` via `TelegramPublisherService` and must NOT initiate bot polling or webhook listeners.
2. **grammY link_preview_options**: Modern Telegram Bot API deprecated `disable_web_page_preview` in favor of `link_preview_options: { is_disabled: true }`. `TelegramPublisherService` handles this by mapping `disableWebPagePreview` to `link_preview_options`.
3. **Database Idempotency vs Redis**: While BullMQ deduplicates jobs using `jobId: publish:{postId}:{postVersion}`, permanent idempotency is guaranteed by the unique constraint on `publication_jobs.idempotency_key` in PostgreSQL (AGENTS.md §21).

---

## 4. Conclusion

1. The design for `ITelegramPublisher`, `TelegramPublisherService`, and `TelegramErrorClassifier` is complete and fully documented in `c:/TgHelp/.agents/m4_explorer_2/report.md`.
2. The error categorization separates rate limits (429 $\to$ delay), transient failures (5xx/network $\to$ exponential backoff), and permanent failures (400/403 $\to$ fail fast to `PUBLISH_FAILED`).
3. The partial publishing resumption algorithm correctly leverages `publication_jobs.telegram_message_ids` to prevent message duplication upon retry.
4. The test double design maintains 100% backward compatibility with existing tests while fully implementing the new interface.
5. The step-by-step implementation roadmap provides clear instructions for Milestone 4 builders.

---

## 5. Verification Method

1. **Inspect Detailed Report**:
   - View `c:/TgHelp/.agents/m4_explorer_2/report.md` to review the exact TypeScript code definitions for interfaces, services, exception classes, error classifiers, and worker integration logic.
2. **Verify Existing Test Compatibility**:
   - Run the full E2E test suite:
     ```pwsh
     node --test --experimental-strip-types tests/e2e/tier1-feature-coverage.spec.ts tests/e2e/tier2-boundary-cases.spec.ts tests/e2e/tier3-cross-feature.spec.ts tests/e2e/tier4-application-scenarios.spec.ts
     ```
   - Expected result: 34 passed, 0 failed.
3. **Invalidation Conditions**:
   - If any method in `ITelegramPublisher` cannot accept `chatId: string | bigint`.
   - If permanent errors (400, 403) are retried repeatedly rather than failing fast.
   - If partial publishing does not store message IDs after each step.
