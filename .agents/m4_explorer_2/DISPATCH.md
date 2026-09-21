## 2026-09-21T13:56:47Z

<USER_REQUEST>
You are m4_explorer_2, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m4_explorer_2

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (specifically §16 Payload, §17 HTML, §18 Limits, §48 External API Isolation, §49 Network Failures, §50 Rate Limits)
- c:/TgHelp/tasks.md (specifically §16, §18, §48, §49, §50)
- c:/TgHelp/.agents/TEST_READY.md

Your mission:
Investigate and design the TelegramPublisher Abstraction & Error Categorization for Milestone 4:
1. ITelegramPublisher Interface (src/infrastructure/telegram-api/):
   - Design interface covering: sendMessage, sendPhoto, sendVideo, sendDocument, sendAnimation, sendMediaGroup.
   - Methods must accept target chatId (channel telegramChatId as string or bigint) and return Telegram message ID(s) (number or number[]).
2. Concrete TelegramPublisherService:
   - Implement wrapping grammY Bot API instance (bot.api).
   - Ensure single canonical rendering payload from TelegramRenderer is dispatched cleanly.
3. Telegram Error Categorization & Rate Limit Handling:
   - Analyze Telegram Bot API error responses and classify errors into:
     a) Rate Limited: HTTP 429 Too Many Requests, parameters.retry_after.
     b) Retryable: Network timeouts, 5xx server errors, connection resets.
     c) Permanent: HTTP 400 (chat not found, invalid payload), HTTP 403 (bot kicked, forbidden, not admin).
   - Design backoff strategy so rate limits signal BullMQ worker to delay next attempt by retry_after.
   - Ensure permanent errors fail fast without wasteful retries, transitioning directly to PUBLISH_FAILED.
4. Testing Abstraction & Mock Double:
   - Design mock double (MockTelegramPublisher) compatible with existing E2E harness and unit tests.
5. Formulate interfaces, types, error classes, and a step-by-step implementation roadmap for the Worker.

Write your findings to c:/TgHelp/.agents/m4_explorer_2/report.md and handoff to c:/TgHelp/.agents/m4_explorer_2/handoff.md.
Notify parent orchestrator via send_message when complete.
</USER_REQUEST>
