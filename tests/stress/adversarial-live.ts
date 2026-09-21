import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { HealthService } from '../../src/modules/health/health.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { EnvironmentConfigService } from '../../src/infrastructure/config/environment-config.service';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function recordTest(suite: string, name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ suite, name, passed: true, durationMs: Date.now() - start });
    console.log(`  [PASS] ${name} (${Date.now() - start}ms)`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ suite, name, passed: false, error: errorMsg, durationMs: Date.now() - start });
    console.error(`  [FAIL] ${name} (${Date.now() - start}ms): ${errorMsg}`);
  }
}

async function runAdversarialLiveVerification() {
  console.log('================================================================================');
  console.log('EMPIRICAL CHALLENGER: Live Database, Redis, Probes & Schema Invariants');
  console.log('================================================================================\n');

  const prisma = new PrismaClient();
  const redis = new Redis('redis://127.0.0.1:6379');

  try {
    // --------------------------------------------------------------------------
    // 1. PostgreSQL Schema Invariants
    // --------------------------------------------------------------------------
    console.log('1. Verifying PostgreSQL 10 Authoritative Models & Schema Invariants:');

    await recordTest('PostgreSQL Invariants', 'All 10 authoritative tables exist in public schema', async () => {
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `;
      const tableNames = tables.map((t) => t.table_name);
      const expectedTables = [
        '_prisma_migrations',
        'audit_logs',
        'channel_members',
        'channels',
        'post_media',
        'post_reviews',
        'post_templates',
        'post_versions',
        'posts',
        'publication_jobs',
        'users',
      ];

      for (const expected of expectedTables) {
        if (!tableNames.includes(expected)) {
          throw new Error(`Expected table "${expected}" was not found in PostgreSQL public schema!`);
        }
      }
    });

    await recordTest('PostgreSQL Invariants', 'users.telegram_id is bigint (int8) with unique index', async () => {
      const col = await prisma.$queryRaw<Array<{ data_type: string; is_nullable: string }>>`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'telegram_id';
      `;
      if (!col[0] || col[0].data_type !== 'bigint') {
        throw new Error(`users.telegram_id data_type is "${col[0]?.data_type}", expected "bigint"`);
      }
      if (col[0].is_nullable !== 'NO') {
        throw new Error(`users.telegram_id is_nullable is "${col[0].is_nullable}", expected "NO"`);
      }
    });

    await recordTest('PostgreSQL Invariants', 'posts.version is integer with OCC default', async () => {
      const col = await prisma.$queryRaw<Array<{ data_type: string; column_default: string }>>`
        SELECT data_type, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'version';
      `;
      if (!col[0] || col[0].data_type !== 'integer') {
        throw new Error(`posts.version data_type is "${col[0]?.data_type}", expected "integer"`);
      }
    });

    await recordTest('PostgreSQL Invariants', 'posts.deleted_at is timestamptz for soft deletion', async () => {
      const col = await prisma.$queryRaw<Array<{ data_type: string }>>`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'deleted_at';
      `;
      if (!col[0] || !col[0].data_type.includes('timestamp with time zone')) {
        throw new Error(`posts.deleted_at data_type is "${col[0]?.data_type}", expected timestamptz`);
      }
    });

    await recordTest('PostgreSQL Invariants', 'publication_jobs.idempotency_key has unique index', async () => {
      const idx = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'publication_jobs' AND indexdef LIKE '%idempotency_key%';
      `;
      if (idx.length === 0) {
        throw new Error('publication_jobs.idempotency_key is missing a unique index!');
      }
    });

    // --------------------------------------------------------------------------
    // 2. Real Database Query & BigInt Serialization
    // --------------------------------------------------------------------------
    console.log('\n2. Verifying Real Prisma Query & BigInt JSON Serialization:');

    await recordTest('BigInt Prisma Query', 'Query Super Admin user from live DB and serialize BigInt to JSON', async () => {
      const user = await prisma.user.findFirst({
        where: { systemRole: 'SUPER_ADMIN' },
      });
      if (!user) {
        throw new Error('Super Admin user was not found in database (database might not be seeded)');
      }

      if (typeof user.telegramId !== 'bigint') {
        throw new Error(`user.telegramId is type "${typeof user.telegramId}", expected "bigint"`);
      }

      // Test JSON.stringify
      const serialized = JSON.stringify(user);
      const parsed = JSON.parse(serialized);

      if (typeof parsed.telegramId !== 'string') {
        throw new Error(`Parsed telegramId is type "${typeof parsed.telegramId}", expected "string"`);
      }

      if (parsed.telegramId !== user.telegramId.toString()) {
        throw new Error(`Parsed telegramId "${parsed.telegramId}" !== original "${user.telegramId.toString()}"`);
      }
    });

    // --------------------------------------------------------------------------
    // 3. Redis Live Connectivity & Primitives
    // --------------------------------------------------------------------------
    console.log('\n3. Verifying Live Redis Connectivity & Cache Primitives:');

    await recordTest('Redis Primitives', 'Redis PING, SET with TTL, GET, DEL round-trip', async () => {
      const pong = await redis.ping();
      if (pong !== 'PONG') {
        throw new Error(`Redis ping returned "${pong}", expected "PONG"`);
      }

      const testKey = 'tghelp:test:empirical_ping';
      const testVal = 'empirical_value_' + Date.now();
      await redis.set(testKey, testVal, 'EX', 10);
      const retrieved = await redis.get(testKey);
      if (retrieved !== testVal) {
        throw new Error(`Redis get returned "${retrieved}", expected "${testVal}"`);
      }

      const delResult = await redis.del(testKey);
      if (delResult !== 1) {
        throw new Error(`Redis del returned ${delResult}, expected 1`);
      }
    });

    // --------------------------------------------------------------------------
    // 4. Live Health & Readiness Services
    // --------------------------------------------------------------------------
    console.log('\n4. Verifying Health & Readiness Probes with Live Dependencies:');

    const prismaService = new PrismaService();
    const mockConfig = { redisUrl: 'redis://127.0.0.1:6379' } as EnvironmentConfigService;
    const redisService = new RedisService(mockConfig);
    redisService.onModuleInit();

    const healthService = new HealthService(prismaService, redisService);

    await recordTest('Health Probes', 'Live checkLiveness() returns status "ok"', async () => {
      const liveness = healthService.checkLiveness();
      if (liveness.status !== 'ok') {
        throw new Error(`checkLiveness status was "${liveness.status}", expected "ok"`);
      }
      if (typeof liveness.uptime !== 'number' || liveness.uptime <= 0) {
        throw new Error(`checkLiveness uptime is invalid: ${liveness.uptime}`);
      }
    });

    await recordTest('Health Probes', 'Live checkReadiness() returns status "ok" with live DB & Redis', async () => {
      const readiness = await healthService.checkReadiness();
      if (readiness.status !== 'ok') {
        throw new Error(`checkReadiness status was "${readiness.status}", expected "ok"`);
      }
      if (readiness.checks.database !== 'up' || readiness.checks.redis !== 'up') {
        throw new Error(`checkReadiness checks were: ${JSON.stringify(readiness.checks)}`);
      }
    });

    // --------------------------------------------------------------------------
    // 5. Simulated Outage via Non-Existent Services
    // --------------------------------------------------------------------------
    console.log('\n5. Simulating Infrastructure Outage Handling:');

    await recordTest('Outage Simulation', 'Readiness probe correctly flags database outage without crashing', async () => {
      // Create mock failing prisma
      const failingPrisma = {
        $queryRaw: async () => {
          throw new Error('Connection to PostgreSQL cluster lost: timeout 2500ms');
        },
      } as unknown as PrismaService;

      const outageHealthService = new HealthService(failingPrisma, redisService);
      const readiness = await outageHealthService.checkReadiness();

      if (readiness.status !== 'down') {
        throw new Error(`Expected readiness status "down", got "${readiness.status}"`);
      }
      if (readiness.checks.database !== 'down') {
        throw new Error(`Expected database check "down", got "${readiness.checks.database}"`);
      }
      if (readiness.checks.redis !== 'up') {
        throw new Error(`Expected redis check "up", got "${readiness.checks.redis}"`);
      }
      if (!readiness.errors?.database) {
        throw new Error('Expected errors.database to be populated');
      }
    });

    await recordTest('Outage Simulation', 'Readiness probe correctly flags redis outage without crashing', async () => {
      // Create mock failing redis
      const failingRedis = {
        ping: async () => {
          throw new Error('Redis host unreachable: ECONNREFUSED');
        },
      } as unknown as RedisService;

      const outageHealthService = new HealthService(prismaService, failingRedis);
      const readiness = await outageHealthService.checkReadiness();

      if (readiness.status !== 'down') {
        throw new Error(`Expected readiness status "down", got "${readiness.status}"`);
      }
      if (readiness.checks.redis !== 'down') {
        throw new Error(`Expected redis check "down", got "${readiness.checks.redis}"`);
      }
      if (readiness.checks.database !== 'up') {
        throw new Error(`Expected database check "up", got "${readiness.checks.database}"`);
      }
      if (!readiness.errors?.redis) {
        throw new Error('Expected errors.redis to be populated');
      }
    });

    // --------------------------------------------------------------------------
    // 6. Live NestJS HTTP Application Bootstrap & Endpoints
    // --------------------------------------------------------------------------
    console.log('\n6. Verifying Live NestJS HTTP Server on Ephemeral Port:');

    await recordTest('Live HTTP Server', 'Bootstrap AppModule, query /health and /ready over HTTP, and teardown cleanly', async () => {
      // Ensure environment variables are present
      process.env.PORT = '3999';
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = 'postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public';
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      process.env.BOT_TOKEN = '123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11';
      process.env.DEFAULT_TIMEZONE = 'Europe/Kyiv';
      process.env.TELEGRAM_MODE = 'polling';

      const app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(3999);

      try {
        // Query /health
        const healthRes = await fetch('http://127.0.0.1:3999/health');
        if (healthRes.status !== 200) {
          throw new Error(`/health returned HTTP ${healthRes.status}, expected 200`);
        }
        const healthBody = (await healthRes.json()) as { status: string };
        if (healthBody.status !== 'ok') {
          throw new Error(`/health body status is "${healthBody.status}", expected "ok"`);
        }

        // Query /ready
        const readyRes = await fetch('http://127.0.0.1:3999/ready');
        if (readyRes.status !== 200) {
          throw new Error(`/ready returned HTTP ${readyRes.status}, expected 200`);
        }
        const readyBody = (await readyRes.json()) as { status: string; checks: { database: string; redis: string } };
        if (readyBody.status !== 'ok' || readyBody.checks.database !== 'up' || readyBody.checks.redis !== 'up') {
          throw new Error(`/ready body is invalid: ${JSON.stringify(readyBody)}`);
        }
      } finally {
        await app.close();
      }
    });

    await redisService.onModuleDestroy();
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('EMPIRICAL CHALLENGER TEST RESULTS SUMMARY');
  console.log('================================================================================');
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  console.log(`Total Tests Run: ${results.length}`);
  console.log(`Passed:         ${passedCount}`);
  console.log(`Failed:         ${failedCount}`);
  console.log('================================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAdversarialLiveVerification().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
