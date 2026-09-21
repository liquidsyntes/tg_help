# Telegram Content Publisher Bot — Setup & Local Execution Guide

## 1. System Requirements
- **Node.js**: `v22.0.0+` (v24 LTS verified)
- **npm**: `v10+`
- **PostgreSQL**: `16+` (or Docker / WSL2)
- **Redis**: `7+` (or Docker / WSL2)

---

## 2. Environment Configuration

1. Copy the example environment template:
   ```bash
   cp .env.example .env
   ```
2. Configure your environment variables in `.env`:
   - `BOT_TOKEN`: Your Telegram Bot API token from `@BotFather`.
   - `DATABASE_URL`: PostgreSQL connection URL (e.g. `postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public`).
   - `REDIS_URL`: Redis connection URL (e.g. `redis://127.0.0.1:6379`).
   - `DEFAULT_TIMEZONE`: Default channel timezone (`Europe/Kyiv`).
   - `PORT`: HTTP server port (`3000`).
   - `TELEGRAM_MODE`: `polling` for local development, `webhook` for production.

---

## 3. Local Execution

### 3.1 Native / Local Development
If PostgreSQL and Redis are running locally or in WSL2:

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Generate Prisma Client & Synchronize Database**:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   # or for direct push:
   npx prisma db push
   ```

3. **Seed Database** (6 standard templates, default channel, super admin):
   ```bash
   npm run prisma:seed
   ```

4. **Start Application (Bot & HTTP API)**:
   ```bash
   npm run start:dev
   ```

5. **Start Background Publishing Worker**:
   ```bash
   npm run start:worker:dev
   ```

### 3.2 Docker Compose Deployment
To run all services containerized:

```bash
docker compose up --build -d
```

Apply migrations and seed inside the container:
```bash
docker compose exec app npx prisma migrate deploy
docker compose exec app npm run prisma:seed
```

---

## 4. Verification & Health Probes

1. **Liveness Probe**:
   ```bash
   curl http://localhost:3000/health
   # Returns: {"status":"ok","uptime":...,"timestamp":"..."}
   ```

2. **Readiness Probe**:
   ```bash
   curl http://localhost:3000/ready
   # Returns: {"status":"ok","checks":{"database":"up","redis":"up"},"timestamp":"..."}
   ```

3. **Run Tests**:
   ```bash
   npm test          # Run unit tests
   npm run test:e2e  # Run E2E tests
   ```
