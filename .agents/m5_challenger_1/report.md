# Milestone 5 Adversarial Challenge Report

**Agent**: `m5_challenger_1` (teamwork_preview_challenger)  
**Roles**: critic, specialist  
**Target Milestone**: Milestone 5 — Telegram Transport & Interactive Wizard UI  
**Verdict**: **REQUEST_CHANGES**

---

## Challenge Summary

**Overall risk assessment**: **HIGH**

While the core architecture of Milestone 5 exhibits exemplary separation between transport and business domains (`AGENTS.md §3, §5`), immediate PostgreSQL autosave (`AGENTS.md §11, §12`), strict callback length budget management ($\le 58$ bytes for state transitions), and robust stale button rejection across publishing, approval, and scheduling actions, adversarial testing identified a **confirmed bug in draft deletion from the `/drafts` list**. Specifically, `draft-manager.handler.ts` line 108 hardcodes expectedVersion to `1`, which causes `postsService.softDeletePost` to throw `PostConflictException` whenever an author attempts to delete any draft that has undergone autosave (version $\ge 2$).

---

## Challenges

### [High] Challenge 1: Hardcoded Version 1 Breaks Draft Deletion for Any Autosaved Draft (AGENTS.md §13, §31, §54; tasks.md §9, §11)

- **Assumption challenged**: The worker assumed that confirmation buttons for draft deletion can safely default the expected version to `1`.
- **Attack scenario**:
  1. Author clicks "➕ Создать пост", picks a template (post created at `version = 1`).
  2. Author types a title. In strict accordance with AGENTS.md §12, `PostsService.autosaveStep` immediately updates PostgreSQL and increments `version` to `2`.
  3. Author enters `/drafts` or clicks "📝 Мои материалы".
  4. Author clicks "🗑 Удалить" for this draft (`draft:del:${d.id}`).
  5. The bot renders the confirmation prompt: *"Вы уверены, что хотите удалить этот черновик? Это действие необратимо."* with button callback: `draft:cdel:${postId}:1` (hardcoded `1` in `draft-manager.handler.ts:108`).
  6. Author clicks "🗑 Да, удалить".
  7. `DraftManagerHandler.handleConfirmDeleteDraft` parses version `1` and calls `draftManagerService.deleteDraft(user.id, postId, 1)`.
  8. `PostsService.softDeletePost` executes OCC query `WHERE id = postId AND version = 1`. Since actual DB version is `2`, 0 rows are updated and `PostConflictException` is thrown.
  9. The user receives an error alert: *"⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие."*
  10. The draft is **never deleted**. It is permanently stuck and impossible to delete from the `/drafts` menu.
- **Blast radius**: Complete inability for authors to delete any drafts from the drafts list once any autosave step has taken place. Directly violates acceptance criteria and tasks.md §9 / AGENTS.md §54.
- **Mitigation**:
  1. In `draft-manager.handler.ts:56`, encode the current post version: `draft:del:${d.id}:${d.version}`.
  2. In `draft-manager.handler.ts:99, 108`, receive and pass the version to `draft:cdel:${postId}:${version}`, or query `postsRepository.findById(postId)` to get the latest version.
  3. In `telegram-bot.service.ts:129`, parse the version if passed in `draft:del:<postId>:<version>`.

---

### [Medium] Challenge 2: Potential Callback Data Overflow in Granular Field Editing for Template Field Keys > 16 Characters (AGENTS.md §18; Telegram 64-Byte Limit)

- **Assumption challenged**: The worker assumed that inline button callback data `draft:edit:${post.id}:${fieldKey}` would always remain within Telegram's 64-byte limit.
- **Attack scenario**:
  - `draft:edit:` = 11 bytes.
  - Standard UUID `post.id` = 36 bytes.
  - Separators `:` = 2 bytes (total prefix: 48 bytes).
  - Maximum allowable length for `fieldKey`: $64 - 48 = 16$ characters.
  - If an administrator or template developer creates a template with a field key longer than 16 characters (e.g. `editorial_comments` = 18 chars, or `promotional_banner` = 18 chars), `draft:edit:${post.id}:${fieldKey}` will be 66 bytes.
  - Telegram Bot API will reject the entire keyboard with a fatal `BUTTON_DATA_INVALID` (400 Bad Request) error when rendering the edit menu.
- **Blast radius**: Breaking the granular edit menu for any post using templates with descriptive field keys $> 16$ chars. (Currently, all seeded templates use field keys $\le 11$ chars, so current seed data is safe, but dynamic templates are at risk).
- **Mitigation**:
  - Shorten the callback prefix to `d:e:${postId}:${fieldKey}` (4 + 36 + 1 = 41 bytes, allowing field keys up to 23 characters).
  - Add schema validation in `TemplateValidator.validateTemplateSchema` ensuring `field.key.length <= 16`.

---

## Stress Test Results

Executed via `tests/unit/adversarial-empirical-m5.spec.ts`:

| # | Dimension & Scenario | Expected Behavior | Actual Behavior | Verdict |
|---|---|---|---|:---:|
| 1.1 | Unregistered Telegram ID on message | Russian prompt with tasks.md §7 text & Telegram ID; `next()` NOT called | Prompt contains exact text and numeric ID in `<code>`; `next()` was NOT called | **PASS** |
| 1.2 | Unregistered Telegram ID on callback query | Answer callback with `show_alert: true` and tasks.md §7 text; `next()` NOT called | Answered callback query with alert; `next()` was NOT called | **PASS** |
| 1.3 | Deactivated user on message | Catches `UserDeactivatedException`; Russian blocked prompt with ID; `next()` NOT called | Responded with deactivation warning and Telegram ID; `next()` was NOT called | **PASS** |
| 1.4 | Deactivated user on callback query | Catches `UserDeactivatedException`; alert popup; `next()` NOT called | Answered callback query with alert; `next()` was NOT called | **PASS** |
| 1.5 | Non-user update (`ctx.from` undefined) | Graceful skip without calling `resolveUser` or crashing | Skipped cleanly; zero exceptions | **PASS** |
| 1.6 | Database timeout in `AuthService` | Exception rethrown for `TelegramExceptionFilter` | Rethrown; caught by outer error boundary | **PASS** |
| 1.7 | Safe maximum 64-bit BigInt Telegram ID | No truncation; passed as BigInt | Precision preserved; formatted as string | **PASS** |
| 1.8 | RBAC channel permission enforcement | Author cannot publish or approve | Evaluated false for `PUBLISH_POST` and `APPROVE_POST` | **PASS** |
| 2.1 | Step 2 (Template chosen) autosave | Immediately creates post in PostgreSQL (`posts` table, version 1) | `postsService.createDraft` called immediately; returned post v1 | **PASS** |
| 2.2 | Step 3 (Field 1 entered) autosave | Immediately updates PostgreSQL (`posts` table, version 2) | `postsService.autosaveStep` called with version 1; increments to 2 | **PASS** |
| 2.3 | Step 3 (Field 2 entered) autosave | Immediately updates PostgreSQL (`posts` table, version 3) | `postsService.autosaveStep` called with version 2; increments to 3 | **PASS** |
| 2.4 | Interrupted session recovery from DB | Redis cleared; resumed from first missing required field | `resumeDraft` identified missing required `body` field; restored Redis session to index 2 | **PASS** |
| 2.5 | Resume draft with all required fields | Shows `CONTROL_CARD` with preview | Returned `action: 'CONTROL_CARD'` without re-prompting fields | **PASS** |
| 2.6 | Resume soft-deleted draft | Returns `ERROR` | Returned error; refused to resume | **PASS** |
| 3.1 | CallbackCodec exhaustive permutation (19 actions $\times$ 4 UUIDs $\times$ 11 versions) | All combinations $\le 64$ bytes | Max observed length across all combinations: 58 bytes $\le 64$ bytes | **PASS** |
| 3.2 | `encodeView` read-only callback | String length $\le 64$ bytes | 43 bytes $\le 64$ bytes | **PASS** |
| 3.3 | Oversized payload to `CallbackCodec.encode` | Throws explicit Error | Threw Error with byte length | **PASS** |
| 3.4 | Malformed data to `CallbackCodec.decode` | Returns `null` | Returned `null` for NaN, negative version, missing parts | **PASS** |
| 3.5 | All generated keyboards callback length | Every inline button $\le 64$ bytes | Verified all buttons across all statuses $\le 64$ bytes | **PASS** |
| 4.1 | Stale Submit for Review | Rejects mutation; Russian alert toast; refreshes card | Answered callback query with alert; zero transition | **PASS** |
| 4.2 | Stale Publish Now | Rejects mutation; Russian alert toast; refreshes card | Answered callback query with alert; zero job enqueue | **PASS** |
| 4.3 | Stale Approve | Rejects mutation; Russian alert toast; refreshes card | Answered callback query with alert; zero transition | **PASS** |
| 4.4 | `TelegramExceptionFilter` on OCC conflict | Answers callback with `show_alert: true` and Russian message $\le 180$ chars | Answered callback with alert; text $\le 180$ chars | **PASS** |
| 5.1 | **Draft deletion of autosaved post from `/drafts`** | **Must delete draft using current post version** | **FAILS: `draft-manager.handler.ts:108` passes hardcoded version `1`, causing `PostConflictException` on any autosaved draft** | **FAIL (BUG CONFIRMED)** |

---

## Unchallenged Areas

- **Interactive Telegram UI visual styling in official clients**: Validated programmatically via grammY MockContext and unit/E2E test suites; full visual rendering across Telegram Desktop / iOS / Android clients is deferred to manual end-to-end user acceptance testing.

---

## Recommendation & Action Plan

1. **Reject Milestone 5 verification (REQUEST_CHANGES)** until Challenge 1 is resolved by `m5_worker_1`.
2. Fix `draft-manager.handler.ts`:
   - Encode version in `draft:del:${d.id}:${d.version}` or fetch post version dynamically before prompting.
   - Use dynamic version in `draft:cdel:${postId}:${version}` instead of hardcoded `1`.
3. Verify that test 5.1 in `tests/unit/adversarial-empirical-m5.spec.ts` passes with the updated handler implementation.
