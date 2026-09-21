## 2026-09-21T19:04:50Z

You are m5_explorer_1, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m5_explorer_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (§3, §4, §5, §8, §9, §32, §36, §37)
- c:/TgHelp/tasks.md (§4, §5, §28, §29)

Your mission:
Investigate and design Telegram Transport, Bot Lifecycle, and Authentication Middleware for Milestone 5:
1. Bot Setup & Lifecycle (src/modules/telegram/):
   - Review grammY bot setup, configuration, and lifecycle in NestJS.
   - Design TelegramBotService with lifecycle hooks (onModuleInit, onApplicationShutdown).
   - Design dual transport mode: Webhook (POST /telegram/webhook with secret_token validation) and Polling mode for local dev.
2. Authentication & Authorization Middleware:
   - Resolve user by Telegram ID (BigInt) via AuthService.resolveUser.
   - Handle unregistered users (informative prompt, access request).
   - Handle deactivated/blocked users (UserDeactivatedException).
   - Attach resolved user entity and permissions to Telegram context.
3. Centralized Exception Filter / Error Handler:
   - Map domain exceptions (UnauthorizedException, ForbiddenException, PostConflictException, ValidationException) to clear, friendly Russian messages (AGENTS.md §32).
4. Formulate interfaces, DTOs, and concrete implementation recommendations for the Worker.

Write your report to c:/TgHelp/.agents/m5_explorer_1/report.md and handoff to c:/TgHelp/.agents/m5_explorer_1/handoff.md.
Use send_message to notify parent orchestrator when complete.
