# Database Layer & Prisma Specification: Telegram Content Publisher Bot MVP

**Author**: `m1_explorer_2` (Teamwork Database & Infrastructure Investigator)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m1_explorer_2`  
**Authoritative Sources**: `AGENTS.md`, `tasks.md`, `PROJECT.md`, `ORIGINAL_REQUEST.md`, `spec_miner_1/report.md`, `spec_miner_2/report.md`, `explorer_1/report.md`

---

## 1. Executive Summary

This report delivers the authoritative design for the persistence and database layer of the Telegram Content Publisher Bot MVP. In accordance with **AGENTS.md § 11** and **tasks.md § 25**, PostgreSQL (managed through Prisma ORM) serves as the system's single source of truth.

Key architectural realities established in this report:
1. **10 Comprehensive Prisma Models**: Harmonizes the schema proposals from `spec_miner_1` and `spec_miner_2`, resolving all discrepancy areas (relations, enums, indexes, and constraints).
2. **Robust NestJS `PrismaService` Lifecycle**: Complete connection lifecycle management implementing `OnModuleInit` and `OnModuleDestroy`, addressing `BigInt` serialization for Telegram IDs and connection pool management.
3. **Verified Local PostgreSQL Environment**: Verified live against PostgreSQL 18.6 running at `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp` with verified port connectivity.
4. **Idempotent Seeding Specification**: Fully defined seed dataset for 6 standard post templates (`longread`, `announcement`, `photo`, `video`, `news`, `freeform`), a default channel (`Europe/Kyiv`), and the initial Super Admin user.
5. **Clear Worker Execution Blueprint**: Concrete 9-step implementation roadmap for the BullMQ publication worker process running independently from the Telegram transport bot.

---

## 2. Review & Harmonization of Prisma Models

### 2.1 Reconciliation of Spec Miner Differences

A rigorous cross-comparison of `spec_miner_1/report.md` and `spec_miner_2/report.md` revealed key differences that have been evaluated and resolved as follows:

| Feature / Model | `spec_miner_1` Proposal | `spec_miner_2` Proposal | Harmonized Decision & Architectural Rationale |
|---|---|---|---|
| **Timestamp Types** | Plain `DateTime` | `DateTime @db.Timestamptz` | **Adopt `@db.Timestamptz`**: Per `AGENTS.md § 24`, all absolute times must use timezone-aware types (`TIMESTAMPTZ`). PostgreSQL stores UTC offsets reliably. |
| **`Channel.telegramChatId`** | `String @unique` | `BigInt @unique` | **Adopt `String @unique`**: Telegram channel IDs are 64-bit signed integers (e.g. `-1001234567890`), but Telegram Bot API also allows channels to be referenced by `@username`. Storing as `String` eliminates negative BigInt serialization quirks in REST/JSON while preserving full range fidelity. |
| **`User.telegramId`** | `BigInt @unique` | `BigInt @unique` | **Adopt `BigInt @unique`**: `AGENTS.md § 6 & § 8` explicitly mandates `type TelegramUserId = bigint`. A global JSON serializer handles string representation. |
| **`PostReview` Action/Status** | `status PostStatus` | `action ReviewAction` | **Adopt `action ReviewAction`**: Enums: `APPROVE`, `REQUEST_REVISION`, `REJECT`. Disambiguates the reviewer's specific action from the post's resulting status (`NEEDS_REVISION`). |
| **`Post.metadataJson`** | Present (`metadata_json`) | Missing (content_json only) | **Include `metadataJson Json @default("{}")`**: Step 5 of wizard explicitly requires metadata (rubric, tags, CTA, links, priority, editorial notes) separate from content fields (`tasks.md § 9`). |
| **`PostVersion.changedBy`** | `String` (unlinked) | `User @relation` | **Adopt `changedById String` linked to `User`**: Enforces relational integrity on version audit trails with `onDelete: Restrict`. |
| **`PostTemplate.supportedMediaTypes`**| `Json` | `String[]` | **Adopt `String[]`**: Native PostgreSQL `text[]` maps directly to TypeScript `string[]` in Prisma without JSON casting overhead. |
| **`PublicationJob.channelId`** | Included (`channel_id`) | Omitted | **Include `channelId String` with relation**: Enables direct indexing of publication jobs by channel for monitoring and queue recovery without joining `Post`. |
| **`PublicationJobStatus`** | `PENDING, RUNNING, COMPLETED, FAILED` | Included `CANCELLED` | **Include `CANCELLED`**: Required when a scheduled publication is cancelled by an editor (`tasks.md § 6`). |
| **`PostMedia.fileSize`** | `BigInt?` | `Int?` | **Adopt `BigInt?`**: Telegram files can reach 2GB; PostgreSQL `BigInt` guarantees no 32-bit integer overflow. |

---

### 2.2 Authoritative `schema.prisma`

The production-ready schema to be placed at `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum SystemRole {
  SUPER_ADMIN
  USER
}

enum ChannelRole {
  EDITOR
  AUTHOR
  VIEWER
}

enum PostStatus {
  DRAFT
  PENDING_REVIEW
  APPROVED
  NEEDS_REVISION
  REJECTED
  SCHEDULED
  PUBLISHING
  PUBLISHED
  PUBLISH_FAILED
  CANCELLED
}

enum MediaType {
  PHOTO
  VIDEO
  DOCUMENT
  ANIMATION
}

enum ReviewAction {
  APPROVE
  REQUEST_REVISION
  REJECT
}

enum PublicationJobStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/// System user authenticated exclusively via Telegram ID
model User {
  id         String     @id @default(uuid())
  telegramId BigInt     @unique @map("telegram_id")
  username   String?    @map("username")
  firstName  String?    @map("first_name")
  lastName   String?    @map("last_name")
  systemRole SystemRole @default(USER) @map("system_role")
  isActive   Boolean    @default(true) @map("is_active")
  createdAt  DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime   @updatedAt @map("updated_at") @db.Timestamptz

  channelMembers ChannelMember[]
  authoredPosts  Post[]          @relation("PostAuthor")
  reviews        PostReview[]    @relation("PostReviewer")
  postVersions   PostVersion[]   @relation("VersionAuthor")
  auditLogs      AuditLog[]      @relation("AuditActor")

  @@map("users")
}

/// Target Telegram channel configuration
model Channel {
  id              String   @id @default(uuid())
  telegramChatId  String   @unique @map("telegram_chat_id")
  title           String   @map("title")
  username        String?  @map("username")
  timezone        String   @default("Europe/Kyiv") @map("timezone")
  publicationMode String   @default("DIRECT") @map("publication_mode")
  isActive        Boolean  @default(true) @map("is_active")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  members         ChannelMember[]
  posts           Post[]
  publicationJobs PublicationJob[]

  @@map("channels")
}

/// Channel-level role and permission assignment
model ChannelMember {
  id         String      @id @default(uuid())
  channelId  String      @map("channel_id")
  userId     String      @map("user_id")
  role       ChannelRole @default(AUTHOR) @map("role")
  canPublish Boolean     @default(false) @map("can_publish")
  canApprove Boolean     @default(false) @map("can_approve")
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime    @updatedAt @map("updated_at") @db.Timestamptz

  channel Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([channelId, userId])
  @@index([userId])
  @@index([channelId])
  @@map("channel_members")
}

/// Dynamic post template definition and rendering configuration
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

/// Editorial post entity with Optimistic Concurrency Control
model Post {
  id              String     @id @default(uuid())
  channelId       String     @map("channel_id")
  authorId        String     @map("author_id")
  templateId      String     @map("template_id")
  templateVersion Int        @default(1) @map("template_version")
  status          PostStatus @default(DRAFT) @map("status")
  version         Int        @default(1) @map("version")
  contentJson     Json       @default("{}") @map("content_json")
  metadataJson    Json       @default("{}") @map("metadata_json")
  scheduledAt     DateTime?  @map("scheduled_at") @db.Timestamptz
  publishedAt     DateTime?  @map("published_at") @db.Timestamptz
  deletedAt       DateTime?  @map("deleted_at") @db.Timestamptz
  createdAt       DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime   @updatedAt @map("updated_at") @db.Timestamptz

  channel         Channel          @relation(fields: [channelId], references: [id], onDelete: Restrict)
  author          User             @relation("PostAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  template        PostTemplate     @relation(fields: [templateId], references: [id], onDelete: Restrict)
  media           PostMedia[]
  reviews         PostReview[]
  versions        PostVersion[]
  publicationJobs PublicationJob[]

  @@index([status])
  @@index([authorId])
  @@index([channelId])
  @@index([scheduledAt])
  @@index([deletedAt])
  @@map("posts")
}

/// Attached media files referencing Telegram file identifiers
model PostMedia {
  id                   String    @id @default(uuid())
  postId               String    @map("post_id")
  telegramFileId       String    @map("telegram_file_id")
  telegramFileUniqueId String    @map("telegram_file_unique_id")
  mediaType            MediaType @map("media_type")
  fileName             String?   @map("file_name")
  mimeType             String?   @map("mime_type")
  fileSize             BigInt?   @map("file_size")
  caption              String?   @map("caption")
  sortOrder            Int       @default(0) @map("sort_order")
  createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId])
  @@index([telegramFileUniqueId])
  @@map("post_media")
}

/// Editorial review history and feedback notes
model PostReview {
  id         String       @id @default(uuid())
  postId     String       @map("post_id")
  reviewerId String       @map("reviewer_id")
  action     ReviewAction @map("action")
  comment    String?      @map("comment")
  createdAt  DateTime     @default(now()) @map("created_at") @db.Timestamptz

  post     Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  reviewer User @relation("PostReviewer", fields: [reviewerId], references: [id], onDelete: Restrict)

  @@index([postId])
  @@index([reviewerId])
  @@map("post_reviews")
}

/// Historical version snapshots for editorial rollbacks and auditing
model PostVersion {
  id           String   @id @default(uuid())
  postId       String   @map("post_id")
  version      Int      @map("version")
  contentJson  Json     @map("content_json")
  metadataJson Json?    @map("metadata_json")
  renderedText String?  @map("rendered_text")
  changedById  String   @map("changed_by")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  post      Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  changedBy User @relation("VersionAuthor", fields: [changedById], references: [id], onDelete: Restrict)

  @@unique([postId, version])
  @@index([postId])
  @@map("post_versions")
}

/// Queue-backed publication task with database-enforced idempotency
model PublicationJob {
  id                 String               @id @default(uuid())
  postId             String               @map("post_id")
  postVersion        Int                  @map("post_version")
  idempotencyKey     String               @unique @map("idempotency_key")
  channelId          String               @map("channel_id")
  status             PublicationJobStatus @default(PENDING) @map("status")
  attempts           Int                  @default(0) @map("attempts")
  maxAttempts        Int                  @default(3) @map("max_attempts")
  scheduledFor       DateTime?            @map("scheduled_for") @db.Timestamptz
  telegramMessageIds Json                 @default("[]") @map("telegram_message_ids")
  errorMessage       String?              @map("error_message")
  createdAt          DateTime             @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime             @updatedAt @map("updated_at") @db.Timestamptz

  post    Post    @relation(fields: [postId], references: [id], onDelete: Cascade)
  channel Channel @relation(fields: [channelId], references: [id], onDelete: Restrict)

  @@index([status])
  @@index([scheduledFor])
  @@index([postId])
  @@index([channelId])
  @@map("publication_jobs")
}

/// Append-only audit record for all state transitions and system modifications
model AuditLog {
  id         String   @id @default(uuid())
  action     String   @map("action")
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id")
  actorId    String?  @map("actor_id")
  payload    Json     @default("{}") @map("payload")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  actor User? @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)

  @@index([entityType, entityId])
  @@index([actorId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

---

## 3. NestJS `PrismaService` & Lifecycle Integration

### 3.1 Design Principles
Per **AGENTS.md § 4 & § 28**:
1. `PrismaService` lives in `src/infrastructure/database/prisma.service.ts`.
2. It must integrate with NestJS lifecycle interfaces: `OnModuleInit` and `OnModuleDestroy`.
3. In modern Prisma (v5/v6), explicit `$connect()` and `$disconnect()` calls are required within these hooks.
4. An application-wide `BigInt.prototype.toJSON` polyfill must be executed at bootstrap to guarantee that Prisma records containing `BigInt` (such as `User.telegramId` or `PostMedia.fileSize`) can be serialized without throwing `TypeError: Do not know how to serialize a BigInt`.
5. Database connection errors must fail fast with structured logging.

### 3.2 Implementation: `prisma.service.ts`

```typescript
// src/infrastructure/database/prisma.service.ts
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Polyfill BigInt serialization once for entire Node.js runtime
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to PostgreSQL database via Prisma...');
    try {
      await this.$connect();
      this.logger.log('PostgreSQL database connected successfully.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to connect to PostgreSQL: ${message}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from PostgreSQL database...');
    await this.$disconnect();
    this.logger.log('PostgreSQL database disconnected cleanly.');
  }
}
```

### 3.3 Implementation: Global `PrismaModule`

```typescript
// src/infrastructure/database/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

---

## 4. Migration & Database Seed Strategy

### 4.1 Connection Validation
- Verified Target Database: `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public`
- Operating System / Environment: Windows host connecting to WSL2 Ubuntu PostgreSQL 18.6 cluster on port 5432. TCP connectivity test succeeded with exit code 0.

### 4.2 Migration Commands
The following scripts should be configured in `package.json`:
- Generate Client: `npx prisma generate`
- Run Initial Migration: `npx prisma migrate dev --name init`
- Production Migration Deploy: `npx prisma migrate deploy`
- Seed Database: `npx prisma db seed`

In `package.json`:
```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  }
}
```

---

### 4.3 Database Seed Specification (`prisma/seed.ts`)

The seed script must be strictly idempotent using `upsert` queries. It registers:
1. **Initial Super Admin User**: Telegram ID provided by `INITIAL_SUPER_ADMIN_TELEGRAM_ID` (default `123456789n`).
2. **Default Production Channel**: Default Chat ID provided by `DEFAULT_CHANNEL_CHAT_ID` (default `"-1001234567890"`), Title `"Основной канал"`, Timezone `"Europe/Kyiv"`.
3. **Channel Membership**: Super Admin linked to Default Channel as `EDITOR` with `canPublish: true` and `canApprove: true`.
4. **6 Canonical Post Templates**: As defined in `tasks.md § 9 & § 14`.

#### Full Implementation of `prisma/seed.ts`:

```typescript
// prisma/seed.ts
import { PrismaClient, SystemRole, ChannelRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Seed Initial Super Admin User
  const superAdminTelegramId = BigInt(
    process.env.INITIAL_SUPER_ADMIN_TELEGRAM_ID ?? '123456789'
  );

  const superAdmin = await prisma.user.upsert({
    where: { telegramId: superAdminTelegramId },
    update: {
      systemRole: SystemRole.SUPER_ADMIN,
      isActive: true,
    },
    create: {
      telegramId: superAdminTelegramId,
      username: 'admin',
      firstName: 'Super',
      lastName: 'Admin',
      systemRole: SystemRole.SUPER_ADMIN,
      isActive: true,
    },
  });
  console.log(`✅ Super Admin created/verified (ID: ${superAdmin.id})`);

  // 2. Seed Default Channel
  const defaultChatId = process.env.DEFAULT_CHANNEL_CHAT_ID ?? '-1001234567890';
  const channel = await prisma.channel.upsert({
    where: { telegramChatId: defaultChatId },
    update: {
      title: 'Основной канал',
      timezone: 'Europe/Kyiv',
      isActive: true,
    },
    create: {
      telegramChatId: defaultChatId,
      title: 'Основной канал',
      username: 'main_channel',
      timezone: 'Europe/Kyiv',
      publicationMode: 'DIRECT',
      isActive: true,
    },
  });
  console.log(`✅ Default Channel created/verified (ID: ${channel.id})`);

  // 3. Seed Channel Membership for Super Admin
  await prisma.channelMember.upsert({
    where: {
      channelId_userId: {
        channelId: channel.id,
        userId: superAdmin.id,
      },
    },
    update: {
      role: ChannelRole.EDITOR,
      canPublish: true,
      canApprove: true,
    },
    create: {
      channelId: channel.id,
      userId: superAdmin.id,
      role: ChannelRole.EDITOR,
      canPublish: true,
      canApprove: true,
    },
  });
  console.log('✅ Super Admin channel membership verified.');

  // 4. Seed 6 Standard Post Templates (tasks.md § 9, § 14)
  const templates = [
    {
      key: 'longread',
      name: '📝 Лонг-рид',
      description: 'Развёрнутая аналитическая статья с заголовком, лидом, форматированным текстом и медиа',
      supportedMediaTypes: ['photo', 'video', 'media_group'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Заголовок публикации',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Введите броский заголовок статьи',
          },
          {
            key: 'lead',
            label: 'Лид (краткое введение)',
            type: 'text',
            required: false,
            maxLength: 500,
            hint: '1-2 предложения, раскрывающие суть статьи',
          },
          {
            key: 'body',
            label: 'Основной текст',
            type: 'rich_text',
            required: true,
            maxLength: 3500,
            hint: 'Поддерживается Telegram HTML (жирный, курсив, цитаты, код)',
          },
        ],
      },
      renderConfig: {
        layout: '<b>{{title}}</b>\n\n<i>{{lead}}</i>\n\n{{body}}\n\n{{tags}}\n\n{{cta}}',
        headerTag: 'b',
        tagsPrefix: '\n\n',
      },
    },
    {
      key: 'announcement',
      name: '📢 Анонс',
      description: 'Анонс события, мероприятия или релиза с датой, местом и ссылкой',
      supportedMediaTypes: ['photo', 'video'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Название события',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Введите название мероприятия или релиза',
          },
          {
            key: 'event_date',
            label: 'Дата и время события',
            type: 'text',
            required: true,
            maxLength: 100,
            hint: 'Например: 25 сентября, 19:00 (Kyiv)',
          },
          {
            key: 'location',
            label: 'Место проведения / Ссылка',
            type: 'text',
            required: false,
            maxLength: 200,
            hint: 'Онлайн (Zoom/YouTube) или физический адрес',
          },
          {
            key: 'description',
            label: 'Описание мероприятия',
            type: 'rich_text',
            required: true,
            maxLength: 3000,
            hint: 'Программа, спикеры, детали события',
          },
          {
            key: 'cta_link',
            label: 'Ссылка на регистрацию',
            type: 'url',
            required: false,
            maxLength: 500,
            hint: 'https://example.com/register',
          },
        ],
      },
      renderConfig: {
        layout: '📢 <b>{{title}}</b>\n\n🗓 <b>Когда:</b> {{event_date}}\n📍 <b>Где:</b> {{location}}\n\n{{description}}\n\n{{cta}}',
      },
    },
    {
      key: 'photo',
      name: '🖼 Фото',
      description: 'Публикация с одним фото и подробной подписью',
      supportedMediaTypes: ['photo'],
      schemaJson: {
        fields: [
          {
            key: 'caption',
            label: 'Подпись к фотографии',
            type: 'rich_text',
            required: true,
            maxLength: 1024,
            hint: 'Текст подписи (до 1024 символов)',
          },
        ],
      },
      renderConfig: {
        layout: '{{caption}}\n\n{{tags}}',
      },
    },
    {
      key: 'video',
      name: '🎬 Видео',
      description: 'Видеоролик с заголовком и описанием',
      supportedMediaTypes: ['video'],
      schemaJson: {
        fields: [
          {
            key: 'title',
            label: 'Заголовок видео',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Короткий заголовок к видео',
          },
          {
            key: 'description',
            label: 'Описание видео',
            type: 'rich_text',
            required: false,
            maxLength: 768,
            hint: 'Описание сути видеоролика (до 768 символов)',
          },
        ],
      },
      renderConfig: {
        layout: '🎬 <b>{{title}}</b>\n\n{{description}}\n\n{{tags}}',
      },
    },
    {
      key: 'news',
      name: '📰 Новость',
      description: 'Короткая оперативная новость с ключевыми фактами и источником',
      supportedMediaTypes: ['photo', 'video'],
      schemaJson: {
        fields: [
          {
            key: 'headline',
            label: 'Заголовок новости',
            type: 'text',
            required: true,
            maxLength: 256,
            hint: 'Краткий новостной заголовок',
          },
          {
            key: 'facts',
            label: 'Ключевые факты',
            type: 'rich_text',
            required: true,
            maxLength: 3000,
            hint: 'Что произошло, подробности, цитаты',
          },
          {
            key: 'source_url',
            label: 'Ссылка на источник',
            type: 'url',
            required: false,
            maxLength: 500,
            hint: 'https://source.com/article',
          },
        ],
      },
      renderConfig: {
        layout: '⚡️ <b>{{headline}}</b>\n\n{{facts}}\n\n🔗 <a href="{{source_url}}">Источник</a>\n\n{{tags}}',
      },
    },
    {
      key: 'freeform',
      name: '✍️ Свободный формат',
      description: 'Произвольный текст с поддержкой любого медиа и свободного форматирования',
      supportedMediaTypes: ['photo', 'video', 'document', 'animation', 'media_group'],
      schemaJson: {
        fields: [
          {
            key: 'body',
            label: 'Текст публикации',
            type: 'rich_text',
            required: true,
            maxLength: 4096,
            hint: 'Любой текст с Telegram HTML форматированием',
          },
        ],
      },
      renderConfig: {
        layout: '{{body}}\n\n{{tags}}\n\n{{cta}}',
      },
    },
  ];

  for (const tpl of templates) {
    await prisma.postTemplate.upsert({
      where: { key: tpl.key },
      update: {
        name: tpl.name,
        description: tpl.description,
        supportedMediaTypes: tpl.supportedMediaTypes,
        schemaJson: tpl.schemaJson,
        renderConfig: tpl.renderConfig,
        isActive: true,
      },
      create: {
        key: tpl.key,
        name: tpl.name,
        description: tpl.description,
        supportedMediaTypes: tpl.supportedMediaTypes,
        schemaJson: tpl.schemaJson,
        renderConfig: tpl.renderConfig,
        isActive: true,
      },
    });
    console.log(`✅ Template "${tpl.key}" seeded.`);
  }

  console.log('🎉 Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

---

## 5. Worker Implementation Recommendations

Per **AGENTS.md § 65**, the publication worker runs as an independent process isolated from the web/bot process (`app`).

### 5.1 Architecture & Process Separation
- **Entry Point**: `src/worker.ts`
- **Context Creation**: `NestFactory.createApplicationContext(WorkerModule)`
- **Module Structure**: `WorkerModule` imports `PrismaModule`, `QueueModule` (BullMQ provider), `ConfigModule`, and `TelegramApiModule`.
- **Docker Compose Command**: `command: npm run start:worker`

### 5.2 Exact 9-Step Implementation Sequence for the Worker

The Worker implementation agent should proceed using the following exact steps:

```
[Step 1: Scaffolding] Define WorkerModule & src/worker.ts bootstrap
        ↓
[Step 2: Queue Registry] Configure BullMQ publication queue constants & connection
        ↓
[Step 3: Processor Setup] Create PublicationProcessor (@Processor('publication'))
        ↓
[Step 4: Preflight & OCC] Validate post status=PUBLISHING, deleted_at=null, version match
        ↓
[Step 5: Canonical Render] TelegramRenderer formats Post + Template + Media -> TelegramPayload
        ↓
[Step 6: Partial Resume] Inspect job.telegram_message_ids; skip already published messages
        ↓
[Step 7: Telegram Bot API] Execute sendMediaGroup / sendMessage via TelegramPublisher
        ↓
[Step 8: Result Persistence] Atomic prisma.$transaction: status=PUBLISHED, job=COMPLETED, AuditLog
        ↓
[Step 9: Error Handling] Intercept 429 retry_after, backoff retry, or transition to PUBLISH_FAILED
```

#### Detailed Breakdown of Worker Steps:

1. **Step 1: Scaffolding & Bootstrap (`src/worker.ts`)**
   - Implement `src/worker.ts` using `NestFactory.createApplicationContext(WorkerModule)`.
   - Implement graceful shutdown listeners for `SIGTERM` and `SIGINT` ensuring active BullMQ jobs are not severed abruptly.
2. **Step 2: Queue Definition & Configuration**
   - Centralize queue name: `PUBLICATION_QUEUE = 'publication'` in `src/common/constants/queue-names.ts`.
   - BullMQ configuration with Redis host/port, stalled job intervals (30s), and concurrency limit (e.g. 5 concurrent publication jobs).
3. **Step 3: Worker Consumer Class (`PublicationProcessor`)**
   - Annotate with `@Processor('publication')` extending `WorkerHost` or implementing BullMQ processor.
   - Inject `PrismaService`, `ITelegramPublisher`, and `StructuredLoggerService`.
4. **Step 4: Dual Preflight Check & Optimistic Concurrency Control**
   - Query `publication_jobs` by `idempotencyKey`. If status is `COMPLETED`, exit immediately (idempotent no-op).
   - Fetch target `Post` with relations `channel`, `template`, `media`.
   - Verify post is not soft-deleted (`deletedAt === null`) and post status is `PUBLISHING`.
   - Verify target channel is active (`channel.isActive === true`).
5. **Step 5: Canonical Payload Rendering**
   - Invoke `TelegramRenderer.render(post, template, media)` to produce `TelegramPayload`.
   - Verify message count, lengths ($\le 4096$ chars per text, $\le 1024$ chars per caption).
6. **Step 6: Partial Publishing Resume Verification**
   - Read `publication_job.telegramMessageIds` (JSON array of numbers).
   - If array already contains $K$ items, skip the first $K$ messages in the payload to avoid duplicates in the Telegram channel (`AGENTS.md § 23`).
7. **Step 7: Sequential Telegram API Calls**
   - For each unsent message in payload:
     - Call `TelegramPublisher.sendMessage()` or `sendMediaGroup()`.
     - Immediately record the newly returned Telegram message ID into `publication_jobs.telegramMessageIds` in PostgreSQL.
8. **Step 8: Atomic Success Commit**
   - Execute inside `prisma.$transaction`:
     - `post.update({ where: { id: post.id }, data: { status: PostStatus.PUBLISHED, publishedAt: new Date() } })`
     - `publicationJob.update({ where: { id: job.id }, data: { status: PublicationJobStatus.COMPLETED } })`
     - `auditLog.create({ data: { action: 'published', entityType: 'POST', entityId: post.id, ... } })`
   - Trigger asynchronous notification to Author and Editors.
9. **Step 9: Error Classification & Backoff Strategy**
   - Catch Telegram API errors:
     - If HTTP 429: Parse `parameters.retry_after` (in seconds), calculate delay, call `job.moveToDelayed(Date.now() + delay * 1000)` without counting against retry budget (`AGENTS.md § 50`).
     - If HTTP 5xx or network timeout: Throw error to let BullMQ execute exponential backoff (e.g. 5s, 20s, 60s).
     - If HTTP 400 or 403 (bot kicked / lacks rights): Treat as terminal error. Set `attempts = maxAttempts`.
   - On retry exhaustion (`attempts >= maxAttempts`):
     - Transition `Post.status` to `PUBLISH_FAILED`.
     - Set `publication_jobs.status = FAILED`, recording `errorMessage`.
     - Create audit log `publication_failed`.
     - Dispatch Telegram failure alert to Editors with retry button (`🔁 Повторить публикацию`).

---

## 6. Summary of Deliverables & Action Items

| Component | Target Path | Responsibility |
|---|---|---|
| Prisma Schema | `prisma/schema.prisma` | 10 models, all enums, `@db.Timestamptz`, constraints |
| Database Service | `src/infrastructure/database/prisma.service.ts` | Connection lifecycle (`$connect`, `$disconnect`), BigInt polyfill |
| Database Module | `src/infrastructure/database/prisma.module.ts` | Global NestJS module exporting `PrismaService` |
| Seeding Script | `prisma/seed.ts` | Idempotent upsert of templates, default channel, super admin |
| Worker Process | `src/worker.ts` | Independent BullMQ publisher worker context |
| Publication Processor | `src/modules/publishing/publication.processor.ts` | Idempotent publication execution with partial resume |
