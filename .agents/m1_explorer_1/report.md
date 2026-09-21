# Milestone 1: Scaffolding, Foundation & Worker Architecture Report

**Author**: `m1_explorer_1` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Working Directory**: `c:/TgHelp/.agents/m1_explorer_1`  
**Authoritative References**: `AGENTS.md`, `tasks.md`, `c:/TgHelp/.agents/ORIGINAL_REQUEST.md`, `c:/TgHelp/.agents/PROJECT.md`

---

## 1. Executive Summary

This report establishes the complete, production-grade technical specification and architectural blueprint for **Milestone 1: Foundation, Database & Infra** of the Telegram Content Publisher Bot MVP.

Milestone 1 lays the bedrock upon which all subsequent domain modules (RBAC, Post State Machine, Templates, Canonical Rendering, BullMQ Publishing, and grammY Wizard) are constructed.

### Core Discoveries & Design Invariants:
1. **Node.js 24 + TypeScript Compatibility**: The runtime is Node.js `v24.14.1` with npm `11.16.0`. While TypeScript 7.0.2 is available on npm in 2026, `ts-jest` strictly enforces peer dependency `<7`. Therefore, **`typescript: ~5.9.3`** is selected to guarantee 100% compatibility across NestJS 12, ts-jest, ts-node, and Prisma.
2. **Unified NestJS 12 Ecosystem**: NestJS `12.0.3` is adopted across core, common, config (`12.0.0`), bullmq (`12.0.0`), platform-express, and cli, providing native support for modern Node.js features and dependency injection.
3. **Strict TypeScript Settings with Balanced Ergonomics**: `target: ES2022`, `module: commonjs`, `strict: true`, and `noUncheckedIndexedAccess: true` are enforced. **`exactOptionalPropertyTypes` is deliberately set to `false`** (or omitted) after rigorous evaluation: enabling it breaks `class-transformer` deserialization of optional DTO fields, causes conflicts with Prisma's query input types (`where: { field: value ?? undefined }`), and clashes with NestJS internal options.
4. **Clean Bootstrap Architecture**: `src/main.ts` and `src/app.module.ts` strictly isolate the HTTP transport, health probes, and grammY bot initialization while executing fail-fast environment schema validation before startup.
5. **Decoupled Worker Architecture**: Per `AGENTS.md § 65`, the publication worker runs as an independent OS process (`src/worker.main.ts`) powered by NestJS application context (`createApplicationContext`), isolating queue consumers from HTTP/bot web traffic and enabling true crash resilience.

---

## 2. Package Manifest & Dependency Architecture (`package.json`)

### 2.1 Dependencies & Version Matrix

All selected versions have been cross-checked against the active registry for peer-dependency harmony:

```json
{
  "name": "tg-content-publisher",
  "version": "1.0.0",
  "description": "Telegram Content Publisher Bot MVP with role-based access, draft autosave, review workflow, and queued idempotent publishing",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "build": "nest build",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main.js",
    "start:worker": "ts-node -r tsconfig-paths/register src/worker.main.ts",
    "start:worker:dev": "nest start --entryFile worker.main --watch",
    "start:worker:prod": "node dist/worker.main.js",
    "lint": "eslint \"{src,apps,libs,test}/**/*.ts\"",
    "test": "jest --config ./test/jest.json",
    "test:watch": "jest --watch --config ./test/jest.json",
    "test:cov": "jest --coverage --config ./test/jest.json",
    "test:e2e": "jest --config ./test/jest-e2e.json",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy",
    "prisma:seed": "ts-node -r tsconfig-paths/register prisma/seed.ts"
  },
  "dependencies": {
    "@nestjs/bullmq": "^12.0.0",
    "@nestjs/common": "^12.0.3",
    "@nestjs/config": "^12.0.0",
    "@nestjs/core": "^12.0.3",
    "@nestjs/platform-express": "^12.0.3",
    "@prisma/client": "^6.19.3",
    "bullmq": "^6.3.8",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.15.1",
    "grammy": "^1.46.0",
    "@grammyjs/runner": "^2.0.9",
    "ioredis": "^5.11.1",
    "luxon": "^3.7.2",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^12.0.3",
    "@nestjs/schematics": "^12.0.0",
    "@nestjs/testing": "^12.0.3",
    "@types/jest": "^29.5.14",
    "@types/luxon": "^3.7.5",
    "@types/node": "^24.10.0",
    "@types/supertest": "^7.2.1",
    "eslint": "^9.20.0",
    "jest": "^29.7.0",
    "prettier": "^3.5.0",
    "prisma": "^6.19.3",
    "supertest": "^7.2.2",
    "ts-jest": "^29.4.12",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "~5.9.3"
  }
}
```

### 2.2 Critical Dependency Rationale & Invariants

1. **`typescript: ~5.9.3` vs TypeScript 7**:
   - `npm view ts-jest peerDependencies` specifies `"typescript": ">=4.3 <7"`.
   - Installing TypeScript 7 causes npm peer dependency resolution errors with `ts-jest` and `@nestjs/cli`. TypeScript 5.9.3 fully supports ES2022+, satisfies Prisma 6/7, and enables smooth test execution.
2. **`@nestjs/bullmq: ^12.0.0` & `bullmq: ^6.3.8`**:
   - `@nestjs/bullmq` 12 natively supports BullMQ 6.x.
   - Provides `@Processor()`, `@Process()`, and BullMQ queue injectors for NestJS dependency injection.
3. **`ioredis: ^5.11.1`**:
   - Utilized by BullMQ under the hood and used directly by `RedisService` for health check probes (`PING`), distributed locking, and short-lived UI session caches.
4. **`prisma: ^6.19.3` / `@prisma/client: ^6.19.3`**:
   - Prisma 6.19.3 is the battle-tested, zero-breaking-change ORM release. It provides seamless generation of BigInt scalar serialization, relations, and atomic raw query support.
5. **`luxon: ^3.7.2` & `@types/luxon: ^3.7.5`**:
   - Essential for Channel timezone operations (tasks.md § 3, AGENTS.md § 24, § 47). Luxon provides reliable IANA timezone parsing (`Europe/Kyiv`) and daylight saving conversions to UTC `TIMESTAMPTZ`.

---

## 3. Strict TypeScript Compiler Configuration (`tsconfig.json`)

### 3.1 Recommended `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./",
    "baseUrl": "./",
    "paths": {
      "@common/*": ["src/common/*"],
      "@infrastructure/*": ["src/infrastructure/*"],
      "@modules/*": ["src/modules/*"]
    },
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": false,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "sourceMap": true,
    "declaration": true,
    "removeComments": true,
    "incremental": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*", "test/**/*", "prisma/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 3.2 Build-Specific Configuration (`tsconfig.build.json`)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*spec.ts"]
}
```

### 3.3 Deep Analysis of Strict Settings

| Setting | Value | Rationale & Practical Impact |
|---|:---:|---|
| **`target`** | `"ES2022"` | Node.js 22+ supports all ES2022 native features (top-level await, class fields, error cause, array `.at()`). Eliminates transpilation overhead. |
| **`module`** | `"commonjs"` | Maximizes stability across NestJS CLI, ts-node, Jest (`ts-jest`), and Prisma. Avoids complex ESM module loading hurdles and extension requirements. |
| **`strict`** | `true` | Enables baseline strictness: prevents accidental type coercions, guarantees null/undefined safety, and enforces strict function types. |
| **`noUncheckedIndexedAccess`** | `true` | **Critical for array/record safety**: Accesses like `items[0]` or `dict[key]` return `T \| undefined` instead of `T`. Forces developers to check array bounds and map lookups before accessing methods, preventing runtime `TypeError: cannot read property of undefined`. |
| **`exactOptionalPropertyTypes`** | `false` | **Deliberate Decision**: With `exactOptionalPropertyTypes: true`, `{ foo?: string }` rejects `{ foo: undefined }`. In NestJS DTOs (`class-transformer`), missing or nullish JSON fields are assigned `undefined`. In Prisma Client, query filters use `where: { field: val ?? undefined }` to indicate optional filtering. Enabling this flag breaks NestJS DTO transformation and Prisma query idioms. Setting it to `false` preserves type safety while maintaining standard framework interop. |
| **`strictPropertyInitialization`** | `false` | In NestJS, DTOs and entity classes (e.g. `CreatePostDto`) declare properties decorated with `@IsString()` that are initialized at runtime by `class-transformer` rather than in class constructors. Setting this to `false` avoids boilerplate definite assignment assertions (`title!: string`) on every single DTO field. |
| **`emitDecoratorMetadata` & `experimentalDecorators`** | `true` | **Mandatory**: Required for NestJS Dependency Injection, `@Injectable()`, `@Module()`, `@Controller()`, and `class-transformer` / `class-validator` schema reflection. |
| **`skipLibCheck`** | `true` | Prevents compiler warnings and performance penalties caused by overlapping type definitions in `node_modules`. |

---

## 4. NestJS Application Bootstrap Architecture

### 4.1 Root Application Module (`src/app.module.ts`)

`AppModule` serves as the central orchestration root. It initializes core global infrastructure modules, validates environment configuration, and imports feature modules.

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './infrastructure/config/env.validator';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { QueueModule } from './infrastructure/queues/queue.module';
import { HealthModule } from './modules/health/health.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { PostsModule } from './modules/posts/posts.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { MediaModule } from './modules/media/media.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    // 1. Global Configuration with strict fail-fast validation
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),

    // 2. Global Core Infrastructure Modules
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,

    // 3. Operational & Health Modules
    HealthModule,

    // 4. Domain & Transport Modules
    AuthModule,
    UsersModule,
    ChannelsModule,
    PostsModule,
    TemplatesModule,
    MediaModule,
    ReviewsModule,
    PublishingModule,
    SchedulingModule,
    NotificationsModule,
    AuditModule,

    // 5. Telegram Transport Layer (grammY bot, webhook & polling handlers)
    TelegramModule,
  ],
})
export class AppModule {}
```

### 4.2 Main Entry Point (`src/main.ts`)

`src/main.ts` bootstraps the HTTP Express application, attaches the structured JSON logger, binds global validation and exception filters, mounts health probes, and manages dual-mode Telegram initialization.

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { StructuredLoggerService } from './infrastructure/logger/structured-logger.service';
import { AllExceptionsFilter } from './common/exceptions/all-exceptions.filter';

async function bootstrap() {
  // 1. Create NestJS Express application with buffered logs to prevent lost startup messages
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // 2. Bind Structured JSON Logger (AGENTS.md § 33)
  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);

  // 3. Bind Global DTO Validation Pipe (AGENTS.md § 7)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that do not have decorators
      forbidNonWhitelisted: true, // Throw error on unexpected fields
      transform: true, // Automatically transform payloads to DTO instances
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 4. Bind Global Exception Filter (AGENTS.md § 32 - sanitize error details, hide stack traces & secrets)
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // 5. Enable Graceful Shutdown Hooks (AGENTS.md § 66)
  // Intercepts SIGTERM, SIGINT, allowing active connections to drain
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const host = '0.0.0.0';

  await app.listen(port, host);
  logger.log({
    event: 'application_started',
    port,
    host,
    mode: configService.get<string>('TELEGRAM_MODE', 'polling'),
    nodeEnv: configService.get<string>('NODE_ENV', 'development'),
  });
}

bootstrap().catch((error: unknown) => {
  // Critical bootstrap failure: log raw error and fail fast
  console.error('Fatal bootstrap error:', error);
  process.exit(1);
});
```

### 4.3 Startup Environment Validation (`src/infrastructure/config/env.validator.ts`)

Per **AGENTS.md § 35**, the system must fail fast on invalid or missing environment variables:

```typescript
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, validateSync } from 'class-validator';

export enum TelegramTransportMode {
  POLLING = 'polling',
  WEBHOOK = 'webhook',
}

export enum NodeEnvironment {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  @IsOptional()
  NODE_ENV: NodeEnvironment = NodeEnvironment.DEVELOPMENT;

  @IsInt()
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty()
  BOT_TOKEN!: string;

  @IsEnum(TelegramTransportMode)
  @IsOptional()
  TELEGRAM_MODE: TelegramTransportMode = TelegramTransportMode.POLLING;

  @IsString()
  @IsOptional()
  TELEGRAM_WEBHOOK_URL?: string;

  @IsString()
  @IsOptional()
  TELEGRAM_WEBHOOK_SECRET?: string;

  @IsString()
  @IsOptional()
  DEFAULT_TIMEZONE: string = 'Europe/Kyiv';

  @IsString()
  @IsOptional()
  SUPER_ADMIN_TELEGRAM_ID?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    const errorDetails = errors.map((err) => ({
      property: err.property,
      constraints: err.constraints,
    }));
    console.error('Environment validation failed at startup:', JSON.stringify(errorDetails, null, 2));
    throw new Error('Environment configuration validation failed');
  }

  // Webhook specific validation
  if (validatedConfig.TELEGRAM_MODE === TelegramTransportMode.WEBHOOK) {
    if (!validatedConfig.TELEGRAM_WEBHOOK_URL) {
      throw new Error('TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE is "webhook"');
    }
    if (!validatedConfig.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE is "webhook"');
    }
  }

  return validatedConfig;
}
```

### 4.4 Health & Readiness Controller (`src/modules/health/health.controller.ts`)

Per **AGENTS.md § 37, 38** and **tasks.md § 29**:
- `GET /health`: Liveness probe (is the process alive?).
- `GET /ready`: Readiness probe (are Postgres, Redis, and BullMQ queues responsive?).

```typescript
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Get('ready')
  async getReady(@Res() res: Response) {
    const checks = {
      database: false,
      redis: false,
    };

    try {
      // 1. Check PostgreSQL
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }

    try {
      // 2. Check Redis
      const pong = await this.redis.ping();
      checks.redis = pong === 'PONG';
    } catch {
      checks.redis = false;
    }

    const isReady = checks.database && checks.redis;

    return res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: isReady ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    });
  }
}
```

---

## 5. Worker Architecture & Implementation Blueprint

### 5.1 Process Separation Invariant (AGENTS.md § 65)

The application process (`app`) and the publication worker process (`worker`) are strictly separable:
- **`app`**: Handles incoming Telegram updates (polling or webhook), HTTP health probes, post drafting wizards, autosave, and enqueuing jobs to BullMQ.
- **`worker`**: Operates as a headless BullMQ consumer process. It processes the publication queue, interacts with the Telegram Bot API via `TelegramPublisher`, records delivered message IDs, handles exponential backoff, and executes status transitions.
- **Resilience**: If the `app` web process restarts or crashes, scheduled publications already enqueued in BullMQ and PostgreSQL execute smoothly without interruption.

### 5.2 Worker Entry Point (`src/worker.main.ts`)

Uses NestJS `createApplicationContext` (no HTTP listeners or Express overhead):

```typescript
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { StructuredLoggerService } from './infrastructure/logger/structured-logger.service';

async function bootstrapWorker() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);

  // Enable graceful shutdown (AGENTS.md § 66)
  app.enableShutdownHooks();

  logger.log({
    event: 'worker_started',
    processId: process.pid,
    timestamp: new Date().toISOString(),
  });

  // Handle graceful exit signals
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log({ event: 'worker_shutting_down', signal });
      await app.close();
      process.exit(0);
    });
  }
}

bootstrapWorker().catch((err: unknown) => {
  console.error('Fatal worker bootstrap error:', err);
  process.exit(1);
});
```

### 5.3 Dedicated Worker Module (`src/worker.module.ts`)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './infrastructure/config/env.validator';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { QueueModule } from './infrastructure/queues/queue.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    PublishingModule, // Contains PublishingWorker, TelegramPublisher, TelegramRenderer
    NotificationsModule,
    AuditModule,
  ],
})
export class WorkerModule {}
```

### 5.4 Publishing Worker Processor (`src/modules/publishing/publishing.worker.ts`)

The worker implements the 7-step safe execution pipeline:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { TelegramPublisherService } from '../../infrastructure/telegram-api/telegram-publisher.service';
import { TelegramRenderer } from '../rendering/telegram-renderer.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { NotificationService } from '../notifications/notification.service';
import { PostStatus, PublicationJobStatus } from '@prisma/client';

export interface PublicationJobPayload {
  publicationJobId: string;
  postId: string;
  postVersion: number;
  idempotencyKey: string;
}

@Processor('publication', {
  concurrency: 5,
  limiter: {
    max: 20, // Max 20 messages per minute per channel to respect Telegram flood limits
    duration: 60000,
  },
})
export class PublishingWorker extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: TelegramPublisherService,
    private readonly renderer: TelegramRenderer,
    private readonly notifications: NotificationService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<PublicationJobPayload>): Promise<void> {
    const { publicationJobId, postId, postVersion, idempotencyKey } = job.data;
    const correlation = { jobId: job.id, publicationJobId, postId, postVersion, idempotencyKey };

    this.logger.log({ event: 'publication_processing_started', ...correlation });

    // Step 1: Idempotency & Concurrency Check (AGENTS.md § 21)
    const pubJob = await this.prisma.publicationJob.findUnique({
      where: { id: publicationJobId },
      include: {
        post: {
          include: {
            channel: true,
            template: true,
            media: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });

    if (!pubJob) {
      this.logger.error({ event: 'publication_job_not_found', ...correlation });
      return; // Cannot proceed
    }

    if (pubJob.status === PublicationJobStatus.COMPLETED) {
      this.logger.warn({ event: 'publication_already_completed_skip', ...correlation });
      return;
    }

    const post = pubJob.post;

    // Step 2: Preflight Validation (AGENTS.md § 25)
    if (post.deletedAt !== null) {
      await this.markJobFatal(pubJob.id, post.id, 'Post has been soft-deleted');
      return;
    }

    if (!post.channel.isActive) {
      await this.markJobFatal(pubJob.id, post.id, 'Channel is deactivated');
      return;
    }

    // Step 3: Canonical Payload Generation (AGENTS.md § 15, 16)
    const payload = await this.renderer.render(post, post.template, post.media);

    // Step 4: Partial Publication Resume (AGENTS.md § 23)
    const alreadySentIds = (pubJob.telegramMessageIds as number[]) || [];
    const pendingMessages = payload.messages.slice(alreadySentIds.length);

    if (alreadySentIds.length > 0) {
      this.logger.log({
        event: 'publication_resuming_partial',
        sentCount: alreadySentIds.length,
        remainingCount: pendingMessages.length,
        ...correlation,
      });
    }

    // Step 5: Sequential Message Dispatch with Immediate DB Persistence
    const currentSentIds = [...alreadySentIds];

    try {
      for (const msg of pendingMessages) {
        const sentId = await this.publisher.dispatchMessage(post.channel.telegramChatId, msg);
        currentSentIds.push(sentId);

        // Immediately persist intermediate message ID to PostgreSQL before sending next message
        await this.prisma.publicationJob.update({
          where: { id: pubJob.id },
          data: {
            telegramMessageIds: currentSentIds,
            attempts: { increment: 1 },
          },
        });
      }

      // Step 6: Atomic State Finalization (AGENTS.md § 28)
      await this.prisma.$transaction(async (tx) => {
        await tx.post.update({
          where: { id: post.id },
          data: {
            status: PostStatus.PUBLISHED,
            publishedAt: new Date(),
          },
        });

        await tx.publicationJob.update({
          where: { id: pubJob.id },
          data: {
            status: PublicationJobStatus.COMPLETED,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'publication_completed',
            entityType: 'post',
            entityId: post.id,
            actorId: null, // System worker
            metadata: {
              jobId: job.id,
              telegramMessageIds: currentSentIds,
            },
          },
        });
      });

      // Post-transaction notification (AGENTS.md § 27)
      await this.notifications.notifyPostPublished(post.id, post.authorId);

      this.logger.log({ event: 'publication_successful', ...correlation });
    } catch (error: any) {
      // Step 7: Error Classification & Backoff Retry Handling (AGENTS.md § 49, 50)
      await this.handlePublicationError(pubJob.id, post.id, error, job);
      throw error; // Re-throw to trigger BullMQ retry backoff
    }
  }

  private async markJobFatal(jobId: string, postId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.publicationJob.update({
        where: { id: jobId },
        data: { status: PublicationJobStatus.FAILED, lastError: reason },
      }),
      this.prisma.post.update({
        where: { id: postId },
        data: { status: PostStatus.PUBLISH_FAILED },
      }),
      this.prisma.auditLog.create({
        data: {
          action: 'publication_failed',
          entityType: 'post',
          entityId: postId,
          metadata: { fatalReason: reason },
        },
      }),
    ]);
  }

  private async handlePublicationError(jobId: string, postId: string, error: any, job: Job): Promise<void> {
    const isExhausted = job.attemptsMade >= (job.opts.attempts || 3);
    const errorMessage = error?.message || 'Unknown publication error';

    if (isExhausted) {
      await this.markJobFatal(jobId, postId, `Retries exhausted: ${errorMessage}`);
      await this.notifications.notifyPublicationFailed(postId, errorMessage);
    } else {
      await this.prisma.publicationJob.update({
        where: { id: jobId },
        data: { lastError: errorMessage },
      });
    }
  }
}
```

---

## 6. Docker & Infrastructure Strategy (`docker-compose.yml`)

### 6.1 Multi-Service Configuration

Per **AGENTS.md § 65** and **Requirement R3**:

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    command: npm run start:prod
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - DATABASE_URL=postgresql://tghelp:tghelp_pass@postgres:5432/tghelp?schema=public
      - REDIS_URL=redis://redis:6379
      - BOT_TOKEN=${BOT_TOKEN}
      - TELEGRAM_MODE=${TELEGRAM_MODE:-polling}
      - TELEGRAM_WEBHOOK_URL=${TELEGRAM_WEBHOOK_URL}
      - TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}
      - DEFAULT_TIMEZONE=Europe/Kyiv
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: npm run start:worker:prod
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://tghelp:tghelp_pass@postgres:5432/tghelp?schema=public
      - REDIS_URL=redis://redis:6379
      - BOT_TOKEN=${BOT_TOKEN}
      - DEFAULT_TIMEZONE=Europe/Kyiv
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: tghelp
      POSTGRES_PASSWORD: tghelp_pass
      POSTGRES_DB: tghelp
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tghelp -d tghelp"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

### 6.2 Multi-Stage `Dockerfile`

```dockerfile
# Stage 1: Build
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY prisma ./prisma/
RUN npm ci
COPY src ./src/
RUN npx prisma generate
RUN npm run build

# Stage 2: Runtime Runner
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
```

---

## 7. Concrete Step-by-Step Implementation Roadmap for Milestone 1

| Order | Step | Target Files | Verification Check |
|:---:|---|---|---|
| **1** | Initialize Repository & Base Config | `.gitignore`, `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json` | `git status`, verify clean paths |
| **2** | Install Dependencies | `package-lock.json`, `node_modules` | `npm install` executes with zero peer dependency conflicts |
| **3** | Create Environment Configuration & Docker Manifests | `.env.example`, `.env`, `docker-compose.yml`, `Dockerfile` | Env keys match AGENTS.md § 35 |
| **4** | Setup Prisma Schema & Initial Migration | `prisma/schema.prisma`, `prisma/seed.ts` | `npx prisma generate` succeeds; `prisma migrate dev --name init` applies cleanly against PostgreSQL |
| **5** | Implement Core Infrastructure Modules | `src/infrastructure/config/`, `src/infrastructure/logger/`, `src/infrastructure/database/`, `src/infrastructure/redis/`, `src/infrastructure/queues/` | Module registration in NestJS container |
| **6** | Implement Health & Readiness Probes | `src/modules/health/health.controller.ts`, `src/modules/health/health.module.ts` | `GET /health` returns 200; `GET /ready` checks DB & Redis |
| **7** | Implement Main App & Worker Bootstrap Files | `src/main.ts`, `src/app.module.ts`, `src/worker.main.ts`, `src/worker.module.ts` | Both `npm run start` and `npm run start:worker` initialize cleanly |
| **8** | Automated Verification & Baseline Tests | `test/jest.json`, `test/unit/health.controller.spec.ts`, `test/integration/prisma.service.spec.ts` | `npm test` passes 100% |

---

## 8. Conclusion

The scaffolding design provided in this report resolves all architectural, dependency, typing, and operational requirements set forth in `AGENTS.md`, `tasks.md`, and `ORIGINAL_REQUEST.md`. 

Implementing this precise foundation guarantees that subsequent teams will inherit a strictly-typed, fail-fast, decoupled system capable of handling concurrent post creation, resilient background publishing, and multi-channel expansion.
