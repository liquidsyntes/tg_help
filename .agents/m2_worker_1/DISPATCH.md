## 2026-09-21T08:29:56Z
You are m2_worker_1, a teamwork_preview_worker.
Your working directory is: c:/TgHelp/.agents/m2_worker_1

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/.agents/m2_explorer_1/report.md
- c:/TgHelp/.agents/m2_explorer_2/report.md
- c:/TgHelp/.agents/m2_explorer_3/report.md
- c:/TgHelp/tasks.md
- c:/TgHelp/AGENTS.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

File Ownership:
You own Milestone 2 domain modules:
- src/modules/auth/ (auth.service.ts, auth.module.ts, permission.service.ts, role.guard.ts, auth.guard.ts)
- src/modules/users/ (users.service.ts, users.module.ts, users.repository.ts)
- src/modules/channels/ (channels.service.ts, channels.module.ts)
- src/modules/posts/ (posts.service.ts, posts.repository.ts, post-workflow.service.ts, posts.module.ts)
- src/modules/reviews/ (reviews.service.ts, reviews.module.ts)
- src/modules/audit/ (audit.service.ts, audit.module.ts, audit-payload.sanitizer.ts)
- src/modules/notifications/ (notification.service.ts, notification.module.ts, domain-event.bus.ts)
- Update src/app.module.ts to register all new modules.
- Unit tests in tests/unit/ covering auth, permissions, timezone conversions, OCC state transitions, audit logging, and reviews.

Your mission:
Implement Milestone 2 per the reports of m2_explorer_1, m2_explorer_2, and m2_explorer_3:
1. Implement UsersService and AuthService:
   - Authenticate users by BigInt telegramId, enforce isActive flag.
   - Rejection handling with user-friendly Russian messages.
2. Implement PermissionService & RBAC:
   - SystemRole (SUPER_ADMIN, USER) vs ChannelRole (EDITOR, AUTHOR, VIEWER).
   - Granular permissions: canPublish, canApprove.
   - SUPER_ADMIN system bypass rules.
3. Implement ChannelsService:
   - Multi-channel querying, autoSkipSingleChannel helper.
   - Timezone parsing and conversion using channel's timezone (default Europe/Kyiv) to UTC TIMESTAMPTZ using luxon (or native/date-fns), rejecting past dates.
4. Implement PostsRepository and PostWorkflowService:
   - 10 statuses (DRAFT, PENDING_REVIEW, APPROVED, NEEDS_REVISION, REJECTED, SCHEDULED, PUBLISHING, PUBLISHED, PUBLISH_FAILED, CANCELLED).
   - Strict transition rules. Disallowed transitions throw InvalidPostStateTransitionException (compatible with InvalidStateTransitionException).
   - Optimistic Concurrency Control: atomic check WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL, incrementing version. On mismatch, throw PostConflictException.
   - Soft delete: set deleted_at = NOW(). Normal queries filter deleted_at: null.
5. Implement ReviewsService:
   - Enforce mandatory non-empty comment on REQUEST_REVISION / NEEDS_REVISION.
6. Implement AuditLogService:
   - Append-only recording of all domain actions in audit_logs with sanitized payloads.
7. Implement NotificationService & DomainEventBus:
   - Decoupled notifications on domain events.
   - Autosave silent rule: routine draft saves emit 0 notifications.
   - Atomic combined transaction: post state change + review entry + audit log inside prisma.$transaction.
8. Verify npm run build passes, npm test passes, and npm run test:e2e passes (34/34).
9. Write change summary to c:/TgHelp/.agents/m2_worker_1/changes.md and handoff report to c:/TgHelp/.agents/m2_worker_1/handoff.md.

When finished, use send_message to notify the parent orchestrator with the build/test results and handoff path.
