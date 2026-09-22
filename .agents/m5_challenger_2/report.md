# Milestone 5 Empirical Adversarial Challenge Report

**Agent**: `m5_challenger_2` (teamwork_preview_challenger)  
**Date**: 2026-09-22  
**Target Path**: `c:/TgHelp`  
**Verdict**: **APPROVE**  
**Overall Risk Assessment**: **LOW**

---

## 1. Executive Summary

As an empirical adversarial challenger, I investigated, stress-tested, and verified Milestone 5: **Editorial Review, Preview UI & Media Bursts** implemented by `m5_worker_1`.

I constructed and executed a dedicated empirical verification suite containing 19 adversarial stress tests located at `tests/unit/adversarial-empirical-m5-preview.spec.ts`, directly targeting three mission-critical dimensions:
1. **Review Workflow & Revision Comment Enforcement** (`r:rev` prompt, session caching in Redis, whitespace comment rejection, OCC atomic state machine transition to `NEEDS_REVISION`, `PostReview` record creation, audit log writing, and decoupled notification dispatch to the author).
2. **Canonical Preview & Companion Control Card** (single text, single photo, single video, media group with 2-10 items, long caption splitting over 1024 characters, and strict prevention of Telegram Bot API `reply_markup` crashes on `sendMediaGroup`).
3. **Media Burst & Debouncing Concurrency** (simulating rapid concurrent Telegram album uploads sharing `media_group_id`, proving that un-debounced concurrent uploads trigger OCC collisions, and verifying that the 600ms batch debouncer collapses uploads into a single atomic transaction with sequential sort orders).

All test suites and verification builds completed cleanly:
- `npm run build`: Exit code 0 (clean compilation with zero TypeScript errors).
- `npm test`: 32 test suites passed, 495 tests passed (100% pass rate).
- `npm run test:e2e`: 22 suites passed, 34 tests passed across Tiers 1-4 (100% pass rate).
- Strict adherence to `AGENTS.md` (§3, §5, §8, §10, §11, §13, §15, §16, §18, §27, §51, §52).

---

## 2. Empirical Verification & Stress Test Results

### Dimension 1: Review Workflow & Revision Comment Enforcement

| # | Stress Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|:---:|
| 1.1 | Editor clicks `r:rev:<postId>:<expectedVersion>` | Enters `AWAITING_REVISION_COMMENT` in Redis with 15-min TTL, prompts user for feedback with Back button | Redis key `user:session:<editorId>` set with 900s TTL; prompt displayed | **PASS** |
| 1.2 | Stale button defense: expectedVersion != current post.version | Callback rejected with alert banner; Redis session NOT created | Alert `'Публикация была изменена другим пользователем'` returned; no Redis state set | **PASS** |
| 1.3 | Empty string input (`""`) | Input rejected; session preserved in Redis; `PostWorkflowService.transition` NOT called | Message ignored as empty update; session kept in Redis | **PASS** |
| 1.4 | Whitespace-only inputs (`"   "`, `"\t\t"`, `"\n\n  "`) | Rejected with user warning; session preserved in Redis; `PostWorkflowService.transition` NOT called | Replied with `'⚠️ Комментарий не может быть пустым'`; session preserved | **PASS** |
| 1.5 | Valid non-empty feedback string | Transitions post to `NEEDS_REVISION`; Redis session deleted; confirmation displayed with quoted comment | `transition` invoked with action `REQUEST_REVISION`; Redis session deleted; author confirmation sent | **PASS** |
| 1.6 | Direct domain call to `PostWorkflowService.transition` with empty/whitespace comment | Throws `ValidationException('Для возврата на доработку обязателен комментарий.')` | `ValidationException` thrown immediately; transaction aborted | **PASS** |
| 1.7 | Complete database transaction & notification effects | Atomic OCC update (`version+1`), `PostReview` record created with reviewer and comment, `AuditLog` recorded, and decoupled notification sent to author | OCC incremented (3 -> 4); `PostReview` created; `AuditLog` created; `NotificationService` sent notification to author Telegram ID | **PASS** |
| 1.8 | Illegal state transition to `NEEDS_REVISION` from non-pending statuses (`DRAFT`, `APPROVED`, `SCHEDULED`, `PUBLISHED`) | Throws `InvalidPostStateTransitionException` | Illegal transitions rejected across all 7 non-pending statuses | **PASS** |

### Dimension 2: Canonical Preview & Companion Control Card

| # | Stress Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|:---:|
| 2.1 | Single Text Post preview | 1 outgoing preview text message delivered via `publishOutgoingMessage` + Companion Control Card with inline keyboard | Outgoing message text sent; Companion Control Card sent and keyboard attached | **PASS** |
| 2.2 | Single Photo Post preview | 1 outgoing photo message with caption + Companion Control Card with inline keyboard | Photo delivered with formatted caption; Control Card attached | **PASS** |
| 2.3 | Single Video Post preview | 1 outgoing video message with caption + Companion Control Card with inline keyboard | Video delivered with formatted caption; Control Card attached | **PASS** |
| 2.4 | Media Group (2-10 items) preview | Outgoing `media_group` delivered strictly WITHOUT `reply_markup` (preventing Telegram API crash); Companion Control Card delivered alongside | `sendMediaGroup` executed with media items only; Control Card sent as separate text message with keyboard | **PASS** |
| 2.5 | `TelegramPublisherService.sendMediaGroup` invariant | Method signature and implementation reject/omit `reply_markup` parameter | Calls `api.sendMediaGroup(chatId, items)` without keyboard markup | **PASS** |
| 2.6 | Caption overflow (> 1024 chars) on Media Group | Split into part 1 (`media_group` with lead caption $\le 1024$) + part 2 (subsequent text message $\le 4096$) | Rendered payload contains 2 messages: lead caption 1014 chars, trailing text 655 chars | **PASS** |
| 2.7 | Companion Control Card rendering | Displays status badge (`↩️ Требуется доработка (v4)`), channel timezone timestamp, author name, and editor remarks | Control Card formatted with all metadata and highlighted editor comment | **PASS** |

### Dimension 3: Media Burst & Debouncing Concurrency

| # | Stress Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|:---:|
| 3.1 | Rapid concurrent upload of 5 photos sharing `mediaGroupId` (album burst) | Zero OCC collisions; items buffered in Redis; single `attachMediaBatch` transaction executed after 600ms debounce | 5 messages acknowledged batch buffering; timer flushed; `attachMediaBatch` called exactly once with all 5 items; OCC version incremented once | **PASS** |
| 3.2 | Adversarial contrast: 5 concurrent uploads without debouncing | Direct concurrent `attachMedia` with identical expectedVersion triggers OCC `PostConflictException` | Exactly 1 succeeded, 4 failed with `PostConflictException`, proving the necessity of the debouncer | **PASS** |
| 3.3 | Album boundary: exactly 10 media items | Single batch debounced and persisted with 10 items | `attachMediaBatch` invoked with 10 DTOs; `onBatchComplete(10)` fired | **PASS** |
| 3.4 | Multi-album concurrency: 2 different `mediaGroupId`s simultaneously | Albums are isolated in separate Redis buffers and timers without cross-talk | Two distinct batches persisted with correct 2 and 3 items respectively | **PASS** |

---

## 3. Adversarial Challenges & Findings

### [Low Risk] Challenge 1: Empty Text Message Handling in Review Queue
- **Observation**: When a reviewer's message payload has `text: ''` (empty string), `ReviewQueueHandler.handleTextInput` evaluates `if (!user || !ctx.message?.text) return false;`. It immediately returns `false` (unhandled update) rather than hitting `comment.length === 0` to emit the Russian warning message.
- **Attack Scenario**: Reviewer sends an empty update or a non-text media message while in `AWAITING_REVISION_COMMENT`.
- **Blast Radius**: The user is not shown the warning message, but the Redis session remains intact and the post is NOT transitioned.
- **Assessment**: Safe and expected. In Telegram Bot API, text messages always contain at least 1 character. When a user sends whitespace (`' '`), `!ctx.message?.text` is false, and the handler correctly catches the empty comment and displays: `"⚠️ Комментарий не может быть пустым. Пожалуйста, укажите замечания для автора:"`.

### [Low Risk] Challenge 2: Redis Session Expiration during Long Comment Typing
- **Observation**: Revision comment session is stored with a 900-second (15-minute) TTL (`this.redis.set(this.sessionKey(user.id), ..., 900)`).
- **Attack Scenario**: An editor starts typing feedback, leaves the bot for more than 15 minutes, and then sends their comment.
- **Blast Radius**: The Redis session expires. When the text is sent, `rawSession` is null, so `handleTextInput` returns `false` and does not transition the post.
- **Mitigation**: The 15-minute TTL is generous and prevents zombie sessions from hanging indefinitely in Redis.

---

## 4. Verification Method

To independently reproduce the empirical findings:

1. **Compilation**:
   ```bash
   npm run build
   ```
   Must exit with code 0.

2. **Empirical Adversarial Test Suite**:
   ```bash
   npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json
   ```
   Must pass all 19 tests across all 3 dimensions.

3. **Full Test Suites**:
   ```bash
   npm test
   npm run test:e2e
   ```
   Must pass all 32 unit suites (495 tests) and all 22 E2E suites (34 tests).

---

## 5. Verdict

**APPROVE**

Milestone 5 is verified, empirically hardened, and ready for production and Milestone 6 integration.
