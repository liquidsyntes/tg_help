# 📢 Telegram Content Publisher Bot

Бот для **создания, согласования и публикации** контента в Telegram-каналы. Полный редакционный цикл — от черновика до публикации — прямо внутри Telegram.

## Что умеет

- ✏️ **Пошаговый wizard** — создание постов через кнопки без команд
- 💾 **Автосохранение** — каждый шаг сразу в базу, ничего не потеряется
- 📋 **6 шаблонов** — лонг-рид, анонс, фото, видео, новость, свободный формат
- 🖼 **Медиа** — фото, видео, документы, анимации, медиа-группы
- 👥 **Ревью** — автор отправляет → редактор одобряет/возвращает/отклоняет
- 📅 **Планирование** — публикация по расписанию с учётом timezone
- 🚀 **Надёжная публикация** — через очередь с retry и защитой от дублей
- 🔐 **Роли** — Admin, Editor, Author с гранулярными правами на уровне канала
- 📊 **Аудит** — все действия логируются

## Стек

Node.js 22+ · TypeScript · NestJS · grammY · PostgreSQL · Prisma · Redis · BullMQ · Docker

---

## Быстрый старт

### Что нужно

- **Node.js** 22+ (v24 LTS рекомендуется)
- **Docker** (для PostgreSQL и Redis)
- **Telegram Bot Token** — получить у [@BotFather](https://t.me/BotFather)

### 1. Установка

```bash
git clone <repo-url> && cd tg-content-publisher
npm install
```

### 2. Настройка окружения

```bash
cp .env.example .env
```

Откройте `.env` и заполните:

```env
BOT_TOKEN=ваш-токен-от-BotFather
INITIAL_SUPER_ADMIN_TELEGRAM_ID=ваш-telegram-id
DEFAULT_CHANNEL_CHAT_ID=id-вашего-канала
```

> 💡 Свой Telegram ID можно узнать у [@userinfobot](https://t.me/userinfobot).
> Chat ID канала — у [@getmyid_bot](https://t.me/getmyid_bot) (переслать сообщение из канала).

### 3. Запуск инфраструктуры

```bash
docker compose up postgres redis -d
```

### 4. Подготовка базы данных

```bash
npx prisma generate
npx prisma migrate dev
npm run prisma:seed
```

Seed создаст: суперадмина, канал по умолчанию и 6 шаблонов постов.

### 5. Запуск (два терминала)

```bash
# Терминал 1 — Бот + HTTP API
npm run start:dev

# Терминал 2 — Worker для публикации
npm run start:worker:dev
```

### 6. Проверка

```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":...,"timestamp":"..."}

curl http://localhost:3000/ready
# → {"status":"ok","checks":{"database":"up","redis":"up"}}
```

Откройте бота в Telegram и нажмите `/start` 🎉

---

## Docker (production)

```bash
# Запустить всё
docker compose up --build -d

# Применить миграции и seed
docker compose exec app npx prisma migrate deploy
docker compose exec app npm run prisma:seed
```

4 контейнера: `postgres` · `redis` · `app` (бот + HTTP) · `worker` (публикация).

---

## Как работает

### Архитектура

```
Telegram → grammY Bot → Handlers → Business Services → PostgreSQL
                                         ↓
                                    BullMQ Queue → Worker → Telegram Channel
```

Два процесса:
- **App** (`npm run start:dev`) — бот + HTTP (health, webhook)
- **Worker** (`npm run start:worker:dev`) — публикация постов через очередь

> Telegram — **только транспорт**. Вся логика в сервисах, не в handlers.

### Жизненный цикл поста

```
DRAFT → PENDING_REVIEW → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED
                ↓               ↓                               ↓
          NEEDS_REVISION   PUBLISHING ←──────── (retry) ── PUBLISH_FAILED
                ↓               ↓
          PENDING_REVIEW    CANCELLED
```

### Роли

| Роль | Создать | Редактировать | Одобрить | Публиковать |
|------|---------|--------------|----------|-------------|
| **Author** | ✅ | свои | ❌ | ❌ |
| **Editor** | ✅ | все | если `can_approve` | если `can_publish` |
| **Super Admin** | ✅ | все | ✅ | ✅ |

### Шаблоны

| Шаблон | Поля |
|--------|------|
| 📝 Лонг-рид | заголовок, лид, текст |
| 📢 Анонс | заголовок, дата, место, описание, ссылка |
| 🖼 Фото | подпись |
| 🎬 Видео | заголовок, описание |
| 📰 Новость | заголовок, факты, источник |
| ✍️ Свободный | произвольный текст |

Добавить новый шаблон можно через управление шаблонами в боте или прямо в `prisma/seed.ts` — **без изменения кода**.

---

## Команды бота

| Команда / Кнопка | Что делает |
|-----------------|-----------|
| `/start` | Авторизация + главное меню |
| ➕ Создать пост | Wizard создания поста |
| 📝 Мои материалы | Список черновиков |
| ✅ На согласовании | Очередь ревью (для Editor/Admin) |
| 📅 Контент-план | Запланированные публикации |
| ❓ Помощь | Справка |

---

## Структура проекта

```
src/
├── main.ts                     # Точка входа: бот + HTTP
├── worker.main.ts              # Точка входа: worker
├── common/                     # Константы, enums, DTO, exceptions
├── infrastructure/             # Prisma, Redis, BullMQ, Config, Logger, Telegram API
└── modules/
    ├── audit/                  # Аудит-логирование
    ├── auth/                   # Авторизация + permissions
    ├── channels/               # Каналы + timezone
    ├── health/                 # /health и /ready
    ├── media/                  # Медиа-файлы
    ├── notifications/          # Domain events → уведомления
    ├── posts/                  # Посты + state machine + OCC
    ├── publishing/             # BullMQ worker + idempotency
    ├── rendering/              # HTML sanitizer + renderer
    ├── reviews/                # Ревью
    ├── scheduling/             # Планирование
    ├── templates/              # Шаблоны постов
    ├── telegram/               # Транспорт: handlers, keyboards, middlewares
    └── users/                  # Пользователи

prisma/
├── schema.prisma               # 10 таблиц, 6 enum
└── seed.ts                     # Начальные данные

tests/
├── unit/                       # ~35 test suites
└── e2e/                        # 4 тестовых тира
```

---

## Скрипты

| Команда | Описание |
|---------|---------|
| `npm run start:dev` | Dev-запуск бота (watch mode) |
| `npm run start:worker:dev` | Dev-запуск worker'а (watch mode) |
| `npm run build` | Production build |
| `npm run start:prod` | Production запуск бота |
| `npm run start:worker:prod` | Production запуск worker'а |
| `npm test` | Unit-тесты (Jest) |
| `npm run test:e2e` | E2E-тесты |
| `npm run test:cov` | Coverage |
| `npm run lint` | ESLint |
| `npm run prisma:migrate` | Создать миграцию |
| `npm run prisma:seed` | Seed данных |

---

## Переменные окружения

| Переменная | Обязательная | Описание | По умолчанию |
|-----------|:---:|---------|-------------|
| `BOT_TOKEN` | ✅ | Telegram Bot API token | — |
| `DATABASE_URL` | ✅ | PostgreSQL URL | — |
| `REDIS_URL` | ✅ | Redis URL | — |
| `DEFAULT_TIMEZONE` | ✅ | Timezone каналов | `Europe/Kyiv` |
| `PORT` | | HTTP порт | `3000` |
| `TELEGRAM_MODE` | | `polling` или `webhook` | `polling` |
| `WEBHOOK_DOMAIN` | | Домен для webhook | — |
| `WEBHOOK_PATH` | | Путь webhook | `/telegram/webhook` |
| `WEBHOOK_SECRET_TOKEN` | | Секрет для webhook | — |
| `INITIAL_SUPER_ADMIN_TELEGRAM_ID` | | Telegram ID первого admin | — |
| `DEFAULT_CHANNEL_CHAT_ID` | | Chat ID канала | — |
| `LOG_LEVEL` | | Уровень логирования | `info` |

---

## Документация

| Файл | Содержание |
|------|-----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Детальная архитектура, диаграммы, модули |
| [SETUP.md](SETUP.md) | Подробный гайд по настройке |
| [AGENTS.md](AGENTS.md) | Правила для AI-агентов и разработки |
| [tasks.md](tasks.md) | Спецификация продукта |
