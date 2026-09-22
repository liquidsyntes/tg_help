# Milestone 5 Adversarial Challenge Report — Empirical Re-Verification

**Agent**: `m5_challenger_3` (teamwork_preview_challenger)  
**Roles**: critic, specialist  
**Target Milestone**: Milestone 5 Remediation — Telegram Transport & Interactive Wizard UI  
**Verdict**: **APPROVE**  
**Date**: 2026-09-22  

---

## 1. Challenge Summary

**Overall risk assessment**: **LOW**

The Milestone 5 remediation implemented by `m5_worker_2` addresses the previous failure modes identified in Milestone 5:
1. The hardcoded `:1` in `draft-manager.handler.ts` draft deletion confirmation was eliminated and replaced with dynamic version resolution across all listing, prompt, and confirmation stages.
2. The granular edit callback prefix was compacted to `d:e:`, providing 23 characters of field key headroom and guaranteeing complete compliance with Telegram's 64-byte limit.
3. Invalidation condition verified: `git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts` returns 0 matches.
4. All empirical adversarial test suites, full unit test suites (501 tests across 32 suites), end-to-end integration tests (34 tests across 22 suites), and TypeScript production compilation pass with 100% success rate.

---

## 2. Challenges & Remediation Status

### [Resolved] Challenge 1: Hardcoded Version 1 Breaks Draft Deletion for Any Autosaved Draft (AGENTS.md §13, §31, §54; tasks.md §9, §11)

- **Original Defect**: `draft-manager.handler.ts:108` previously rendered `draft:cdel:${postId}:1`. Any draft autosaved beyond version 1 triggered a `PostConflictException` upon confirmation, making deletion impossible.
- **Empirical Invalidation Check**:
  ```bash
  git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
  ```
  Result: Clean exit with **0 matches**.
- **Remediation Analysis**:
  - `handleListDrafts` encodes the live post version: `draft:del:${d.id}:${d.version}` (line 58).
  - `telegram-bot.service.ts` parses the version string via regex `/^draft:del:([0-9a-fA-F-]+)(?::(\d+))?$/`.
  - `handlePromptDeleteDraft` dynamically parses `versionStr` or queries `postsRepository.findById(postId)` / `draftManagerService.getDraft(postId)` for the latest DB version.
  - Confirmation button renders dynamically: `draft:cdel:${postId}:${version}` (line 125).
  - `handleConfirmDeleteDraft` parses the dynamic version and calls `draftManagerService.deleteDraft(user.id, postId, version)`, matching the actual DB version and successfully soft-deleting the draft.
- **Status**: **RESOLVED & VERIFIED**.

---

### [Resolved] Challenge 2: Telegram 64-Byte Callback Data Budget in Granular Field Editing (AGENTS.md §18; Telegram 64-Byte Limit)

- **Original Defect**: Prefix `draft:edit:${post.id}:${field.key}` consumed 48 bytes before field key, leaving only 16 bytes. Keys $> 16$ characters caused Telegram Bot API `BUTTON_DATA_INVALID` (400 Bad Request) rejections.
- **Remediation Analysis**:
  - In `post-actions.handler.ts:209`, callback prefix was shortened to `d:e:${post.id}:${field.key}`.
  - Base length: `d:e:` (4 bytes) + UUID (36 bytes) + `:` (1 byte) = **41 bytes**.
  - Headroom: $64 - 41 = \mathbf{23}$ bytes available for field keys.
  - In `telegram-bot.service.ts:147`, router accepts both `d:e:` and `draft:edit:`.
- **Empirical Verification**:
  - Longest seeded template key is `description` (11 chars): $41 + 11 = 52$ bytes $\le 64$ bytes (12 bytes safety margin).
  - Maximum test key of 23 characters: $41 + 23 = 64$ bytes $\le 64$ bytes.
  - `draft:del:${uuid}:${version}` for version 1,000,000: 54 bytes $\le 64$ bytes.
  - `draft:cdel:${uuid}:${version}` for version 1,000,000: 55 bytes $\le 64$ bytes.
- **Status**: **RESOLVED & VERIFIED**.

---

## 3. Stress Test Results

### 3.1 Adversarial Empirical Suite (m5_challenger_1)
Command: `npx jest tests/unit/adversarial-empirical-m5.spec.ts --config ./tests/jest.json`

| # | Dimension & Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|:---:|
| 1.1 | Unregistered Telegram ID on message | Russian prompt with tasks.md §7 text & Telegram ID; `next()` NOT called | Handled correctly; ID formatted in `<code>` | **PASS** |
| 1.2 | Unregistered Telegram ID on callback | Answer callback with `show_alert: true` and tasks.md §7 text | Handled with popup alert; `next()` omitted | **PASS** |
| 1.3 | Deactivated user on message | Russian blocked prompt; `next()` NOT called | Caught `UserDeactivatedException`; blocked | **PASS** |
| 1.4 | Deactivated user on callback | Alert popup; `next()` NOT called | Alert displayed; `next()` omitted | **PASS** |
| 1.5 | Non-user update (`ctx.from` undefined) | Graceful skip without crashing | Skipped cleanly without exceptions | **PASS** |
| 1.6 | Database error handling in Auth | Rethrow for exception filter | Caught by outer filter | **PASS** |
| 1.7 | Safe 64-bit BigInt Telegram ID | No truncation; exact precision | Preserved as BigInt and formatted | **PASS** |
| 1.8 | RBAC channel permission check | Author cannot publish/approve | Denied `PUBLISH_POST` and `APPROVE_POST` | **PASS** |
| 2.1 | Step 2 autosave on template selection | Immediately persist draft in PostgreSQL | Created post v1 immediately | **PASS** |
| 2.2 | Step 3 field 1 input autosave | Immediately write title to PostgreSQL | `autosaveStep` v1 -> v2 | **PASS** |
| 2.3 | Step 3 field 2 input autosave | Immediately write body to PostgreSQL | `autosaveStep` v2 -> v3 | **PASS** |
| 2.4 | Interrupted session recovery | Recover from PostgreSQL after Redis loss | Resumed at first missing required field | **PASS** |
| 2.5 | Complete draft recovery | Return `CONTROL_CARD` | Rendered control card | **PASS** |
| 2.6 | Soft-deleted draft recovery | Reject resume | Refused soft-deleted draft | **PASS** |
| 3.1 | CallbackCodec exhaustive permutations | All combinations $\le 64$ bytes | Max observed: 58 bytes $\le 64$ bytes | **PASS** |
| 3.2 | `encodeView` read-only callback | Length $\le 64$ bytes | 43 bytes $\le 64$ bytes | **PASS** |
| 3.3 | Oversized callback payload | Throws explicit Error | Threw byte length error | **PASS** |
| 3.4 | Malformed callback decode | Returns null | Returns null for invalid structures | **PASS** |
| 3.5 | PostControlsKeyboardBuilder lengths | All keyboard buttons $\le 64$ bytes | 100% buttons compliant | **PASS** |
| 4.1 | Stale Submit for Review | Reject mutation; alert toast; refresh card | Stale button rejected; zero mutation | **PASS** |
| 4.2 | Stale Publish Now | Reject mutation; alert toast; refresh card | Stale button rejected; zero enqueue | **PASS** |
| 4.3 | Stale Approve | Reject mutation; alert toast; refresh card | Stale button rejected; zero transition | **PASS** |
| 4.4 | OCC Conflict Exception Filter | Answer callback with `show_alert: true` | Displayed friendly Russian alert | **PASS** |
| 5.1 | Draft deletion of autosaved post | Confirm OCC behavior and dynamic versioning | Passed with expected OCC handling | **PASS** |

**Total**: 24 passed, 24 total.

---

### 3.2 Preview Adversarial Suite (m5_challenger_2)
Command: `npx jest tests/unit/adversarial-empirical-m5-preview.spec.ts --config ./tests/jest.json`

| # | Dimension & Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|:---:|
| 1.1.1 | Initiate revision prompt | Store expected version in Redis session | Redis session saved with version | **PASS** |
| 1.1.2 | Stale revision prompt button | Reject prompt if version is stale | Rejected stale button | **PASS** |
| 1.1.3 | Empty string revision comment | Reject; preserve revision session | Session preserved; re-prompted | **PASS** |
| 1.1.4 | Whitespace-only revision comment | Reject; preserve revision session | Session preserved; re-prompted | **PASS** |
| 1.1.5 | Valid revision comment | Transition to `NEEDS_REVISION`; clear session | Transitioned and session cleared | **PASS** |
| 1.1.6 | Domain-level comment enforcement | Reject empty comment at service level | Thrown domain validation error | **PASS** |
| 1.1.7 | Atomic revision transition | Atomically execute OCC, review, audit, notify | All writes completed atomically | **PASS** |
| 1.1.8 | Illegal revision transition | Reject transition from non-pending status | Threw invalid state transition error | **PASS** |
| 2.1.1 | Single Text Post Preview | Deliver companion control card | Text rendered with companion card | **PASS** |
| 2.1.2 | Single Photo Post Preview | Deliver companion control card | Photo rendered with companion card | **PASS** |
| 2.1.3 | Single Video Post Preview | Deliver companion control card | Video rendered with companion card | **PASS** |
| 2.1.4 | Media Group Preview (2-10 items) | Send album without reply_markup | Album sent; card delivered separately | **PASS** |
| 2.1.5 | SendMediaGroup Telegram safety | Disallow reply_markup on media group | API contract verified | **PASS** |
| 2.1.6 | Caption overflow splitting | Split album + caption >1024 into album + text | Sent album followed by text message | **PASS** |
| 2.1.7 | Control card formatting | Display status badge, timezone date, remarks | Formatted with required metadata | **PASS** |
| 3.1.1 | Rapid burst debounce (5 photos) | Debounce burst into single batch without OCC conflict | 1 batch created; 0 OCC collisions | **PASS** |
| 3.1.2 | Un-debounced burst contrast | Demonstrate OCC conflict without debouncing | Collisions observed as expected | **PASS** |
| 3.1.3 | Maximum media group bound (10 items) | Cleanly handle 10 items in single debounce batch | Handled 10 items successfully | **PASS** |
| 3.1.4 | Multi-album isolation | Isolate concurrent distinct albums simultaneously | Separate albums processed cleanly | **PASS** |

**Total**: 19 passed, 19 total.

---

## 4. Full Suite & Build Verification

1. **Unit Test Suites**:
   - Command: `npm test`
   - Result: **32 passed, 32 total suites; 501 passed, 501 total tests; 0 failures**.
2. **E2E Test Suites**:
   - Command: `npm run test:e2e`
   - Result: **22 passed, 22 total suites; 34 passed, 34 total tests; 0 failures**.
   - Coverage: Tier 1 (Features), Tier 2 (Boundaries), Tier 3 (Cross-feature), Tier 4 (Real-world lifecycles).
3. **TypeScript Build**:
   - Command: `npm run build`
   - Result: **Clean compilation, exit code 0**.

---

## 5. Conclusion & Final Verdict

All defects uncovered during Milestone 5 adversarial evaluations have been resolved, verified empirically, and regression-tested across all test layers.

**Final Verdict**: **APPROVE**
