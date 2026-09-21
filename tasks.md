````md
# Telegram Content Publisher Bot

## 1. Назначение

Разработать Telegram-бота для создания, согласования,
планирования и публикации контента в Telegram-канал.

Бот является редакционной панелью внутри Telegram.

Основной принцип UX:

> пользователь не должен запоминать команды или внутренние статусы;
> основные действия выполняются через кнопки и пошаговые формы.

---

# 2. Scope MVP

MVP должен позволять:

1. Авторизовать пользователей по Telegram ID.
2. Поддерживать роли:
   - Super Admin
   - Editor
   - Author
3. Создавать и сохранять черновики.
4. Создавать посты разных типов.
5. Добавлять:
   - текст;
   - фото;
   - media groups;
   - видео;
   - документы;
   - ссылки.
6. Показывать preview будущей публикации.
7. Отправлять пост на согласование.
8. Возвращать пост автору на доработку.
9. Одобрять или отклонять публикацию.
10. Публиковать пост немедленно.
11. Планировать публикацию.
12. Надёжно выполнять публикацию через очередь задач.
13. Хранить историю действий.
14. Восстанавливаться после перезапуска без потери:
    - черновиков;
    - статусов;
    - расписания.

## 2.1. Не входит в MVP

В MVP не требуется:

- полноценная веб-панель;
- AI-ассистент;
- расширенная Telegram-аналитика;
- visual template builder;
- Google Drive / Notion / Google Sheets integrations;
- RSS;
- сложный workflow из нескольких редакторов;
- кросспостинг;
- публикация Stories.

Архитектура не должна препятствовать добавлению этих функций позже.

---

# 3. Каналы

Для MVP достаточно поддержки:

- одного production-канала;
- одного test/staging-канала.

При этом модель данных должна поддерживать несколько каналов.

Каждый канал имеет:

```text
id
telegram_chat_id
title
username
timezone
publication_mode
is_active
````

Default timezone:

```text
Europe/Kyiv
```

---

# 4. Пользователи и права

## 4.1. Super Admin

Может:

* добавлять пользователей;
* удалять пользователей;
* управлять каналами;
* назначать права;
* создавать и редактировать шаблоны;
* видеть все публикации;
* редактировать публикации;
* согласовывать;
* публиковать;
* управлять расписанием;
* видеть audit log;
* изменять системные настройки.

## 4.2. Editor

Может:

* создавать публикации;
* видеть публикации доступного канала;
* редактировать публикации;
* согласовывать публикации;
* возвращать на доработку;
* отклонять;
* публиковать;
* планировать публикации.

## 4.3. Author

Может:

* создавать публикации;
* редактировать собственные черновики;
* добавлять медиа;
* отправлять публикацию на согласование;
* исправлять публикацию после возврата;
* видеть собственные материалы.

Не может публиковать напрямую,
если у него отсутствует соответствующее permission.

---

# 5. Permission model

Глобальная роль пользователя не должна быть единственным
источником прав.

```text
users
channel_members
```

Рекомендуемая модель:

```text
users.system_role:
SUPER_ADMIN
USER
```

Права конкретного канала:

```text
channel_members.role:
EDITOR
AUTHOR
VIEWER

channel_members.can_publish
channel_members.can_approve
```

Все действия должны проверять permissions на backend.

Telegram UI не является механизмом безопасности.

---

# 6. Жизненный цикл публикации

Основные статусы:

```text
DRAFT
PENDING_REVIEW
NEEDS_REVISION
APPROVED
SCHEDULED
PUBLISHING
PUBLISHED
REJECTED
CANCELLED
PUBLISH_FAILED
```

Разрешённые переходы:

```text
DRAFT
→ PENDING_REVIEW

PENDING_REVIEW
→ APPROVED
→ NEEDS_REVISION
→ REJECTED

NEEDS_REVISION
→ PENDING_REVIEW

APPROVED
→ SCHEDULED
→ PUBLISHING

APPROVED
→ PUBLISHING

SCHEDULED
→ PUBLISHING
→ CANCELLED

PUBLISHING
→ PUBLISHED
→ PUBLISH_FAILED

PUBLISH_FAILED
→ PUBLISHING
→ CANCELLED
```

Любой другой переход запрещён.

Изменение статуса выполняется только через domain service.

Каждый переход записывается в audit log.

---

# 7. Первый запуск

После:

```text
/start
```

бот:

1. получает Telegram ID;
2. ищет пользователя;
3. проверяет status;
4. загружает permissions;
5. показывает соответствующее меню.

Если пользователя нет:

```text
У вас пока нет доступа к редакции.
Обратитесь к администратору.
```

---

# 8. Главное меню

Author:

```text
➕ Создать пост
📝 Мои материалы
📅 Контент-план
📚 Публикации
❓ Помощь
```

Editor / Admin:

```text
➕ Создать пост
📝 Материалы
✅ На согласовании
📅 Контент-план
📚 Публикации
👥 Пользователи
⚙️ Настройки
```

---

# 9. Создание публикации

Создание работает как Wizard.

## Шаг 1

Выбор канала.

Если доступен только один канал — шаг пропускается.

## Шаг 2

Выбор шаблона:

```text
📝 Лонг-рид
📢 Анонс
🖼 Фото
🎬 Видео
📰 Новость
✍️ Свободный формат
```

## Шаг 3

Заполнение полей шаблона.

После каждого успешно заполненного шага изменения
автоматически записываются в PostgreSQL.

In-memory session не является источником истины.

## Шаг 4

Добавление медиа.

Поддержать:

```text
photo
video
document
animation
media group
```

## Шаг 5

Метаданные:

```text
rubric
tags
CTA
link
comment_to_editor
priority
scheduled_at
```

## Шаг 6

Preview.

Кнопки:

```text
✏️ Редактировать
🖼 Медиа
📅 Запланировать
✅ На согласование
🚀 Опубликовать
🗑 Удалить
```

Кнопки показываются согласно permissions.

---

# 10. Autosave

Черновик должен сохраняться после каждого изменения.

Пример:

```text
Title entered
→ UPDATE posts

Body entered
→ UPDATE posts

Media uploaded
→ INSERT post_media
```

Перезапуск приложения не должен приводить к потере
незавершённой публикации.

---

# 11. Editing

Редактирование выполняется по отдельным полям.

```text
Что изменить?

Заголовок
Основной текст
Медиа
Ссылки
Теги
CTA
Время публикации
Комментарий редактору
```

Повторное прохождение всей формы не требуется.

---

# 12. Optimistic locking

`posts` содержит:

```text
version INTEGER
```

При изменении используется:

```text
WHERE id = :id
AND version = :expected_version
```

Если версия была изменена другим пользователем,
операция отклоняется.

Пользователь получает сообщение:

```text
Публикация была изменена другим пользователем.
Откройте актуальную версию и повторите изменение.
```

---

# 13. Согласование

Author:

```text
Отправить на согласование
```

система:

```text
DRAFT
→ PENDING_REVIEW
```

Editor получает:

```text
Автор
Канал
Тип публикации
Дата создания
Приоритет
Комментарий
Preview
```

Actions:

```text
✅ Одобрить
✏️ Редактировать
↩️ На доработку
❌ Отклонить
```

Для возврата на доработку обязателен комментарий.

После возврата:

```text
PENDING_REVIEW
→ NEEDS_REVISION
```

Author получает notification.

---

# 14. Templates

Шаблоны хранятся в PostgreSQL.

```text
post_templates

id
key
name
description
schema_json
render_config
supported_media_types
version
is_active
created_at
updated_at
```

Пример:

```json
{
  "fields": [
    {
      "key": "title",
      "type": "text",
      "required": true,
      "maxLength": 256
    },
    {
      "key": "body",
      "type": "rich_text",
      "required": true
    }
  ]
}
```

Telegram handlers не должны знать структуру конкретного шаблона.

---

# 15. Rendering

Должен существовать один rendering pipeline:

```text
Post
+
Template
+
Media
↓
TelegramRenderer
↓
TelegramPayload
```

Один и тот же renderer используется для:

```text
preview
publication
```

Это гарантирует соответствие preview реальной публикации.

---

# 16. TelegramPayload

Результат renderer должен описывать не только текст,
а все Telegram messages публикации.

Пример:

```json
{
  "messages": [
    {
      "type": "media_group",
      "items": []
    },
    {
      "type": "text",
      "html": "<b>...</b>"
    }
  ]
}
```

Это позволяет корректно публиковать:

```text
media group
+
длинный текст
```

как одну логическую публикацию.

---

# 17. Formatting

Использовать Telegram HTML parse mode.

Разрешённые элементы:

```html
<b>
<i>
<u>
<s>
<code>
<pre>
<a>
<blockquote>
```

Перед публикацией:

```text
sanitize
→ validate
→ render
→ preview
→ publish
```

Невалидный HTML не должен попадать в publication queue.

---

# 18. Media

Хранить:

```text
telegram_file_id
telegram_file_unique_id
media_type
file_name
mime_type
file_size
caption
sort_order
```

Повторная публикация должна использовать `file_id`
без повторной загрузки файла.

---

# 19. Scheduling

Дата вводится в timezone канала.

Пример:

```text
Europe/Kyiv
21.09.2026 18:30
```

При сохранении преобразуется в UTC.

В PostgreSQL:

```text
scheduled_at TIMESTAMPTZ
```

Нельзя планировать публикацию в прошлом.

Preflight validation выполняется:

1. при создании расписания;
2. непосредственно перед публикацией.

---

# 20. Publication queue

Публикация никогда не выполняется непосредственно
из Telegram handler.

Flow:

```text
Telegram callback
↓
Application service
↓
Permission check
↓
Validation
↓
Publication job
↓
BullMQ
↓
Worker
↓
Telegram API
↓
PostgreSQL
↓
Notification
```

---

# 21. Idempotency

Каждая publication job имеет:

```text
idempotency_key
```

Пример:

```text
publish:{post_id}:{post_version}
```

`idempotency_key` должен быть UNIQUE.

Повторное нажатие кнопки не должно приводить
к повторной публикации.

---

# 22. Publication retry

При временной ошибке:

```text
attempt 1
↓
backoff
↓
attempt 2
↓
backoff
↓
attempt 3
```

После исчерпания retries:

```text
PUBLISH_FAILED
```

Пользователь получает:

```text
🔁 Повторить публикацию
```

---

# 23. Partial publishing

Если публикация состоит из нескольких Telegram messages,
worker обязан сохранять ID каждого успешно отправленного сообщения.

```text
telegram_message_ids
```

При retry уже отправленные части публикации
не должны отправляться повторно.

---

# 24. Notifications

Уведомлять:

Editor:

```text
новый post на review
publication failed
```

Author:

```text
approved
revision requested
rejected
scheduled
published
publication failed
```

Admin:

```text
critical system errors
```

Не отправлять отдельное notification после обычного autosave.

---

# 25. Database

Использовать:

```text
PostgreSQL
Prisma
```

Основные таблицы:

```text
users
channels
channel_members
posts
post_templates
post_media
post_reviews
publication_jobs
audit_logs
```

Дополнительно рекомендуется:

```text
post_versions
```

---

# 26. Audit log

Логировать:

```text
post_created
post_updated
media_added
media_removed
submitted
approved
revision_requested
rejected
scheduled
publication_started
published
publication_failed
publication_cancelled
user_added
permission_changed
settings_changed
```

Audit log является append-only.

---

# 27. Backend

Стек:

```text
Node.js 22+
TypeScript
NestJS
grammY
PostgreSQL
Prisma
Redis
BullMQ
Docker
```

---

# 28. Application architecture

```text
src/

modules/
  users/
  channels/
  posts/
  templates/
  reviews/
  publishing/
  scheduling/
  media/
  notifications/
  audit/
  telegram/

infrastructure/
  database/
  redis/
  queue/
  telegram/
  logger/
  config/

common/
  guards/
  dto/
  enums/
  exceptions/
  utils/
```

Telegram module является transport layer.

Бизнес-логика не должна находиться в Telegram handlers.

---

# 29. HTTP endpoints MVP

Обязательные endpoints:

```text
POST /telegram/webhook

GET /health
GET /ready
```

Полноценный REST API для управления публикациями
не является обязательным для MVP.

Он добавляется вместе с web-panel.

---

# 30. Security

Обязательно:

```text
Telegram ID authorization
permission checks
input validation
HTML sanitization
callback replay protection
rate limiting
webhook secret
HTTPS
environment secrets
no secrets in repository
```

Логи не должны содержать:

```text
BOT_TOKEN
API keys
пароли
authorization headers
```

---

# 31. Observability

Использовать structured JSON logs.

Каждая операция имеет:

```text
request_id
user_id
post_id
job_id
```

где применимо.

Минимальные metrics:

```text
publication_success_total
publication_failed_total
publication_duration
queue_depth
queue_failed_jobs
```

---

# 32. Deployment

Docker Compose:

```text
app
worker
postgres
redis
```

Среды:

```text
local
staging
production
```

Staging должен иметь:

```text
отдельного Telegram bot
отдельную PostgreSQL
отдельный Redis
тестовый Telegram channel
```

---

# 33. Backup

Production PostgreSQL должен регулярно резервироваться.

Минимально:

```text
daily backup
```

Необходимо периодически проверять возможность восстановления backup.

---

# 34. Testing

## Unit

Обязательно протестировать:

```text
permissions
status transitions
template validation
renderer
HTML sanitation
publication idempotency
```

## Integration

```text
PostgreSQL
Redis
BullMQ
Prisma
publication worker
```

## E2E

Основной сценарий:

```text
Author creates post
↓
autosave
↓
submit
↓
Editor requests revision
↓
Author edits
↓
submit
↓
Editor approves
↓
schedule
↓
worker publishes
↓
PUBLISHED
```

---

# 35. Acceptance criteria

## Scenario 1

Given пользователь отсутствует в базе

When выполняет `/start`

Then бот не предоставляет доступ.

---

## Scenario 2

Given Author создаёт публикацию

When каждый шаг формы завершён

Then данные сохраняются в PostgreSQL.

---

## Scenario 3

Given пост имеет статус DRAFT

When Author нажимает:

```text
Отправить на согласование
```

Then:

```text
status = PENDING_REVIEW
```

And Editor получает notification.

---

## Scenario 4

Given пост имеет:

```text
PENDING_REVIEW
```

When Editor возвращает его на доработку

Then комментарий обязателен

And:

```text
status = NEEDS_REVISION
```

And Author получает notification.

---

## Scenario 5

Given:

```text
status = APPROVED
```

When Editor выбирает публикацию сейчас

Then создаётся publication job

And Telegram handler не вызывает Telegram publish API напрямую.

---

## Scenario 6

Given пользователь дважды нажал:

```text
Опубликовать
```

Then Telegram получает только одну публикацию.

---

## Scenario 7

Given приложение было перезапущено

Then:

```text
drafts сохраняются
scheduled jobs сохраняются
publication state сохраняется
```

---

## Scenario 8

Given Telegram API временно недоступен

Then worker делает retries

And после исчерпания retries:

```text
status = PUBLISH_FAILED
```

And Editor получает notification.

---

# 36. Definition of Done

MVP готов, когда:

* авторизация работает;
* permissions работают;
* Author может создать публикацию;
* autosave работает;
* медиа поддерживается;
* preview соответствует реальной публикации;
* review workflow работает;
* scheduling работает;
* publication queue работает;
* duplicate publication невозможен;
* retry работает;
* audit log работает;
* restart не приводит к потере данных;
* staging окружение существует;
* production разворачивается через Docker;
* есть automated tests;
* есть README;
* secrets отсутствуют в repository.

---

# 37. Future

После MVP могут быть добавлены:

```text
Web panel
Kanban
Calendar
AI assistant
Analytics
Multi-channel publishing
Crossposting
Google Drive
Google Sheets
Notion
RSS
S3
Telegram analytics
Content performance analytics
```

Архитектура MVP должна позволять добавлять эти возможности
без переписывания publishing core.

```
```
