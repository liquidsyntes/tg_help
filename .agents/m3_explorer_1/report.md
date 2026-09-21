# Technical Architecture & Specification Report: TemplatesService and TemplateValidator

**Author**: `m3_explorer_1` (Teamwork Explorer)  
**Date**: 2026-09-21  
**Target Milestone**: Milestone 3 (Templates, Canonical Rendering & Media)  
**Target Files**: `src/modules/templates/*`, `src/common/exceptions/domain.exceptions.ts`  
**Working Directory**: `c:/TgHelp/.agents/m3_explorer_1`

---

## 1. Executive Summary

Milestone 3 establishes the editorial publishing foundation of the Telegram Content Publisher Bot. In accordance with **AGENTS.md § 14** and **tasks.md § 9, § 14**, post templates are stored persistently in PostgreSQL (`post_templates` table) rather than hard-coded into Telegram handlers.

This report specifies the design and implementation contracts for:
1. **The 6 Standard Seeded Templates** (`longread`, `announcement`, `photo`, `video`, `news`, `freeform`) as defined in `prisma/seed.ts` and `tasks.md § 9`.
2. **`TemplateValidator`**: A dedicated dynamic validation engine supporting extensible field types (`text`, `textarea`, `rich_text`, `number`, `url`), rich constraints (`required`, `minLength`, `maxLength`, `min`, `max`, `integer`, `regex`), and empathetic, user-friendly Russian validation messages.
3. **`TemplatesService`**: A domain service providing active template discovery for the Telegram wizard, unified lookup by UUID or slug key, content validation helpers, and admin CRUD with referential integrity protection and audit logging.
4. **Integration Contracts & Concrete Worker Implementation Steps** ensuring smooth inter-operation with `PostsService`, `PostWorkflowService`, `TelegramRenderer` (`m3_explorer_2`), and `MediaService` (`m3_explorer_3`).

---

## 2. Review of the 6 Standard Seeded Templates

The database schema defines `PostTemplate` in `prisma/schema.prisma` as:
```prisma
model PostTemplate {
  id                  String   @id @default(uuid())
  key                 String   @unique @map("key")
  name                String   @map("name")
  description         String?  @map("description")
  schemaJson          Json     @map("schema_json")
  renderConfig        Json     @map("render_config")
  supportedMediaTypes String[] @map("supported_media_types")
  version             Int      @default(1) @map("version")
  isActive            Boolean  @default(true) @map("is_active")
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz

  posts Post[]
  @@map("post_templates")
}
```

The 6 seeded templates in `prisma/seed.ts` model the primary editorial use cases outlined in `tasks.md § 9`:

### 2.1. Long-read (`longread`)
- **Name**: `📝 Лонг-рид`
- **Description**: Развёрнутая аналитическая статья с заголовком, лидом, форматированным текстом и медиа.
- **Supported Media**: `['photo', 'video', 'media_group']`
- **Fields**:
  - `title` (`text`, required, max 256): Заголовок статьи.
  - `lead` (`text`, optional, max 500): Краткое введение (1-2 предложения).
  - `body` (`rich_text` / `textarea`, required, max 3500): Основной текст с поддержкой HTML.
- **Render Layout**:
  `<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}`
- **Limit Compliance**: Combined text fits within the 4096 character Telegram message limit (`TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH`). When media is attached and total text exceeds 1024 characters, the multi-message splitter (`m3_explorer_2`) will separate media from text.

### 2.2. Announcement (`announcement`)
- **Name**: `📢 Анонс`
- **Description**: Анонс события, мероприятия или релиза с датой, местом и ссылкой.
- **Supported Media**: `['photo', 'video']`
- **Fields**:
  - `title` (`text`, required, max 256): Название события.
  - `event_date` (`text`, required, max 100): Дата и время события (например, `25 сентября, 19:00 (Kyiv)`).
  - `location` (`text`, optional, max 200): Место проведения или ссылка на трансляцию.
  - `description` (`rich_text` / `textarea`, required, max 3000): Описание мероприятия.
  - `cta_link` (`url`, optional, max 500): Ссылка на регистрацию.
- **Render Layout**:
  `📢 <b>{{title}}</b>\n\n🗓 <b>Когда:</b> {{event_date}}\n📍 <b>Где:</b> {{location}}\n\n{{description}}\n\n{{cta}}`

### 2.3. Photo (`photo`)
- **Name**: `🖼 Фото`
- **Description**: Публикация с одним фото и подробной подписью.
- **Supported Media**: `['photo']`
- **Fields**:
  - `caption` (`rich_text` / `textarea`, required, max 1024): Подпись к фотографии.
- **Render Layout**:
  `{{caption}}\n\n{{tags}}`
- **Limit Compliance**: Exactly maps to `TELEGRAM_LIMITS.MAX_CAPTION_LENGTH` (1024 characters).

### 2.4. Video (`video`)
- **Name**: `🎬 Видео`
- **Description**: Видеоролик с заголовком и описанием.
- **Supported Media**: `['video']`
- **Fields**:
  - `title` (`text`, required, max 256): Короткий заголовок к видео.
  - `description` (`rich_text` / `textarea`, optional, max 768): Описание сути видеоролика.
- **Render Layout**:
  `🎬 <b>{{title}}</b>\n\n{{description}}\n\n{{tags}}`
- **Limit Compliance**: Maximum combined length `256 + 768 + formatting ≈ 1024`, ensuring direct publication as a single video caption without text truncation.

### 2.5. News (`news`)
- **Name**: `📰 Новость`
- **Description**: Короткая оперативная новость с ключевыми фактами и источником.
- **Supported Media**: `['photo', 'video']`
- **Fields**:
  - `headline` (`text`, required, max 256): Краткий новостной заголовок.
  - `facts` (`rich_text` / `textarea`, required, max 3000): Ключевые факты, подробности, цитаты.
  - `source_url` (`url`, optional, max 500): Ссылка на первоисточник.
- **Render Layout**:
  `⚡️ <b>{{headline}}</b>\n\n{{facts}}\n\n🔗 <a href="{{source_url}}">Источник</a>\n\n{{tags}}`

### 2.6. Freeform (`freeform`)
- **Name**: `✍️ Свободный формат`
- **Description**: Произвольный текст с поддержкой любого медиа и свободного форматирования.
- **Supported Media**: `['photo', 'video', 'document', 'animation', 'media_group']`
- **Fields**:
  - `body` (`rich_text` / `textarea`, required, max 4096): Любой текст с Telegram HTML форматированием.
- **Render Layout**:
  `{{body}}\n\n{{tags}}\n\n{{cta}}`
- **Limit Compliance**: Up to 4096 characters, mapping directly to `TELEGRAM_LIMITS.MAX_MESSAGE_LENGTH`.

---

## 3. Dynamic Field Validation Design (`TemplateValidator`)

### 3.1. Field Types & Semantic Mapping
The engine must support both the prompt-mandated types and existing seeded template types:
- `text`: Single-line or compact text (e.g. title, event date, headline).
- `textarea`: Multi-line text (e.g. body, lead, description).
- `rich_text`: Multi-line text permitting Telegram HTML formatting (treated identically to `textarea` during structural length/presence validation, with HTML formatting tags sanitized by `HtmlSanitizer`).
- `number`: Numeric values (supports integers and floating-point values; accommodates string input from Telegram bot with automatic parsing/coercion).
- `url`: Web URLs (must start with `http://` or `https://` and parse cleanly via `new URL()`).

### 3.2. Constraints Specification
Each field in `TemplateSchema.fields` can define:
1. `required` (`boolean`): If `true`, the value must be present, non-null, and non-empty. For strings, trimmed length must be $> 0$. If `false`, empty/omitted values bypass further checks.
2. `minLength` (`number`): Minimum character count for string fields.
3. `maxLength` (`number`): Maximum character count for string fields.
4. `min` (`number`): Minimum value for `number` fields.
5. `max` (`number`): Maximum value for `number` fields.
6. `integer` (`boolean`): Enforces integer constraint on `number` fields.
7. `regex` (`string`): Regular expression string (e.g. `^@[a-zA-Z0-9_]+$` for handles, or hashtag formats).
8. `regexMessage` (`string`): Optional custom Russian explanation when regex test fails.

### 3.3. Input Coercion for Telegram Bot
Because all Telegram message updates transmit user input as raw strings, `TemplateValidator` provides `coerceFieldValue(def, rawValue)`. For instance, when a user enters `"42"` for a `number` field, it parses `"42"` into the numeric value `42`. If it cannot be parsed, it reports a clean Russian validation error instead of throwing a JavaScript type exception.

### 3.4. Russian Error Messages Catalog
All user-facing validation error messages are clear, polite, and actionable:

| Code | Trigger | Russian Error Template |
|---|---|---|
| `REQUIRED` | Field missing, null, or whitespace-only | `Поле «{label}» обязательно для заполнения.` |
| `INVALID_STRING` | Value cannot be interpreted as string | `Поле «{label}» должно быть текстовой строкой.` |
| `MIN_LENGTH` | Character count < `minLength` | `Поле «{label}» слишком короткое: минимум {minLength} симв. (сейчас: {actualLength}).` |
| `MAX_LENGTH` | Character count > `maxLength` | `Поле «{label}» превышает допустимый лимит ({actualLength}/{maxLength} симв.). Пожалуйста, сократите текст.` |
| `INVALID_NUMBER` | Non-numeric value for `number` type | `Поле «{label}» должно быть числом.` |
| `NOT_INTEGER` | Floating point value when `integer: true` | `Поле «{label}» должно быть целым числом.` |
| `MIN_VALUE` | Number < `min` | `Значение поля «{label}» не может быть меньше {min} (получено: {val}).` |
| `MAX_VALUE` | Number > `max` | `Значение поля «{label}» не может быть больше {max} (получено: {val}).` |
| `INVALID_URL` | Malformed URL or non-HTTP(S) protocol | `Поле «{label}» должно содержать корректную ссылку, начинающуюся с https:// или http://.` |
| `PATTERN_MISMATCH` | Regex test fails | `{regexMessage}` or `Значение поля «{label}» не соответствует требуемому формату.` |
| `UNKNOWN_FIELD` | Unknown key in `contentJson` | `Обнаружено неизвестное поле «{key}», не предусмотренное шаблоном «{templateName}».` |

### 3.5. Dual Validation Modes
`TemplateValidator` exposes two primary evaluation methods:
1. **`validateField(fieldDef: TemplateFieldDefinition, value: unknown): ValidationResult`**:
   Validates a single field during interactive Wizard input (tasks.md § 9 Step 3) and Granular Field Editing (tasks.md § 11). Allows instant feedback to the user on every reply.
2. **`validateContent(schema: TemplateSchema, content: Record<string, unknown>, options?: { allowPartial?: boolean }): ValidationResult`**:
   Validates the entire post content.
   - During `autosaveStep`: `allowPartial: true` permits partial drafts.
   - During `SUBMIT_FOR_REVIEW` and preflight publishing: `allowPartial: false` enforces that *all* required fields exist and pass validation.

### 3.6. Template Definition Validation (`validateTemplateSchema`)
To protect against database corruption by administrative errors or bad migrations, `validateTemplateSchema(schemaJson, renderConfig)` validates:
- `fields` is a non-empty array.
- Field keys are unique, non-empty, and match slug regex `/^[a-z0-9_]{1,64}$/`.
- Types are within the allowed set (`text`, `textarea`, `rich_text`, `number`, `url`).
- Numeric limits are logical (`minLength >= 0`, `maxLength >= minLength`, `max >= min`).
- Regex patterns compile cleanly without syntax errors (`new RegExp(pattern)`).
- `renderConfig.layout` is a non-empty string.
If validation fails, it throws `InvalidTemplateException(message)`.

---

## 4. Templates Service Architecture (`TemplatesService`)

### 4.1. Responsibilities & Separation of Concerns
`TemplatesService` encapsulates all post-template business operations:
- Direct queries via `PrismaService` (or dedicated `TemplatesRepository`).
- Discovery of active templates for the Telegram bot interface.
- Lookup by ID (UUID) or key (`longread`, `news`, etc.).
- Admin CRUD with permission enforcement (`SystemPermission.MANAGE_TEMPLATES`).
- Append-only audit logging (`AuditAction.SETTINGS_CHANGED` / `TEMPLATE_CHANGED`).
- Safety checks preventing deletion of templates in active use by posts.

### 4.2. Method Contracts
```ts
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: TemplateValidator,
    private readonly auditService: AuditService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Retrieves active templates for the Telegram wizard post creation menu.
   * Sorted by createdAt ascending to maintain standard ordering.
   */
  async getActiveTemplates(): Promise<PostTemplate[]>;

  /**
   * Retrieves all templates (optionally including inactive) for administrative overview.
   */
  async findAll(includeInactive = false): Promise<PostTemplate[]>;

  /**
   * Retrieves a template by its UUID. Throws TemplateNotFoundException if missing.
   */
  async getById(id: string): Promise<PostTemplate>;

  /**
   * Retrieves a template by its unique slug key. Throws TemplateNotFoundException if missing.
   */
  async getByKey(key: string): Promise<PostTemplate>;

  /**
   * Flexible lookup by either UUID or slug key.
   */
  async findByIdOrKey(idOrKey: string): Promise<PostTemplate>;

  /**
   * Validates a single field value against a template.
   */
  async validateField(idOrKey: string, fieldKey: string, value: unknown): Promise<ValidationResult>;

  /**
   * Validates full post contentJson against a template.
   */
  async validatePostContent(
    idOrKey: string,
    contentJson: Record<string, unknown>,
    options?: { allowPartial?: boolean },
  ): Promise<ValidationResult>;

  /**
   * Creates a new template. Enforces SUPER_ADMIN / MANAGE_TEMPLATES permission and audit logging.
   */
  async createTemplate(dto: CreateTemplateDto, actorId: string): Promise<PostTemplate>;

  /**
   * Updates an existing template. Validates schema, increments version, logs audit entry.
   */
  async updateTemplate(id: string, dto: UpdateTemplateDto, actorId: string): Promise<PostTemplate>;

  /**
   * Toggles the active status of a template (safe alternative to deletion).
   */
  async setActive(id: string, isActive: boolean, actorId: string): Promise<PostTemplate>;

  /**
   * Deletes a template only if no posts are associated with it.
   */
  async deleteTemplate(id: string, actorId: string): Promise<void>;
}
```

### 4.3. Referential Integrity Protection on Deletion
When an administrator attempts to delete a template:
```ts
const postCount = await this.prisma.post.count({
  where: { templateId: id },
});
if (postCount > 0) {
  throw new ValidationException(
    `Нельзя удалить шаблон «${template.name}», так как к нему привязано публикаций: ${postCount}. Рекомендуется деактивировать шаблон.`,
  );
}
```
This protects foreign key constraints and prevents cascading corruption of historical posts.

---

## 5. TypeScript Interfaces and DTOs

### 5.1. Common Template Interfaces (`src/modules/templates/interfaces/template.interface.ts`)
```ts
export type TemplateFieldType = 'text' | 'textarea' | 'rich_text' | 'number' | 'url';

export interface TemplateFieldDefinition {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  regex?: string;
  regexMessage?: string;
  hint?: string;
  defaultValue?: unknown;
}

export interface TemplateSchema {
  fields: TemplateFieldDefinition[];
}

export interface TemplateRenderConfig {
  layout: string;
  headerTag?: string;
  tagsPrefix?: string;
  [key: string]: unknown;
}

export interface FieldValidationError {
  field: string;
  label: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: FieldValidationError[];
}
```

### 5.2. Data Transfer Objects (`src/modules/templates/dto/*.ts`)
```ts
import { TemplateSchema, TemplateRenderConfig } from '../interfaces/template.interface';

export class CreateTemplateDto {
  key: string;
  name: string;
  description?: string | null;
  schemaJson: TemplateSchema;
  renderConfig: TemplateRenderConfig;
  supportedMediaTypes: string[];
  isActive?: boolean;
}

export class UpdateTemplateDto {
  name?: string;
  description?: string | null;
  schemaJson?: TemplateSchema;
  renderConfig?: TemplateRenderConfig;
  supportedMediaTypes?: string[];
  isActive?: boolean;
}
```

### 5.3. Domain Exception (`src/common/exceptions/domain.exceptions.ts`)
Add `TemplateNotFoundException` alongside existing `InvalidTemplateException`:
```ts
export class TemplateNotFoundException extends DomainException {
  readonly statusCode = 404;
  readonly errorCode = 'TEMPLATE_NOT_FOUND';

  constructor(idOrKey: string) {
    super(`Template with ID or key "${idOrKey}" not found.`);
  }
}
```

---

## 6. Integration Architecture & Workflow Touchpoints

### 6.1. Wizard & Autosave Integration (M5)
1. **Template Selection**: User picks template from `templatesService.getActiveTemplates()`. Bot stores `templateId` in new draft (`postsService.createDraft`).
2. **Step-by-Step Prompting**: For each field in `template.schemaJson.fields`, bot displays `field.label` and `field.hint`.
3. **Interactive Validation**:
   ```ts
   const result = await templatesService.validateField(templateId, currentField.key, userText);
   if (!result.isValid) {
     await ctx.reply(`⚠️ ${result.errors[0].message}`);
     return; // re-prompt current step
   }
   // Coerce and persist immediately
   await postsService.autosaveStep(postId, post.version, authorId, currentField.key, userText);
   ```

### 6.2. Workflow Review Submission Preflight (M2 / M3)
In `post-workflow.service.ts`, when transitioning `DRAFT -> PENDING_REVIEW`:
```ts
const template = await this.templatesService.getById(post.templateId);
const validation = this.templateValidator.validateContent(
  template.schemaJson as unknown as TemplateSchema,
  post.contentJson as Record<string, unknown>,
  { allowPartial: false },
);
if (!validation.isValid) {
  const errorDetails = validation.errors.map(e => `• ${e.message}`).join('\n');
  throw new ValidationException(`Нельзя отправить черновик на согласование. Ошибки заполнения:\n${errorDetails}`);
}
```

### 6.3. Rendering Integration with `TelegramRenderer` (M3 explorer 2)
The canonical renderer receives:
`render(post: Post, template: PostTemplate, media: PostMedia[]): TelegramPayload`
Because `TemplateValidator` guarantees all required fields exist and conform to length bounds, the renderer can safely interpolate `{{field_key}}` tokens into `renderConfig.layout`.

---

## 7. Concrete Implementation Steps for the Worker

The following steps are recommended for the implementation Worker:

1. **Step 1: Exception & Types**
   - Add `TemplateNotFoundException` to `src/common/exceptions/domain.exceptions.ts` and re-export in `src/common/exceptions/index.ts`.
   - Create `src/modules/templates/interfaces/template.interface.ts` with domain interfaces.

2. **Step 2: Implement `TemplateValidator`**
   - Create `src/modules/templates/template.validator.ts`.
   - Implement `validateField(fieldDef, value)`, `validateContent(schema, content, options)`, and `validateTemplateSchema(schema, renderConfig)`.
   - Implement string-to-number coercion for Telegram bot input.
   - Return clean, user-friendly Russian messages for all failure modes.

3. **Step 3: Implement `TemplatesService`**
   - Create `src/modules/templates/templates.service.ts`.
   - Inject `PrismaService`, `TemplateValidator`, `AuditService`, `PermissionService`.
   - Implement retrieval methods (`getActiveTemplates`, `findAll`, `getById`, `getByKey`, `findByIdOrKey`).
   - Implement field & content validation delegation methods.
   - Implement administrative CRUD (`createTemplate`, `updateTemplate`, `setActive`, `deleteTemplate`) with OCC version increment, permission check, and audit logging.

4. **Step 4: Module Wiring**
   - Create `src/modules/templates/templates.module.ts`.
   - Provide and export `TemplatesService` and `TemplateValidator`.
   - Import `PrismaModule`, `AuditModule`, `AuthModule`.
   - Register `TemplatesModule` in `src/app.module.ts`.
   - Re-export `TemplatesService`, `TemplateValidator` from `src/modules/templates/index.ts`.

5. **Step 5: Comprehensive Unit Test Suite**
   - Create `tests/unit/templates.spec.ts`.
   - Test suite coverage:
     - Validation of all 6 standard templates from `prisma/seed.ts`.
     - Valid vs invalid field types (`text`, `textarea`, `rich_text`, `number`, `url`).
     - Required field enforcement and whitespace trimming.
     - Min/max length boundaries and exact boundary values.
     - Number bounds (`min`, `max`, `integer`) and string coercion (`"123"` -> `123`).
     - URL validation (accepting `https://example.com`, rejecting `ftp://`, `javascript:`, malformed URLs).
     - Regex pattern validation and custom `regexMessage`.
     - Template schema structural validation (`validateTemplateSchema`).
     - Service lookup by ID and Key (`getById`, `getByKey`, `findByIdOrKey`).
     - Referential integrity check on template deletion.
     - Super Admin permission enforcement on template modification.

6. **Step 6: Optional Preflight Hook in `PostWorkflowService`**
   - Connect `TemplatesService.validatePostContent` into `PostWorkflowService.transition` on `SUBMIT_FOR_REVIEW` to enforce that incomplete drafts cannot be sent for review.
