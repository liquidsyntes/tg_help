## 2026-09-21T19:08:46Z
You are m5_worker_1, a teamwork_preview_worker.
Your working directory is: c:/TgHelp/.agents/m5_worker_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md
- c:/TgHelp/tasks.md
- c:/TgHelp/.agents/m5_explorer_1/report.md and handoff.md (Bot Lifecycle, Auth Middleware, Exception Filter)
- c:/TgHelp/.agents/m5_explorer_2/report.md and handoff.md (Post Creation Wizard, Immediate PostgreSQL Autosave, Media Handling)
- c:/TgHelp/.agents/m5_explorer_3/report.md and handoff.md (Canonical Preview, Companion Control Card, Review Workflow, Scheduling UI, Stale Button Defense)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Mission:
Implement Milestone 5 (Telegram Transport & Interactive Wizard UI) in c:/TgHelp:

1. Telegram Bot Infrastructure (src/modules/telegram/):
   - Implement TelegramBotService: grammY Bot<BotContext> lifecycle. Polling mode with @grammyjs/runner, graceful shutdown, deleteWebhook on startup. Suppress polling if config.isTest === true. Webhook mode support.
   - Implement TelegramWebhookController & TelegramWebhookGuard: handle POST /telegram/webhook with constant-time token comparison (crypto.timingSafeEqual).
   - Implement TelegramAuthMiddleware: resolve user by Telegram ID (BigInt) via AuthService.resolveUser. Immediate friendly Russian rejection for unregistered users ("У вас пока нет доступа к редакции. Обратитесь к администратору." showing their Telegram ID). Rejection for deactivated users. Enriches BotContext (authUser, isSuperAdmin, permissions).
   - Implement TelegramExceptionFilter: catch domain/conflict/validation exceptions and map to friendly Russian messages with show_alert: true on callbacks.
   - Implement StartHandler & HelpHandler: role-tailored menus for Author vs Editor/Admin.

2. Step-by-Step Post Creation Wizard with Immediate PostgreSQL Autosave:
   - Implement PostWizardService & PostWizardHandler:
     - Channel selection (auto-skip if user has exactly 1 channel via ChannelsService.autoSkipSingleChannel).
     - Template selection (display active templates from TemplatesService).
     - Initialize draft via PostsService.createDraft upon template selection (persisted to DB, status DRAFT, version 1).
     - Dynamic schema loop: prompt field-by-field based on template.schemaJson.fields.
     - Validate inputs via TemplateValidator with empathetic Russian error hints.
     - IMMEDIATE PostgreSQL Autosave (AGENTS.md §11, §12): invoke PostsService.autosaveStep upon each valid field entry. State is immediately persistent in PostgreSQL. Silent autosave (no notifications).
   - Implement DraftManagerService & DraftManagerHandler:
     - /drafts command and "Мои материалы" menu.
     - List drafts, resume draft creation from first missing field or open draft control card.

3. Media Attachment Handling:
   - Handle photos, videos, documents-as-video (MediaDetector.isDocumentAsVideo), and media groups (2-10 items).
   - Zero-download principle: persist and reuse Telegram file_id via MediaService without downloading bytes.
   - Album debouncing/batching to prevent OCC collisions during multi-message album uploads.

4. Canonical Preview & Companion Control Card:
   - Implement TelegramPreviewService:
     - Uses canonical TelegramRenderer.render for 100% parity between preview and publishing (AGENTS.md §15).
     - Companion Control Card: Send canonical preview followed by a dedicated companion control card containing post metadata badge and inline action buttons (avoiding Telegram sendMediaGroup reply_markup limitation and enabling in-place UI edits).
     - Action buttons: Submit for Review, Edit, Delete Draft (with confirmation).

5. Review & Editorial Workflow UI:
   - Implement ReviewQueueService & ReviewQueueHandler:
     - Review queue: list posts in PENDING_REVIEW for editors/admins.
     - Review action buttons: Approve (r:app), Request Revision (r:rev), Reject (r:rej).
     - Revision flow: prompt editor for mandatory feedback comment, save to PostReviewHistory, transition PENDING_REVIEW -> NEEDS_REVISION, notify author.

6. Publication & Scheduling UI:
   - "Publish Now" (pub:now): calls PublishingService.enqueuePublish.
   - "Schedule" (pub:sch): prompts for date/time (default Europe/Kyiv), validates via parseAndValidateScheduledDate, calls SchedulingService.schedulePost.
   - "Cancel Schedule": calls SchedulingService.cancelSchedule.

7. Concurrency & Stale Button Defense:
   - Typesafe CallbackCodec (strictly <= 64 bytes: <action>:<postId>:<expectedVersion>).
   - Compares expectedVersion with DB post version; alerts user with Russian warning on conflict without mutating state.

8. Outbound Telegram Notifications:
   - Wire NotificationService with ITelegramPublisher so domain events (approved, revision requested, rejected, published, failed) deliver real Telegram messages to users via sendMessage in try/catch.

9. Wire TelegramModule into src/app.module.ts.
10. Unit Tests & Verification:
    - Write unit tests covering handlers, wizard steps, autosave, callback codec, and error filter.
    - Run npm run build (must exit 0).
    - Run npm test (all unit tests must pass 100%).
    - Run npm run test:e2e (all 34 E2E tests must pass 100%).
