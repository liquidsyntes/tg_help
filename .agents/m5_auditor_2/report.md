# Forensic Audit Report — Milestone 5 Remediation

**Work Product**: Milestone 5 Remediation (`src/modules/telegram/handlers/draft-manager.handler.ts`, `src/modules/telegram/services/draft-manager.service.ts`, `src/modules/telegram/handlers/post-actions.handler.ts`, `src/modules/telegram/services/telegram-bot.service.ts`)  
**Profile**: General Project  
**Integrity Mode**: Development (from `ORIGINAL_REQUEST.md`)  
**Auditor**: `m5_auditor_2` (teamwork_preview_auditor)  
**Date**: 2026-09-22  
**Verdict**: **INTEGRITY VIOLATION**

---

## 1. Executive Summary

A forensic integrity audit of the Milestone 5 remediation was conducted following the strict mandates of the audit dispatch and `ORIGINAL_REQUEST.md`.

While the remediation successfully eliminated the hardcoded `:1` version string in draft deletion confirmation (verified by `git grep ":1"`) and shortened callback prefixes to `d:e:` to prevent 64-byte Telegram limit breaches, **Check 1 (Authenticity & TypeScript Strictness) failed due to the introduction of `any` types and architectural layer violations in production code**.

Specifically, `src/modules/telegram/handlers/draft-manager.handler.ts` lines 118–119 contain two explicit `as any` type bypasses (`(this.draftManagerService as any).getDraft`), violating the explicit dispatch instruction (**"Ensure zero any types"**), `PROJECT.md` § Stack (**"TypeScript strict mode (no any, domain-typed IDs)"**), and `AGENTS.md` § 6 (**"Do not introduce: any unless there is a documented and unavoidable integration boundary"**). Additionally, `DraftManagerHandler` introduces `@Optional() private readonly postsRepository?: PostsRepository`, directly querying the repository layer from a transport handler in violation of `AGENTS.md` § 3 and § 5.

Per the forensic auditor protocol (**"If ANY check fails, your verdict is INTEGRITY VIOLATION and you MUST reject the work product"**), the binary veto is invoked and the work product is rejected for remediation.

---

## 2. Phase Results & Forensic Verification

### Check 1: Authenticity & Strict Typing Check
- **Requirement**: "Inspect git diff for the remediation files... Ensure changes genuinely implement dynamic version resolution for OCC draft deletion and callback prefix shortening. Ensure zero stubs, zero mocks/facades in production code, zero any types, zero direct Prisma queries in handlers."
- **Findings**:
  1. **Dynamic Version Resolution**: Authentically implemented. Draft list callback encodes version (`draft:del:${d.id}:${d.version}`), regex matches and extracts version in `telegram-bot.service.ts`, and `draft:cdel:${postId}:${version}` is generated.
  2. **Callback Prefix Shortening**: Authentically implemented. `d:e:${post.id}:${field.key}` replaces `draft:edit:`, reducing prefix to 41 bytes and leaving 23 bytes headroom under the 64-byte Telegram limit.
  3. **Zero Stubs / Zero Mocks**: Authentically implemented; no stubs or mock facades in production code.
  4. **Zero Any Types**: **FAIL**.
     - In `src/modules/telegram/handlers/draft-manager.handler.ts`:
       ```ts
       118: } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
       119:   post = await (this.draftManagerService as any).getDraft(postId);
       120: }
       ```
     - Uses `as any` twice in production code. There is no external integration boundary justifying `any`. `DraftManagerService` is a local domain service that already has `getDraft(postId: string): Promise<Post | null>`.
  5. **Architectural Separation**: In addition, `DraftManagerHandler` injects `@Optional() private readonly postsRepository?: PostsRepository` and performs direct repository queries (`await this.postsRepository.findById(postId)`), bypassing the application service layer in violation of `AGENTS.md` § 3 and § 5.
- **Verdict**: **FAIL**

---

### Check 2: Bug Invalidation Check
- **Requirement**: "Verify that `git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts` returns zero matches."
- **Empirical Execution**:
  ```bash
  git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
  ```
- **Result**: Command exited with code 1; 0 matches found.
- **Verdict**: **PASS**

---

### Check 3: Test Assertion Integrity
- **Requirement**: "Ensure unit and adversarial tests do not contain fake assertions or tautologies."
- **Verification**:
  - Grepped `tests/` for literal `expect(true|false|1|0)`. Result: 0 matches.
  - Inspected unit tests added to `tests/unit/draft-manager.service.spec.ts` (lines 186–288) and `tests/unit/post-controls.keyboard.spec.ts` (lines 114–120).
  - All assertions test concrete dynamic values (e.g. `expect(deleteBtn.callback_data).toBe('draft:del:draft-1:3')`, `expect(confirmBtn.callback_data).toBe('draft:cdel:draft-1:5')`, `expect(mockDraftManagerService.deleteDraft).toHaveBeenCalledWith('user-1', 'draft-1', 3)`).
- **Verdict**: **PASS**

---

### Check 4: Verification Execution (Build & Test Suites)
- **Requirement**: "Run npm run build, npm test, npm run test:e2e."
- **Results**:
  - `npm run build`: Exit code 0 (clean compilation).
  - `npm test`: 32/32 suites passed, 501/501 tests passed (exit code 0).
  - `npm run test:e2e`: 22/22 suites passed, 34/34 tests passed across 4 tiers (exit code 0).
- **Verdict**: **PASS**

---

## 3. Evidence Log

### Evidence 1: `any` Types in `draft-manager.handler.ts`
```text
git grep "\bany\b" src/

src/infrastructure/telegram-api/errors/telegram-error.classifier.ts:   * Classifies any error into a structured classification result.
src/infrastructure/telegram-api/interfaces/telegram-publisher.interface.ts:   * Classifies any error into RATE_LIMITED, RETRYABLE, or PERMANENT.
src/modules/auth/permission.service.ts:    // Editor can edit any post in the channel
src/modules/rendering/html-sanitizer.service.ts:    // Auto-close any unclosed tags remaining in stack (LIFO unwind)
src/modules/telegram/handlers/draft-manager.handler.ts:      } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
src/modules/telegram/handlers/draft-manager.handler.ts:        post = await (this.draftManagerService as any).getDraft(postId);
src/modules/telegram/services/draft-manager.service.ts:   * If any required fields are missing -> resumes wizard at the first missing field.
src/modules/templates/template.validator.ts:   * Returns coerced value and any coercion errors.
```

### Evidence 2: Git Diff of `draft-manager.handler.ts`
```diff
@@ -19,6 +20,7 @@ export class DraftManagerHandler {
   constructor(
     private readonly draftManagerService: DraftManagerService,
     private readonly previewService: TelegramPreviewService,
+    @Optional() private readonly postsRepository?: PostsRepository,
   ) {}
...
+    let version = versionStr ? parseInt(versionStr, 10) : NaN;
+    if (isNaN(version)) {
+      let post: { version: number } | null = null;
+      if (this.postsRepository) {
+        post = await this.postsRepository.findById(postId);
+      } else if (typeof (this.draftManagerService as any).getDraft === 'function') {
+        post = await (this.draftManagerService as any).getDraft(postId);
+      }
+      version = post?.version ?? 1;
+    }
```

### Evidence 3: Invalidation Check Execution
```text
$ git grep ":1" src/modules/telegram/handlers/draft-manager.handler.ts
Exit code: 1 (0 matches)
```

### Evidence 4: Compilation and Test Runs
- `npm run build`: Exit code 0.
- `npm test`: Test Suites: 32 passed, 32 total; Tests: 501 passed, 501 total.
- `npm run test:e2e`: Tests: 34 passed, 34 total; Suites: 22 passed, 22 total.

---

## 4. Required Remediation

To achieve a `CLEAN` verdict, the following 2 targeted adjustments must be applied:

1. **Remove `postsRepository` injection from `DraftManagerHandler`**:
   Remove `@Optional() private readonly postsRepository?: PostsRepository` from constructor in `src/modules/telegram/handlers/draft-manager.handler.ts`. Telegram handlers must communicate strictly through Application Services (`DraftManagerService`).
2. **Eliminate `as any` in `handlePromptDeleteDraft`**:
   Replace lines 115–122 of `src/modules/telegram/handlers/draft-manager.handler.ts` with strongly typed service call:
   ```ts
   let version = versionStr ? parseInt(versionStr, 10) : NaN;
   if (isNaN(version)) {
     const post = await this.draftManagerService.getDraft(postId);
     version = post?.version ?? 1;
   }
   ```
   This eliminates all `any` casts and enforces strict architectural layering.

---

## 5. Final Audit Verdict

**INTEGRITY VIOLATION**

Check 1 failed: production code contains `any` casts and architectural repository injection in `src/modules/telegram/handlers/draft-manager.handler.ts`. Work product rejected.
