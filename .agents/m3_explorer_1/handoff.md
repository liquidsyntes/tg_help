# Handoff Report: TemplatesService and TemplateValidator Design

**Author**: `m3_explorer_1`  
**Working Directory**: `c:/TgHelp/.agents/m3_explorer_1`  
**Report Artifact**: `c:/TgHelp/.agents/m3_explorer_1/report.md`  
**Recipient**: Parent Orchestrator (`6f35b072-3fac-43df-87fc-95e48993acc2`)  
**Type**: Hard (Task complete)

---

## 1. Observation

1. **Seeded Templates in `prisma/seed.ts` (lines 74-275)**:
   - Found 6 standard templates:
     - `longread` (lines 75-113): `title` (text, max 256, req), `lead` (text, max 500, opt), `body` (rich_text, max 3500, req). Supported media: photo, video, media_group.
     - `announcement` (lines 114-166): `title` (text, max 256, req), `event_date` (text, max 100, req), `location` (text, max 200, opt), `description` (rich_text, max 3000, req), `cta_link` (url, max 500, opt). Supported media: photo, video.
     - `photo` (lines 167-187): `caption` (rich_text, max 1024, req). Supported media: photo.
     - `video` (lines 188-216): `title` (text, max 256, req), `description` (rich_text, max 768, opt). Supported media: video.
     - `news` (lines 217-253): `headline` (text, max 256, req), `facts` (rich_text, max 3000, req), `source_url` (url, max 500, opt). Supported media: photo, video.
     - `freeform` (lines 254-274): `body` (rich_text, max 4096, req). Supported media: photo, video, document, animation, media_group.

2. **Database Schema in `prisma/schema.prisma` (lines 124-140)**:
   - `PostTemplate` model contains: `id` (UUID), `key` (unique string), `name` (string), `description` (optional string), `schemaJson` (Json), `renderConfig` (Json), `supportedMediaTypes` (String[]), `version` (Int, default 1), `isActive` (Boolean, default true), `createdAt`, `updatedAt`. Relation: `posts Post[]`.

3. **Telegram Limits in `src/common/constants/telegram-limits.ts` (lines 5-29)**:
   - `MAX_MESSAGE_LENGTH`: 4096 chars.
   - `MAX_CAPTION_LENGTH`: 1024 chars.
   - `MIN_MEDIA_GROUP_SIZE`: 2, `MAX_MEDIA_GROUP_SIZE`: 10.
   - `MAX_CALLBACK_DATA_BYTES`: 64.

4. **Existing Exceptions in `src/common/exceptions/domain.exceptions.ts` (lines 102-121)**:
   - `InvalidTemplateException` already exists with status 400 and error code `INVALID_TEMPLATE`.
   - `ValidationException` already exists with status 400 and error code `VALIDATION_ERROR`.
   - `TemplateNotFoundException` is not yet defined.

5. **Existing RBAC Permissions in `src/common/enums/index.ts` (lines 42-47)**:
   - `SystemPermission.MANAGE_TEMPLATES` is already defined in `SystemPermission`.
   - `PermissionService.checkSystemPermission` in `src/modules/auth/permission.service.ts` (lines 169-195) verifies `SystemRole.SUPER_ADMIN` and enforces `PermissionDeniedException`.

6. **Post Autosave and State Machine in `src/modules/posts`**:
   - `PostsService.autosaveStep` (lines 78-124) updates `contentJson[fieldKey] = fieldValue` with OCC version increments.
   - `CreateDraftDto` in `src/modules/posts/dto/create-draft.dto.ts` requires `templateId: string`.
   - `PostWorkflowService.transition` (lines 73-116) executes state transitions (e.g. `DRAFT -> PENDING_REVIEW`), where dynamic preflight validation should hook in.

---

## 2. Logic Chain

1. **From Observations 1 & 2**:
   The templates in `prisma/seed.ts` use types `text`, `rich_text`, and `url`. The user requirements additionally specify `textarea` and `number`. To maintain strict backward compatibility with existing seeds while implementing all requested types, the field type union must support: `'text' | 'textarea' | 'rich_text' | 'number' | 'url'`. During validation, `textarea` and `rich_text` share length and multi-line semantics.

2. **From Observations 1 & 3**:
   The character limits configured in the 6 standard templates directly correspond to Telegram's limits (caption $\le$ 1024, text $\le$ 4096). The `TemplateValidator` must enforce these limits at field input time so that drafts cannot exceed Telegram platform constraints before reaching the rendering or publishing stages.

3. **From Observations 1 & 6**:
   During the Telegram wizard, input arrives via user chat messages one field at a time. The validator must expose a granular `validateField` method returning empathetic Russian error messages. Moreover, because all Telegram inputs arrive as strings, numeric fields must support string-to-number coercion (e.g., `"42"` $\rightarrow$ `42`) with graceful error reporting if non-numeric.

4. **From Observations 2 & 5**:
   `PostTemplate` records are persistent in PostgreSQL. Template management (creation, update, deactivation, deletion) must be restricted to Super Admins (`SystemPermission.MANAGE_TEMPLATES`) and generate append-only audit log records. When a template is being deleted, the service must check `prisma.post.count({ where: { templateId } })` to prevent foreign key errors and data inconsistency on existing posts.

5. **From Observations 4 & 6**:
   A dedicated `TemplateNotFoundException` is needed for when a requested template ID or key does not exist. In addition, when authors submit a draft for review (`DRAFT -> PENDING_REVIEW`), `validateContent` can ensure all required fields are filled and valid, preventing incomplete drafts from reaching editors.

---

## 3. Caveats

- **HTML Sanitization Boundary**: `TemplateValidator` verifies data types, required presence, and character lengths. Deep HTML tag balancing, tag whitelisting, and attribute sanitization are explicitly assigned to `HtmlSanitizer` in `m3_explorer_2`.
- **Media Count Validation**: `supportedMediaTypes` is checked on the template level. Granular media group size (2-10 items) and document-as-video detection are handled by `MediaService` (`m3_explorer_3`).
- **Read-Only Explorer Constraint**: As an explorer subagent, no source files were modified. All implementation steps, interfaces, and architecture designs are documented in `report.md` for the Worker.

---

## 4. Conclusion

1. **Architecture Is Ready**: The design for `TemplatesService` and `TemplateValidator` is fully specified with clear interfaces, DTOs, Russian error messages, and referential integrity protection.
2. **Standard Templates Validated**: The 6 seeded templates in `prisma/seed.ts` are verified against `tasks.md § 9, § 14` and Telegram limits (`TELEGRAM_LIMITS`).
3. **Execution Plan Formulated**: A 6-step concrete implementation roadmap is ready for the Worker to build and test the module in Milestone 3.

---

## 5. Verification Method

To verify these findings and designs:
1. Inspect the detailed report:
   ```bash
   cat c:/TgHelp/.agents/m3_explorer_1/report.md
   ```
2. Inspect the seeded templates:
   ```bash
   cat c:/TgHelp/prisma/seed.ts
   ```
3. Verify test commands currently configured:
   ```bash
   npm test
   ```
4. Once the Worker implements the templates module, run the newly added test suite:
   ```bash
   npm test tests/unit/templates.spec.ts
   ```
