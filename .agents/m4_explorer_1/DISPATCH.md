## 2026-09-21T13:56:47Z

You are m4_explorer_1, a teamwork_preview_explorer.
Your working directory is: c:/TgHelp/.agents/m4_explorer_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/AGENTS.md (specifically §20 Publishing, §21 Idempotency, §22 Queue Jobs, §28 Transactions, §30 Constraints)
- c:/TgHelp/tasks.md (specifically §20, §21, §22, §26)
- c:/TgHelp/.agents/TEST_READY.md

Your mission:
Investigate and design the Publishing Queue & BullMQ Worker Architecture for Milestone 4:
1. BullMQ Queue & Worker Architecture:
   - Investigate queue definition in src/infrastructure/queues/ (publication queue with Redis connection).
   - Design Job payload: PublishJobData { postId: string; postVersion: number; channelId: string; actorId: string; }.
   - Design BullMQ worker processor (PublishingProcessor): worker options, concurrency, exponential backoff retry strategy, stalled job handling, graceful worker shutdown (onModuleDestroy).
2. Database-Enforced Idempotency Key:
   - Key format: publish:{postId}:{postVersion} (Rule F-23).
   - Investigate database uniqueness guarantee in PublicationJob.idempotencyKey.
   - Design atomic job creation / claim: prevent duplicate publication if job is retried or enqueued multiple times.
3. State Machine Integration:
   - Transition APPROVED / SCHEDULED -> PUBLISHING when worker starts processing.
   - Transition PUBLISHING -> PUBLISHED on successful completion.
   - Transition PUBLISHING -> PUBLISH_FAILED on retry exhaustion with error details stored.
   - Ensure transitions use PostWorkflowService with OCC checks and atomic transactions.
4. PublishingService Enqueueing:
   - Design PublishingService.enqueuePublish(postId, actorId): permission checks, state validation, creating PublicationJob, adding job to BullMQ queue.
5. Formulate interfaces, DTOs, domain exceptions, and a step-by-step implementation roadmap for the Worker.

Write your findings to c:/TgHelp/.agents/m4_explorer_1/report.md and handoff to c:/TgHelp/.agents/m4_explorer_1/handoff.md.
Notify parent orchestrator via send_message when complete.
