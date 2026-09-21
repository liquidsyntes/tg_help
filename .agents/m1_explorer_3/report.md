# Milestone 1: Configuration, Docker Infrastructure & Health Architecture Report

**Author**: `m1_explorer_3` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Authoritative References**: `AGENTS.md`, `tasks.md`, `PROJECT.md`, `spec_miner_2/report.md`, `explorer_1/report.md`

---

## 1. Executive Summary

This investigation designs the core infrastructure, environment validation, container orchestration, observability probes, and background worker architecture for **Milestone 1 (Foundation, Database & Infra)** of the Telegram Content Publisher Bot MVP.

Key outcomes of this design:
1. **Environment Validation (`src/infrastructure/config/`)**: A fail-fast, strongly-typed configuration module using `class-validator` and `class-transformer`. It validates all critical environment variables (`BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `DEFAULT_TIMEZONE`, `PORT`, `TELEGRAM_MODE`, etc.) at startup before any subsystem connects, strictly redacting secrets from error diagnostics.
2. **Docker Compose & Containerization (`docker-compose.yml`)**: Multi-service configuration providing isolated `postgres` (PostgreSQL 17-alpine with `pg_isready` healthcheck), `redis` (Redis 7-alpine with `redis-cli ping` healthcheck), `app` (NestJS Telegram bot & HTTP server), and `worker` (NestJS BullMQ publisher worker). Includes a 3-stage alpine `Dockerfile`.
3. **Local Setup & Developer Experience (`SETUP.md` / `README.md`)**: Comprehensive instructions covering both containerized deployment (`docker compose up`) and local hybrid development leveraging the host's existing active WSL2 PostgreSQL 18 and Redis 8 instances.
4. **Health & Readiness Endpoints (`src/modules/health/`)**: High-performance, low-overhead HTTP probes: `GET /health` (lightweight liveness probe answering process survival without database stress) and `GET /ready` (readiness probe validating active connectivity and ping responses from PostgreSQL and Redis, returning 200 OK or 503 Service Unavailable).
5. **Independent Background Worker Architecture (`src/worker.ts`)**: A headless NestJS execution context (`NestFactory.createApplicationContext`) dedicated to BullMQ job processing. Fully decoupled from the bot/web process to ensure that scheduled and enqueued publications execute even if the bot process restarts or crashes.

---

## 2. Environment Validation Service (`src/infrastructure/config/`)

### 2.1 Architectural Invariants (AGENTS.md § 34, 35)
- **Fail Fast**: The application and worker processes must immediately abort startup if required variables are missing or structurally invalid.
- **Secret Redaction**: Error logs must never output credentials, connection passwords, or raw bot tokens. Only variable names and failed constraint descriptions are reported.
- **IANA Timezone Verification**: `DEFAULT_TIMEZONE` (default: `Europe/Kyiv`) must be verified as a valid IANA identifier using `Intl.DateTimeFormat`.
- **Conditional Validation**: In production webhook mode (`TELEGRAM_MODE=webhook`), `WEBHOOK_DOMAIN` is mandatory; in polling mode, it is optional.

### 2.2 Environment Schema & Validation Implementation

#### File: `src/infrastructure/config/environment.variables.ts`
```typescript
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export enum NodeEnv {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}

export enum TelegramMode {
  POLLING = 'polling',
  WEBHOOK = 'webhook',
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv, {
    message: 'NODE_ENV must be one of: development, production, test',
  })
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.DEVELOPMENT;

  @IsInt({ message: 'PORT must be an integer' })
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL is required' })
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL must be a valid PostgreSQL connection string starting with postgresql:// or postgres://',
  })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'REDIS_URL is required' })
  @Matches(/^rediss?:\/\/.+/, {
    message: 'REDIS_URL must be a valid Redis connection string starting with redis:// or rediss://',
  })
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'BOT_TOKEN is required' })
  @Matches(/^\d+:[A-Za-z0-9_-]{35,}$/, {
    message: 'BOT_TOKEN must follow the standard Telegram Bot API token format (e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)',
  })
  BOT_TOKEN!: string;

  @IsString()
  @IsNotEmpty({ message: 'DEFAULT_TIMEZONE is required' })
  DEFAULT_TIMEZONE: string = 'Europe/Kyiv';

  @IsEnum(TelegramMode, {
    message: 'TELEGRAM_MODE must be either "polling" or "webhook"',
  })
  @IsOptional()
  TELEGRAM_MODE: TelegramMode = TelegramMode.POLLING;

  @IsString()
  @IsOptional()
  WEBHOOK_DOMAIN?: string;

  @IsString()
  @IsOptional()
  WEBHOOK_PATH: string = '/telegram/webhook';

  @IsString()
  @IsOptional()
  WEBHOOK_SECRET_TOKEN?: string;

  @IsEnum(LogLevel, {
    message: 'LOG_LEVEL must be one of: error, warn, info, debug, verbose',
  })
  @IsOptional()
  LOG_LEVEL: LogLevel = LogLevel.INFO;
}
```

#### File: `src/infrastructure/config/environment.validation.ts`
```typescript
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { EnvironmentVariables, TelegramMode } from './environment.variables';

export function validateEnvironment(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors: ValidationError[] = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  const errorMessages: string[] = [];

  if (errors.length > 0) {
    for (const error of errors) {
      if (error.constraints) {
        const constraintMsgs = Object.values(error.constraints).join('; ');
        errorMessages.push(`  - [${error.property}]: ${constraintMsgs}`);
      }
    }
  }

  // Verify DEFAULT_TIMEZONE against IANA registry
  if (validatedConfig.DEFAULT_TIMEZONE) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: validatedConfig.DEFAULT_TIMEZONE });
    } catch {
      errorMessages.push(
        `  - [DEFAULT_TIMEZONE]: "${validatedConfig.DEFAULT_TIMEZONE}" is not a valid IANA timezone name (expected e.g. Europe/Kyiv, UTC)`,
      );
    }
  }

  // Conditional validation: Webhook mode requires WEBHOOK_DOMAIN
  if (validatedConfig.TELEGRAM_MODE === TelegramMode.WEBHOOK) {
    if (!validatedConfig.WEBHOOK_DOMAIN || validatedConfig.WEBHOOK_DOMAIN.trim() === '') {
      errorMessages.push(
        '  - [WEBHOOK_DOMAIN]: WEBHOOK_DOMAIN is strictly required when TELEGRAM_MODE is set to "webhook"',
      );
    }
  }

  if (errorMessages.length > 0) {
    const formatted = errorMessages.join('\n');
    throw new Error(
      `\n================================================================================\n` +
      `[FATAL CONFIGURATION ERROR] Application startup aborted due to invalid environment:\n` +
      `${formatted}\n` +
      `================================================================================\n`,
    );
  }

  return validatedConfig;
}
```

#### File: `src/infrastructure/config/environment-config.service.ts`
```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, LogLevel, NodeEnv, TelegramMode } from './environment.variables';

@Injectable()
export class EnvironmentConfigService {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  get nodeEnv(): NodeEnv {
    return this.configService.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.PRODUCTION;
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === NodeEnv.DEVELOPMENT;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.TEST;
  }

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get databaseUrl(): string {
    return this.configService.get('DATABASE_URL', { infer: true });
  }

  get redisUrl(): string {
    return this.configService.get('REDIS_URL', { infer: true });
  }

  get botToken(): string {
    return this.configService.get('BOT_TOKEN', { infer: true });
  }

  get defaultTimezone(): string {
    return this.configService.get('DEFAULT_TIMEZONE', { infer: true });
  }

  get telegramMode(): TelegramMode {
    return this.configService.get('TELEGRAM_MODE', { infer: true });
  }

  get webhookDomain(): string | undefined {
    return this.configService.get('WEBHOOK_DOMAIN', { infer: true });
  }

  get webhookPath(): string {
    return this.configService.get('WEBHOOK_PATH', { infer: true });
  }

  get webhookSecretToken(): string | undefined {
    return this.configService.get('WEBHOOK_SECRET_TOKEN', { infer: true });
  }

  get logLevel(): LogLevel {
    return this.configService.get('LOG_LEVEL', { infer: true });
  }
}
```

#### File: `src/infrastructure/config/config.module.ts`
```typescript
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { EnvironmentConfigService } from './environment-config.service';
import { validateEnvironment } from './environment.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      envFilePath: ['.env.local', '.env'],
    }),
  ],
  providers: [EnvironmentConfigService],
  exports: [EnvironmentConfigService],
})
export class AppConfigModule {}
```

---

## 3. Docker Compose & Multi-Stage Dockerfile (`docker-compose.yml`)

### 3.1 Docker Compose Specification (`docker-compose.yml`)

Per `tasks.md § 32` and `AGENTS.md § 65, 67`, Docker Compose defines 4 distinct services with health probes, volume persistence, and network isolation:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:17-alpine
    container_name: tghelp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-tghelp}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-tghelp_pass}
      POSTGRES_DB: ${POSTGRES_DB:-tghelp}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-tghelp} -d $${POSTGRES_DB:-tghelp}"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - tghelp-network

  redis:
    image: redis:7-alpine
    container_name: tghelp-redis
    restart: unless-stopped
    command: redis-server --appendonly yes
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 5s
    networks:
      - tghelp-network

  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    container_name: tghelp-app
    restart: unless-stopped
    command: ["node", "dist/main.js"]
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgresql://${POSTGRES_USER:-tghelp}:${POSTGRES_PASSWORD:-tghelp_pass}@postgres:5432/${POSTGRES_DB:-tghelp}?schema=public
      REDIS_URL: redis://redis:6379
      BOT_TOKEN: ${BOT_TOKEN}
      DEFAULT_TIMEZONE: ${DEFAULT_TIMEZONE:-Europe/Kyiv}
      TELEGRAM_MODE: ${TELEGRAM_MODE:-webhook}
      WEBHOOK_DOMAIN: ${WEBHOOK_DOMAIN:-}
      WEBHOOK_PATH: ${WEBHOOK_PATH:-/telegram/webhook}
      WEBHOOK_SECRET_TOKEN: ${WEBHOOK_SECRET_TOKEN:-}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - "${PORT:-3000}:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks:
      - tghelp-network

  worker:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    container_name: tghelp-worker
    restart: unless-stopped
    command: ["node", "dist/worker.js"]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER:-tghelp}:${POSTGRES_PASSWORD:-tghelp_pass}@postgres:5432/${POSTGRES_DB:-tghelp}?schema=public
      REDIS_URL: redis://redis:6379
      BOT_TOKEN: ${BOT_TOKEN}
      DEFAULT_TIMEZONE: ${DEFAULT_TIMEZONE:-Europe/Kyiv}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - tghelp-network

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local

networks:
  tghelp-network:
    driver: bridge
```

### 3.2 Production Dockerfile (`Dockerfile`)

Multi-stage build that keeps production images minimal, avoids devDependency bloat, and includes Prisma client generation:

```dockerfile
# ==============================================================================
# Stage 1: Dependencies Cache
# ==============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

# Install system utilities needed for alpine builds
RUN apk add --no-cache libc6-compat

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

# ==============================================================================
# Stage 2: Application Build
# ==============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Compile TypeScript to dist/
RUN npm run build

# Prune dev dependencies for production image
RUN npm prune --production

# ==============================================================================
# Stage 3: Minimal Production Runner
# ==============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install curl/wget for container healthchecks
RUN apk add --no-cache curl wget

# Create unprivileged user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

COPY package*.json ./
COPY prisma ./prisma/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Re-run prisma generate to ensure client engine binary is mapped for production runtime
RUN npx prisma generate

USER nestjs

EXPOSE 3000

# Default entrypoint is web/app, overridden in docker-compose for worker
CMD ["node", "dist/main.js"]
```

---

## 4. Local Setup Documentation (`SETUP.md`)

```markdown
# Telegram Content Publisher Bot — Setup & Local Execution Guide

## 1. System Requirements
- **Node.js**: `v22.0.0+` (v24 LTS recommended)
- **npm**: `v10+`
- **PostgreSQL**: `16+` (or Docker / WSL2)
- **Redis**: `7+` (or Docker / WSL2)
- **Git**: `2.30+`

---

## 2. Environment Configuration

1. Copy the example environment template:
   ```bash
   cp .env.example .env
   ```
2. Populate the required environment variables:
   - `BOT_TOKEN`: Obtain from Telegram `@BotFather`.
   - `DATABASE_URL`: Connection string to PostgreSQL.
   - `REDIS_URL`: Connection string to Redis.
   - `DEFAULT_TIMEZONE`: Channel default timezone (default `Europe/Kyiv`).
   - `PORT`: HTTP port for webhook/health endpoints (default `3000`).
   - `TELEGRAM_MODE`: Use `polling` for local development; `webhook` for production.

---

## 3. Execution Workflows

### Workflow A: Native / Local Development (Recommended for fast iterations)
Explorer 1 verified that PostgreSQL 18 and Redis 8 are already active in WSL2 and mapped to `127.0.0.1:5432` and `127.0.0.1:6379`.

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Generate Prisma Client & Apply Migrations**:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```

3. **Seed Initial Database Data** (templates, default channel, admin):
   ```bash
   npx prisma db seed
   ```

4. **Run Application (Terminal 1)**:
   ```bash
   npm run start:dev
   ```

5. **Run Background Publishing Worker (Terminal 2)**:
   ```bash
   npm run start:worker:dev
   ```

### Workflow B: Full Containerized Stack (Docker Compose)

1. **Build and start all services**:
   ```bash
   docker compose up --build
   ```
2. **Apply database migration inside container**:
   ```bash
   docker compose exec app npx prisma migrate deploy
   docker compose exec app npx prisma db seed
   ```

---

## 4. Verification & Diagnostics

1. **Verify Liveness Probe**:
   ```bash
   curl http://localhost:3000/health
   # Expected Output: {"status":"ok","uptime":12.34,"timestamp":"..."}
   ```

2. **Verify Readiness Probe (Postgres & Redis Check)**:
   ```bash
   curl http://localhost:3000/ready
   # Expected Output: {"status":"ok","checks":{"database":"up","redis":"up","queue":"up"},"timestamp":"..."}
   ```

3. **Execute Automated Tests**:
   ```bash
   npm test               # Run unit test suite
   npm run test:e2e       # Run E2E test suite
   ```
```

---

## 5. Health & Readiness Probes (`src/modules/health/`)

### 5.1 Architectural Invariants (AGENTS.md § 37, 38)
- `GET /health` (Liveness): Answers whether the process is alive. **Must not** perform slow database or Redis queries. Must return 200 OK instantly.
- `GET /ready` (Readiness): Answers whether the container can serve traffic. Probes PostgreSQL (`SELECT 1`) and Redis (`PING`). Returns HTTP 200 if dependencies are operational; returns HTTP 503 Service Unavailable if any required dependency fails.

### 5.2 Implementation Blueprint

#### File: `src/modules/health/dto/health-response.dto.ts`
```typescript
export interface LivenessResponse {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export type DependencyStatus = 'up' | 'down';

export interface ReadinessResponse {
  status: 'ok' | 'down';
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  errors?: Record<string, string>;
  timestamp: string;
}
```

#### File: `src/modules/health/health.service.ts`
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { LivenessResponse, ReadinessResponse } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  checkLiveness(): LivenessResponse {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  async checkReadiness(): Promise<ReadinessResponse> {
    const checks: ReadinessResponse['checks'] = {
      database: 'down',
      redis: 'down',
    };
    const errors: Record<string, string> = {};

    // 1. Database Check (Timeout capped at 2500ms)
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Database ping timeout after 2500ms')), 2500),
        ),
      ]);
      checks.database = 'up';
    } catch (err: unknown) {
      checks.database = 'down';
      errors.database = err instanceof Error ? err.message : 'Database check failed';
    }

    // 2. Redis Ping Check (Timeout capped at 2500ms)
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timeout after 2500ms')), 2500),
        ),
      ]);
      if (pong === 'PONG') {
        checks.redis = 'up';
      } else {
        checks.redis = 'down';
        errors.redis = `Unexpected ping response: ${String(pong)}`;
      }
    } catch (err: unknown) {
      checks.redis = 'down';
      errors.redis = err instanceof Error ? err.message : 'Redis check failed';
    }

    const isAllUp = checks.database === 'up' && checks.redis === 'up';

    return {
      status: isAllUp ? 'ok' : 'down',
      checks,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
```

#### File: `src/modules/health/health.controller.ts`
```typescript
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { LivenessResponse, ReadinessResponse } from './dto/health-response.dto';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  getHealth(): LivenessResponse {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const readiness = await this.healthService.checkReadiness();
    if (readiness.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    } else {
      res.status(HttpStatus.OK);
    }
    return readiness;
  }
}
```

#### File: `src/modules/health/health.module.ts`
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
```

---

## 6. Worker Implementation Architecture (`src/worker.ts`)

### 6.1 Architectural Principles (AGENTS.md § 20, 21, 22, 23, 65, 66)
1. **Physical & Logical Separation**: The worker runs as a completely independent OS process. It must NOT open an HTTP port that binds to the same port as `app`.
2. **Crash Resilience**: If `app` terminates, `worker` continues processing scheduled and queued publications uninterrupted.
3. **Idempotency Guard**: BullMQ jobs are redeliverable; the worker enforces unique idempotency keys in PostgreSQL (`publish:{postId}:{version}`).
4. **Step-by-step Partial Publishing Resume**: A logical post may require multiple Telegram API calls (e.g. `sendMediaGroup` then `sendMessage`). As each call succeeds, sent Telegram message IDs are persisted immediately to `publication_jobs.telegram_message_ids`. On job retry, previously sent messages are skipped!
5. **Rate-Limit Backoff**: Telegram 429 errors contain `retry_after`. The worker intercepts this and schedules a BullMQ delayed retry without marking the job as permanently failed.

### 6.2 Worker Bootstrap (`src/worker.ts`)

```typescript
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { StructuredLoggerService } from './infrastructure/logger/structured-logger.service';

async function bootstrapWorker(): Promise<void> {
  // Use createApplicationContext (headless: no HTTP server, no port collision)
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);

  // Enable graceful shutdown hooks (SIGINT, SIGTERM)
  app.enableShutdownHooks();

  logger.log({
    event: 'worker_bootstrap_complete',
    message: 'Publication Worker started and listening for BullMQ jobs',
    pid: process.pid,
  });
}

bootstrapWorker().catch((error) => {
  console.error('[FATAL] Failed to bootstrap Publication Worker:', error);
  process.exit(1);
});
```

### 6.3 Worker Module Structure (`src/worker.module.ts`)

```typescript
import { Module } from '@nestjs/common';
import { AppConfigModule } from './infrastructure/config/config.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { StructuredLoggerModule } from './infrastructure/logger/structured-logger.module';
import { QueueModule } from './infrastructure/queues/queue.module';
import { PublishingModule } from './modules/publishing/publishing.module';

@Module({
  imports: [
    AppConfigModule,
    StructuredLoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    PublishingModule,
  ],
})
export class WorkerModule {}
```

### 6.4 BullMQ Processor Design (`src/modules/publishing/publishing.processor.ts`)

```typescript
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PUBLICATION_QUEUE_NAME } from '../../common/constants/queue-names';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { PublishingWorkerService } from './publishing-worker.service';

export interface PublicationJobPayload {
  jobRecordId: string;
  postId: string;
  postVersion: number;
  channelId: string;
  idempotencyKey: string;
}

@Processor(PUBLICATION_QUEUE_NAME, {
  concurrency: 5,
  limiter: {
    max: 25,
    duration: 1000, // Respect Telegram global API rate limits (30 req/sec)
  },
})
@Injectable()
export class PublishingProcessor extends WorkerHost implements OnModuleDestroy {
  constructor(
    private readonly publishingWorkerService: PublishingWorkerService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<PublicationJobPayload>): Promise<void> {
    this.logger.log({
      event: 'publication_job_started',
      jobId: job.id,
      postId: job.data.postId,
      attempt: job.attemptsMade + 1,
    });

    await this.publishingWorkerService.executePublication(job.data, job);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<PublicationJobPayload>): void {
    this.logger.log({
      event: 'publication_job_completed',
      jobId: job.id,
      postId: job.data.postId,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PublicationJobPayload> | undefined, error: Error): void {
    this.logger.error({
      event: 'publication_job_failed',
      jobId: job?.id,
      postId: job?.data.postId,
      error: error.message,
      attemptsMade: job?.attemptsMade,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log({
      event: 'worker_shutting_down',
      message: 'Pausing and closing BullMQ publication worker gracefully',
    });
    await this.worker.close();
  }
}
```

### 6.5 Recommended Step-by-Step Implementation Plan for the Worker

| Step | Component | Action | Verification |
|---|---|---|---|
| **Step 1** | Constants & Types | Create `src/common/constants/queue-names.ts` (`PUBLICATION_QUEUE_NAME = 'publication'`) and `PublicationJobPayload` interface. | Type check passes. |
| **Step 2** | BullMQ & Redis Module | Configure BullMQ in `src/infrastructure/queues/queue.module.ts` using `BullModule.forRootAsync` pointing to `EnvironmentConfigService.redisUrl` with `maxRetriesPerRequest: null`. | BullMQ connects to Redis cleanly. |
| **Step 3** | Worker Entry Point | Create `src/worker.ts` with `NestFactory.createApplicationContext(WorkerModule)`. | Worker compiles and bootstraps without opening HTTP port. |
| **Step 4** | Package Scripts | Add `"start:worker"`, `"start:worker:dev"`, and `"build:worker"` to `package.json`. | `npm run start:worker:dev` launches cleanly in terminal. |
| **Step 5** | Telegram API Abstraction | Implement `ITelegramPublisher` in `src/infrastructure/telegram-api/` with methods `sendMessage`, `sendMediaGroup`, `sendPhoto`, and error categorizer `isRetryable(err)`. | Unit tests for retryable classification (429, 5xx vs 400). |
| **Step 6** | PublishingWorkerService | Implement job execution flow: Preflight -> OCC check -> Canonical render -> Message iteration -> Persist `telegram_message_ids` -> Final status transition (`PUBLISHED` or `PUBLISH_FAILED`). | Integration test with simulated Telegram publisher. |
| **Step 7** | Graceful Shutdown | Implement `OnModuleDestroy` on worker and ensure `app.enableShutdownHooks()` drains active jobs upon SIGTERM/SIGINT. | Process exit test on SIGTERM. |

---

## 7. Summary & Recommendations for Orchestrator

1. **Scaffolding Alignment**: Coordinate with `m1_explorer_1` to verify `package.json` includes `@nestjs/config`, `class-validator`, `class-transformer`, `@nestjs/bullmq`, `bullmq`, `ioredis`, and worker scripts (`start:worker`, `start:worker:dev`).
2. **Database Alignment**: Coordinate with `m1_explorer_2` to ensure `PublicationJob` model includes `idempotencyKey String @unique`, `telegramMessageIds Json @default("[]")`, and `attempts Int @default(0)`.
3. **Environment Setup**: Generate `.env.example` immediately during milestone implementation so developers and test runners have deterministic defaults.
4. **Local Services**: Since WSL2 Postgres 18 and Redis 8 are already active on Windows localhost (`127.0.0.1:5432` & `127.0.0.1:6379`), developers can begin running unit and integration tests without waiting for Docker engine setup.
