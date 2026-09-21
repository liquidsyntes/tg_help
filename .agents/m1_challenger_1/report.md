# Empirical Challenger Report: Milestone 1 Assessment

**Agent**: `m1_challenger_1` (teamwork_preview_challenger)  
**Roles**: Critic, Specialist  
**Working Directory**: `c:/TgHelp/.agents/m1_challenger_1`  
**Date**: 2026-09-21  
**Verdict**: **REQUEST_CHANGES**  

---

## 1. Executive Summary

Milestone 1 establishes the core foundation, persistence, configuration, probes, and worker separation for the Telegram Content Publisher Bot MVP. 

An exhaustive empirical challenge suite was designed, implemented, and executed across all required dimensions:
1. **Environment Validation (`validateEnvironment`)**: 61 adversarial unit tests passed. BOT_TOKEN syntax, non-IANA timezones, port boundaries, missing variables, and strict zero-leakage of secrets (tokens, DB passwords, Redis credentials) were empirically proven robust.
2. **Probes (`/health` and `/ready`)**: All liveness, readiness, single/dual dependency outages, non-PONG responses, and 2500ms unreferenced timeout boundaries were empirically verified. Real HTTP probes on a live NestJS instance passed with 200 OK and 503 Service Unavailable appropriately.
3. **BigInt Serialization**: Fully verified with 64-bit signed integers (int8 min/max), negative Telegram chat IDs, nested payloads, `StructuredLoggerService`, and live Prisma queries against PostgreSQL.
4. **Authoritative Persistence**: Verified all 10 PostgreSQL tables, unique indices (`idempotency_key`, `telegram_id`), OCC `version` defaults, soft deletion `deleted_at`, and Redis primitives on live clusters.

However, **ONE CRITICAL DEFECT** was discovered during distribution build verification that invalidates production runtime execution and Docker container startup:
- **Defect**: Running `npm run build` deletes `./dist` and fails to emit compiled JavaScript artifacts due to a root `tsconfig.build.tsbuildinfo` cache collision with `deleteOutDir: true`.
- **Blast Radius**: `node dist/main.js` and `node dist/worker.main.js` fail immediately with `Error: Cannot find module 'dist/main.js'`. The production `Dockerfile` (`CMD ["node", "dist/main.js"]`) will crash on container start.

Therefore, the verdict is **REQUEST_CHANGES** pending a 1-line configuration fix by `m1_worker_1`.

---

## 2. Empirical Challenge Dimensions & Test Results

### 2.1 Challenge 1: `validateEnvironment` & Secret Leakage Prevention

**Hypothesis**: Can malformed bot tokens, invalid IANA timezones, out-of-bounds ports, or missing variables bypass validation? Do validation error messages inadvertently leak confidential credentials in stack traces or error logs?

**Empirical Methodology**:
Added `tests/unit/adversarial-stress.spec.ts` covering:
- BOT_TOKEN syntax: alphanumeric check before colon, missing colon, <35 secret chars, spaces/symbols, empty strings.
- Timezone validation: rejected `Invalid/Timezone`, `GMT+99`, `Mars/Olympus_Mons`, `Europe/FakeCity`, accepted `Europe/Kyiv`, `UTC`, `America/New_York`.
- Port boundaries: rejected `0`, `-80`, `65536`, `eight-thousand`, `3000.5`, accepted `1` and `65535`.
- Missing required variables: `DATABASE_URL`, `REDIS_URL`, `BOT_TOKEN`.
- Secret Leakage Protection: injected synthetic secrets into invalid URLs (`mysql://admin:my_super_confidential_postgres_password_98765@10.0.0.1:3306/db`, `invalid:super_secret_bot_token_do_not_leak_me`, `http://default:my_confidential_redis_auth_token_54321@10.0.0.2:6379`, `WEBHOOK_SECRET_TOKEN`), captured thrown error strings, and asserted that secrets never appear in error outputs.

**Output**:
```text
PASS tests/unit/adversarial-stress.spec.ts
  Area 1: Environment Validation & Secret Leakage Prevention
    1.1 BOT_TOKEN Syntax & Boundary Validation (7 tests) -> ALL PASS
    1.2 Timezone Validation against IANA Registry (12 tests) -> ALL PASS
    1.3 Port Range & Type Boundaries (7 tests) -> ALL PASS
    1.4 Missing Required Variables (3 tests) -> ALL PASS
    1.5 Security: Zero Secret Leakage in Validation Errors (4 tests) -> ALL PASS
    1.6 Webhook Mode Requirements (3 tests) -> ALL PASS
```
**Finding**: **PASSED**. Zero secret leakage confirmed.

---

### 2.2 Challenge 2: Health (`/health`) and Readiness (`/ready`) Probes

**Hypothesis**: Do health probes degrade or crash when PostgreSQL or Redis are unreachable? Does the 2500ms timeout prevent event-loop hangs? Does the controller strictly return HTTP 503 on dependency degradation?

**Empirical Methodology**:
- Mock-level stress in Jest:
  - Liveness `/health` verified to execute without touching database or Redis.
  - Readiness `/ready` tested against DB failure, Redis failure, both failing, unexpected ping response, and 2500ms timeout race.
- Live integration in `tests/stress/adversarial-live.ts`:
  - Tested live against running PostgreSQL (`127.0.0.1:5432`) and Redis (`127.0.0.1:6379`).
  - Tested outage simulation where DB or Redis mocks throw `Connection lost` or `ECONNREFUSED`.
  - Bootstrapped live `NestFactory.create(AppModule)` on ephemeral port `3999` and queried `/health` and `/ready` over real HTTP.

**Output**:
```text
  [PASS] All 10 authoritative tables exist in public schema (40ms)
  [PASS] Live checkLiveness() returns status "ok" (0ms)
  [PASS] Live checkReadiness() returns status "ok" with live DB & Redis (29ms)
  [PASS] Readiness probe correctly flags database outage without crashing (1ms)
  [PASS] Readiness probe correctly flags redis outage without crashing (1ms)
  [PASS] Bootstrap AppModule, query /health and /ready over HTTP, and teardown cleanly (262ms)
```
**Finding**: **PASSED**. Probes accurately discriminate healthy state (HTTP 200) from degraded state (HTTP 503) within <2500ms.

---

### 2.3 Challenge 3: BigInt Serialization & Prisma Invariants

**Hypothesis**: Does standard `JSON.stringify` crash with `TypeError: Do not know how to serialize a BigInt` when querying Prisma models or emitting logs containing `telegramId`?

**Empirical Methodology**:
- Evaluated `BigInt.prototype.toJSON` polyfill registered in `src/infrastructure/database/prisma.service.ts`.
- Tested positive 64-bit numbers (`1234567890n`), negative channel chat IDs (`-1001234567890n`), zero (`0n`), max signed 64-bit int (`9223372036854775807n`), min signed 64-bit int (`-9223372036854775808n`), nested arrays and objects.
- Tested `StructuredLoggerService` logging BigInt properties.
- Queried the live database using `prisma.user.findFirst({ where: { systemRole: 'SUPER_ADMIN' } })` and verified that `JSON.stringify(user)` serializes `telegramId` to string without error.

**Output**:
```text
  [PASS] Query Super Admin user from live DB and serialize BigInt to JSON (4ms)
  [PASS] should serialize negative 64-bit Telegram chat ID (supergroups/channels)
  [PASS] should serialize maximum signed 64-bit integer (PostgreSQL BIGINT MAX)
  [PASS] should serialize minimum signed 64-bit integer (PostgreSQL BIGINT MIN)
  [PASS] should format logs with BigInt properties in StructuredLoggerService without throwing
```
**Finding**: **PASSED**. BigInt serialization is completely protected across all application layers.

---

### 2.4 Challenge 4: Authoritative Schema & Data Invariants

**Empirical Inspection**:
Direct SQL queries against PostgreSQL `information_schema` verified:
- All 10 authoritative models present: `users`, `channels`, `channel_members`, `post_templates`, `posts`, `post_media`, `post_reviews`, `post_versions`, `publication_jobs`, `audit_logs`.
- `users.telegram_id`: `bigint`, NOT NULL, unique index.
- `posts.version`: `integer`, NOT NULL, default `1` for Optimistic Concurrency Control.
- `posts.deleted_at`: `timestamp with time zone` for safe soft deletion.
- `publication_jobs.idempotency_key`: unique index preventing duplicate publications.
- Redis primitives: PING, SET with 10s TTL, GET, and DEL verified.

**Finding**: **PASSED**.

---

## 3. Critical Defect Discovered

### Defect Description: Build Distribution Failure (`MODULE_NOT_FOUND`)

**Severity**: **CRITICAL (Blocks Production Run & Docker Deployment)**

**Observation**:
When executing `npm run build` as documented in `m1_worker_1/handoff.md`, the output folder `./dist` is deleted but no compiled `.js` files are emitted into `./dist`.
Attempting to run the application or worker via:
```bash
node dist/main.js
# or
node dist/worker.main.js
# or
npm run start:prod
# or
npm run start:worker:prod
```
fails immediately:
```text
node:internal/modules/cjs/loader:1459
  throw err;
  ^

Error: Cannot find module 'C:\TgHelp\dist\main.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1066:19)
    ...
  code: 'MODULE_NOT_FOUND',
  requireStack: []
```

### Root Cause Analysis:
1. `nest-cli.json` specifies `"compilerOptions": { "deleteOutDir": true }`. Each build execution wipes `./dist`.
2. `tsconfig.json` specifies `"incremental": true`.
3. `tsconfig.build.json` extends `tsconfig.json` without specifying `tsBuildInfoFile` or setting `"incremental": false`.
4. As a result, TypeScript emits its build cache to `C:\TgHelp\tsconfig.build.tsbuildinfo` in the project **root directory** rather than `./dist`.
5. When `nest build` runs:
   - It deletes `./dist`.
   - It runs `tsc -p tsconfig.build.json`.
   - `tsc` finds `tsconfig.build.tsbuildinfo` in the root (which was NOT deleted).
   - `tsc` sees that no source files in `src/` have changed since the timestamp in `tsconfig.build.tsbuildinfo`.
   - `tsc` skips emitting files!
   - Result: `./dist` is deleted and remains completely empty/missing.
6. Furthermore, `tsconfig.build.tsbuildinfo` is NOT listed in `.gitignore`, meaning contaminated incremental build caches can be checked into version control or copied into Docker build stages (`COPY . .`), breaking Docker container builds.

### Blast Radius:
- Production deployments (`npm run start:prod`, `npm run start:worker:prod`) cannot run.
- Docker builds (`Dockerfile` Stage 2 & 3) copy an empty `./dist` and crash on container startup.
- Downstream milestone developers running clean builds will encounter broken distribution artifacts.

### Remediation Required for `m1_worker_1`:
1. In `tsconfig.build.json`, set `"incremental": false` (or explicitly set `"tsBuildInfoFile": "./dist/tsconfig.build.tsbuildinfo"` so the build cache is colocated with `dist` and cleaned automatically):
   ```json
   {
     "extends": "./tsconfig.json",
     "compilerOptions": {
       "rootDir": "src",
       "incremental": false
     },
     "include": ["src/**/*"],
     "exclude": ["node_modules", "dist", "tests", "prisma", "**/*spec.ts"]
   }
   ```
2. In `.gitignore`, add:
   ```gitignore
   *.tsbuildinfo
   ```
3. Remove the existing root `tsconfig.build.tsbuildinfo` file:
   ```bash
   Remove-Item -Force tsconfig.build.tsbuildinfo
   ```
4. Run `npm run build` twice sequentially and confirm that `./dist/main.js` and `./dist/worker.main.js` exist after each run.
5. Verify `node dist/main.js` or `npm run start:prod` boots successfully.

---

## 4. Test Suite Summary Table

| Test Suite | File | Tests Run | Result |
|---|---|:---:|:---:|
| Baseline Config Unit Tests | `tests/unit/config.spec.ts` | 8 | PASS |
| Baseline Health Unit Tests | `tests/unit/health.spec.ts` | 4 | PASS |
| Adversarial Stress Tests | `tests/unit/adversarial-stress.spec.ts` | 49 | PASS |
| Full Jest Unit Suite | `npm test` | 61 | **PASS (61/61)** |
| Authoritative E2E Test Suite | `npm run test:e2e` | 34 | **PASS (34/34)** |
| Empirical Live Stress Suite | `tests/stress/adversarial-live.ts` | 12 | **PASS (12/12)** |
| Distribution Build Artifacts | `npm run build` -> `node dist/main.js` | 1 | **FAIL (`MODULE_NOT_FOUND`)** |

---

## 5. Final Verdict

**REQUEST_CHANGES**

Milestone 1 code quality, domain modeling, persistence, and test coverage are exceptional. Once `m1_worker_1` applies the simple build configuration fix in `tsconfig.build.json` and `.gitignore`, Milestone 1 will be 100% complete and ready for Milestone 2.
