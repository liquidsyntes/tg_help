# E2E Test Infrastructure & Test Architecture Specification
**Document**: `TEST_INFRA.md`  
**Author**: `test_writer_e2e` (Quality Assurance & E2E Testing Specialist)  
**Date**: 2026-09-21  
**Project**: Telegram Content Publisher Bot MVP  
**Authoritative References**: `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`, `c:/TgHelp/.agents/PROJECT.md`, `c:/TgHelp/tasks.md`, `c:/TgHelp/AGENTS.md`

---

## 1. Mission & Testing Philosophy

The Telegram Content Publisher Bot MVP is an editorial publishing system inside Telegram where correctness, durability, and idempotency are mission-critical. A failure in permission checks can expose restricted channels; a failure in concurrency control can overwrite editorial work; and a failure in idempotency can cause duplicate, humiliating public messages in production channels.

### Core Testing Principles:
1. **Opaque-Box & Behavior-Driven Testing**: Tests interact with the system strictly through defined domain boundaries, commands, and simulated Telegram transport updates. Tests assert observable outcomes (database state changes, audit entries, emitted Telegram payloads, and queue jobs) rather than testing internal private methods.
2. **Zero Facade Tests**: Every test exercises real business logic, state transitions, validation rules, or worker routines. No tests that always pass or trivial mocks that bypass validation are permitted.
3. **Deterministic & Isolated Execution**: Each test sets up its own fixtures or resets shared state, operates with explicit clocks or deterministic time offsets, and cleans up after execution. No test depends on the execution order of other tests.
4. **Authoritative Derivation of Expected Outputs**: Expected outputs are never guessed or hardcoded to match an ad-hoc implementation; they are derived directly from:
   - `ORIGINAL_REQUEST.md` (Acceptance criteria for auth, autosave, idempotency, retries)
   - `tasks.md` (State transitions in §6, wizard steps in §9, review flows in §13, limits in §18, scheduling in §19, retry in §22)
   - `AGENTS.md` (Idempotency key format in §21, partial publishing resume in §23, OCC versioning in §13, Telegram limits in §18)
   - `PROJECT.md` (Interface contracts and 48 feature inventory definitions)
5. **Hermetic CI/CD Execution**: Tests must run without real Telegram bot tokens, live Telegram channels, or manual user intervention. The Telegram Bot API and BullMQ triggers are abstracted through robust, stateful test doubles.

---

## 2. Test Architecture & Directory Layout

The testing infrastructure is organized under `tests/` at the repository root, adhering strictly to the layout defined in `PROJECT.md`:

```text
tests/
├── e2e/                                # End-to-End opaque-box test suites
│   ├── jest-e2e.json                   # Jest E2E configuration
│   ├── tier1-feature-coverage.spec.ts  # Tier 1: Isolated feature verification (happy-paths)
│   ├── tier2-boundary-cases.spec.ts    # Tier 2: Boundary, negative & concurrency invariants
│   ├── tier3-cross-feature.spec.ts     # Tier 3: Multi-feature workflows & lifecycle combinations
│   └── tier4-application-scenarios.spec.ts # Tier 4: Complete real-world author-to-publication flows
├── fixtures/                           # Seed data, personas & template fixtures
│   ├── test-users.ts                   # Super Admin, Editor, Author, Unauthorized, Deactivated
│   ├── test-channels.ts                # Production & Staging channels with Europe/Kyiv tz
│   └── test-templates.ts               # News, Long-read, Photo, Freeform template schemas
├── harness/                            # Test runner infrastructure & simulation drivers
│   ├── test-harness.ts                 # Unified test harness context & lifecycle manager
│   ├── bot-driver.ts                   # Simulates Telegram updates, commands & callbacks
│   └── queue-driver.ts                 # Simulates BullMQ job dispatch, execution & worker retries
└── mocks/                              # High-fidelity test doubles
    ├── mock-telegram-publisher.ts      # Stateful ITelegramPublisher double tracking messages & failures
    └── mock-notification-service.ts    # Records emitted domain notifications for verification
```

> **Note on Workspace Hygiene**: In accordance with project rules, `.agents/` contains only agent metadata and specifications (`TEST_INFRA.md`, `TEST_READY.md`). All runnable test suites and test harness code reside in `tests/`.

---

## 3. Test Doubles & Simulation Harness

### 3.1 MockTelegramPublisher (`ITelegramPublisher`)
The Telegram API is an external boundary that must never be called with live tokens during automated test runs. `MockTelegramPublisher` implements the `ITelegramPublisher` interface defined in `PROJECT.md § Interface Contracts`:

```typescript
export interface OutgoingMedia {
  type: 'photo' | 'video' | 'document' | 'animation';
  fileId: string;
  caption?: string;
}

export interface SendOptions {
  parseMode?: 'HTML';
  disableWebPagePreview?: boolean;
}

export interface ITelegramPublisher {
  sendMediaGroup(chatId: string, media: OutgoingMedia[]): Promise<number[]>;
  sendMessage(chatId: string, text: string, options?: SendOptions): Promise<number>;
  isRetryable(error: Error): boolean;
  getRetryDelay(error: Error): number | null;
}
```

#### Capabilities of `MockTelegramPublisher`:
- **Stateful Message Recording**: Assigns auto-incrementing integer message IDs (e.g., `1001`, `1002`) and records every outbound message with its target `chatId`, payload, formatting, and timestamp.
- **HTML & Length Limit Validation**: Enforces Telegram constraints (caption $\le 1024$ chars, text $\le 4096$ chars, media group size $2..10$ items). Rejects unescaped or forbidden HTML tags.
- **Simulated Failure Injection**:
  - `simulateTransientFailure(count, error)`: Simulates network timeouts or HTTP 500 errors for $N$ consecutive calls before succeeding.
  - `simulateRateLimit(retryAfterSeconds)`: Simulates Telegram HTTP 429 rate limit with `retry_after` header.
  - `simulatePermanentFailure(error)`: Simulates chat not found, bot kicked from channel, or forbidden bot rights.
- **Inspection Utilities**: Provides `getSentMessages(chatId)`, `getLastMessage()`, `clear()`, and assertions on call counts.

### 3.2 BotDriver (Telegram Transport Simulation)
Simulates user interactions coming from grammY updates without running an external webhook or polling loop:
- `sendStart(telegramId)`: Simulates `/start` command.
- `sendTextMessage(telegramId, text)`: Simulates typing text (e.g. title, body, tags).
- `sendMedia(telegramId, mediaItem)`: Simulates uploading photo, video, or document with `file_id`.
- `clickButton(telegramId, callbackData)`: Simulates clicking inline keyboard buttons (e.g., `action:approve:postId`, `action:request_revision:postId`, `action:publish:postId`).
- Captures bot replies: Verifies response text, menu options, and attached inline keyboards.

### 3.3 QueueDriver (BullMQ Publishing & Worker Simulation)
Decouples test execution from asynchronous Redis timing:
- Captures jobs enqueued to the publication queue (`publish` queue).
- Inspects job attributes: `postId`, `postVersion`, `idempotencyKey` (`publish:{postId}:{version}`).
- Allows synchronous or stepped triggering of `PublishingWorker.process(job)` to verify:
  - Immediate execution.
  - Retry on transient errors with backoff parameters.
  - Terminal transition to `PUBLISH_FAILED` upon retry exhaustion.
  - Partial publishing resume without duplicating previously recorded message IDs.

---

## 4. Test Tier Hierarchy (Tiers 1–4 + Tier 5 Hardening)

The test suite is structured into four authoritative tiers as mandated by the project prompt and `PROJECT.md`:

```text
+-------------------------------------------------------------------------+
| Tier 4: Real-World Application Scenarios (Full End-to-End Lifecycles)   |
+-------------------------------------------------------------------------+
| Tier 3: Cross-Feature Combinations (Review Loops, Scheduling, Resume)   |
+-------------------------------------------------------------------------+
| Tier 2: Boundary & Corner Cases (OCC, HTML Sanitize, Limits, Retries)   |
+-------------------------------------------------------------------------+
| Tier 1: Feature Coverage (Isolated Happy Paths: Auth, Draft, State, OCC)|
+-------------------------------------------------------------------------+
```

---

### Tier 1: Feature Coverage (Isolation & Happy Paths)
Verifies each feature in isolation against its defined functional contract.

| Test ID | Feature Covered | Test Description | Authoritative Source | Expected Observable Output |
|---|---|---|---|---|
| `T1-AUTH-01` | F-01: Telegram ID Auth | Unknown user executes `/start` | `tasks.md §7`, `ORIGINAL_REQUEST.md AC` | Access denied message: "У вас пока нет доступа к редакции. Обратитесь к администратору." |
| `T1-AUTH-02` | F-01, F-02: Deactivated User | Inactive/blocked user executes `/start` | `AGENTS.md §8` | Access denied / `UserDeactivatedException`. No menu rendered. |
| `T1-AUTH-03` | F-02, F-03: Author Menu | Active user with Author role executes `/start` | `tasks.md §8` | Menu rendered with: "➕ Создать пост", "📝 Мои материалы", "📅 Контент-план", "📚 Публикации", "❓ Помощь". |
| `T1-AUTH-04` | F-02, F-03: Editor Menu | Active user with Editor role executes `/start` | `tasks.md §8` | Menu rendered with: "➕ Создать пост", "📝 Материалы", "✅ На согласовании", "📅 Контент-план", "📚 Публикации", "👥 Пользователи", "⚙️ Настройки". |
| `T1-DRAFT-01` | F-08, F-10: Draft Init & Autosave | Author starts draft with template selection | `tasks.md §9`, `AGENTS.md §11, §12` | Post record created in DB with status `DRAFT`, `version = 1`. In-memory session not needed. |
| `T1-DRAFT-02` | F-09, F-10: Step Autosave | Author inputs title, then body | `AGENTS.md §12` | Database updated immediately after title; database updated immediately after body. Server restart preserves draft. |
| `T1-STATE-01` | F-23, F-41: Submit Review | Author transitions `DRAFT -> PENDING_REVIEW` | `AGENTS.md §10`, `tasks.md §6` | Status is `PENDING_REVIEW`; audit log record created (`submitted_for_review`). |
| `T1-STATE-02` | F-25: Editor Approval | Editor transitions `PENDING_REVIEW -> APPROVED` | `AGENTS.md §10`, `tasks.md §6` | Status is `APPROVED`; notification event emitted to author. |
| `T1-STATE-03` | F-27: Editor Rejection | Editor transitions `PENDING_REVIEW -> REJECTED` | `AGENTS.md §10`, `tasks.md §6` | Status is `REJECTED`; notification event emitted to author. |
| `T1-IDEMP-01` | F-30, F-31: Enqueue Job & Key | Trigger publish on approved post | `AGENTS.md §20, §21` | Creates `publication_jobs` record with `idempotency_key = "publish:{postId}:{version}"`. BullMQ job enqueued. |
| `T1-IDEMP-02` | F-31: Duplicate Publish Rejection | Repeated publish trigger on same version | `ORIGINAL_REQUEST.md AC`, `AGENTS.md §21` | Second request rejected due to unique idempotency key. Exactly 1 job processed, 1 publication executed. |

---

### Tier 2: Boundary & Corner Cases (Negative Invariants & Limits)
Verifies error handling, security invariants, constraints, and race conditions.

| Test ID | Boundary Area | Test Scenario | Authoritative Source | Expected Error / Invariant Enforcement |
|---|---|---|---|---|
| `T2-REV-01` | Review Feedback | Editor requests revision with empty comment | `tasks.md §13` ("Для возврата на доработку обязателен комментарий") | Fails validation (`ValidationError` / empty comment rejected). Status remains `PENDING_REVIEW`. |
| `T2-SCHED-01` | Scheduling Boundary | Schedule publication with datetime in the past | `AGENTS.md §24`, `tasks.md §19` | Fails preflight validation: "Нельзя планировать публикацию в прошлом". Status remains unchanged. |
| `T2-OCC-01` | Optimistic Concurrency | User B updates post while expecting `version = 1`, but User A already updated to `version = 2` | `AGENTS.md §13`, `tasks.md §12` | OCC conflict (`PostConflictException`). 0 rows updated in DB. User notified: "Публикация была изменена другим пользователем." |
| `T2-HTML-01` | HTML Sanitization | Content containing `<script>`, `<iframe>`, `<img onerror>` | `AGENTS.md §17`, `tasks.md §17` | Script tags stripped / escaped. Only allowed Telegram HTML tags (`<b>`, `<i>`, `<a>`, `<code>`, `<blockquote>`) retained. |
| `T2-HTML-02` | Unclosed HTML Tags | Content containing unclosed `<b>text without closing` | `AGENTS.md §17` | Canonical sanitizer automatically balances tags or rejects invalid markup before enqueue. |
| `T2-LIMIT-01` | Text Limits | Body text length exceeding 4096 characters | `AGENTS.md §18`, `PROJECT.md § Interface Contracts` | Triggers multi-message splitting into valid chunks $\le 4096$ chars or validation error. |
| `T2-LIMIT-02` | Media Group Limits | Media group upload with 1 item or 11 items | `AGENTS.md §18`, `telegram-limits.ts` | Rejected: Telegram media groups require between 2 and 10 items. |
| `T2-RETRY-01` | Retry Exhaustion | Worker encounters 3 consecutive 500 errors | `tasks.md §22, §35`, `ORIGINAL_REQUEST.md AC` | Worker retries with exponential backoff. On 3rd failure, status transitions to `PUBLISH_FAILED`, notification sent to editor. |

---

### Tier 3: Cross-Feature Combinations & Complex Lifecycles
Verifies interactions between multiple domain services across state lifecycles.

| Test ID | Combination Scenario | Steps & Invariants Tested | Authoritative Source | Expected Result |
|---|---|---|---|---|
| `T3-CYCLE-01` | Full Editorial Revision Cycle | 1. Author submits draft (`DRAFT -> PENDING_REVIEW`).<br>2. Editor requests revision with comment ("Fix title").<br>3. Status becomes `NEEDS_REVISION`.<br>4. Author modifies title (version increments).<br>5. Author resubmits (`NEEDS_REVISION -> PENDING_REVIEW`).<br>6. Editor approves (`PENDING_REVIEW -> APPROVED`). | `tasks.md §6, §13`, `AGENTS.md §10` | All transitions recorded in `audit_logs` in chronological sequence. Final status is `APPROVED`. |
| `T3-SCHED-01` | Future Scheduling & Cancellation | 1. Post approved.<br>2. Editor schedules for `NOW + 2 hours` in `Europe/Kyiv`.<br>3. Status becomes `SCHEDULED`, delayed job queued.<br>4. Editor cancels schedule.<br>5. Status becomes `CANCELLED`. Queue job removed. | `tasks.md §6, §19`, `AGENTS.md §24` | Post transitions `APPROVED -> SCHEDULED -> CANCELLED`. No publication executed. |
| `T3-RESUME-01` | Partial Publication Resume on Retry | 1. Logical post has media group + text message.<br>2. Worker sends media group successfully (records message IDs `[201, 202]`).<br>3. Worker fails sending text message (network error).<br>4. Worker retries job.<br>5. Worker checks `telegram_message_ids`, skips media group, sends only text message (ID `203`). | `AGENTS.md §23`, `tasks.md §23` | Zero duplicate messages in channel. Both parts recorded. Post status updated to `PUBLISHED`. |

---

### Tier 4: Real-World Application Scenarios (End-to-End Lifecycles)
Simulates end-to-end user workflows from Telegram updates through database, queues, worker, and mock publisher.

| Test ID | Scenario Name | Description | Key Verifications |
|---|---|---|---|
| `T4-E2E-01` | Complete Author-to-Channel Publishing Lifecycle | Author authenticates -> creates draft -> selects template -> inputs fields with autosave -> uploads media -> previews post -> submits for review -> editor reviews card -> editor approves -> editor publishes -> worker processes -> post published to channel. | - Zero direct Telegram API calls from callback handler.<br>- Database contains autosaved states.<br>- Audit log contains complete trace.<br>- `MockTelegramPublisher` records verified published payload.<br>- Post status is `PUBLISHED`, `published_at` set. |
| `T4-SEC-01` | Unauthorized Action & Permission Escalation Attacks | Author attempts to approve own draft or trigger publish. User without channel membership attempts draft creation. Deleted post publication attempt. | - All unauthorized actions rejected with `PermissionDeniedException` or `UnauthorizedException`.<br>- Server-side check blocks action even if button was clicked.<br>- Database state remains unchanged. |
| `T4-REC-01` | Publication Failure Recovery & Manual Retry | Post approved -> publication job fails 3 times -> marks `PUBLISH_FAILED` -> editor receives alert and clicks `🔁 Повторить публикацию` -> worker retries successfully. | - Safe transition `PUBLISH_FAILED -> PUBLISHING -> PUBLISHED`.<br>- New idempotency version generated.<br>- Manual retry succeeds without duplicating earlier steps. |

---

## 5. Non-Deterministic Output & Known Variances

When writing assertions in E2E tests, certain values are inherently non-deterministic. The test framework handles these using standardized matching rules:

| Field | Nature of Variance | Validation Strategy |
|---|---|---|
| `id` / `postId` / `jobId` | Random UUID v4 | Match using regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` |
| `created_at` / `updated_at` / `published_at` | Wall-clock timestamps | Assert within temporal window: `expect(date.getTime()).toBeCloseTo(Date.now(), -4)` (within 10s) |
| `idempotency_key` | Generated string `publish:{postId}:{version}` | Assert exact pattern with matching post UUID and integer version |
| `telegram_message_ids` | Sequential IDs from mock publisher | Assert exact array of generated integer IDs recorded by mock |

---

## 6. Execution Instructions

### Running E2E Test Suites
```bash
# Run all E2E tests via Jest
npm run test:e2e

# Run specific tier
npx jest --config tests/e2e/jest-e2e.json tests/e2e/tier1-feature-coverage.spec.ts
npx jest --config tests/e2e/jest-e2e.json tests/e2e/tier2-boundary-cases.spec.ts
npx jest --config tests/e2e/jest-e2e.json tests/e2e/tier3-cross-feature.spec.ts
npx jest --config tests/e2e/jest-e2e.json tests/e2e/tier4-application-scenarios.spec.ts

# Run using Node 24 native test runner (standalone mode)
node --test tests/e2e/run-all-e2e.ts
```

---

## 7. Compliance Checklist

- [x] Opaque-box testing model established.
- [x] Zero facade tests; all tests assert business invariants and observable state.
- [x] Tiers 1 through 4 comprehensively defined and mapped to features F-01 to F-48.
- [x] Authoritative source of truth documented for every test case.
- [x] High-fidelity test doubles designed for Telegram API and BullMQ queue.
- [x] Layout compliance: all test code placed in `tests/`, `.agents/` contains only specifications.
- [x] Non-deterministic variances explicitly documented.
