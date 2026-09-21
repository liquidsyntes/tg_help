## 2026-09-21T03:41:21Z
You are test_writer_e2e, a teamwork_preview_test_writer.
Your working directory is: c:/TgHelp/.agents/test_writer_e2e

You MUST read:
- c:/TgHelp/.agents/ORIGINAL_REQUEST.md (MANDATORY: read this first!)
- c:/TgHelp/.agents/PROJECT.md
- c:/TgHelp/tasks.md
- c:/TgHelp/AGENTS.md

Your mission:
Lead the E2E Testing Track for the Telegram Content Publisher Bot MVP.
1. Design the E2E test infrastructure, philosophy, and test architecture. Write c:/TgHelp/.agents/TEST_INFRA.md following the TEST_INFRA template in the project rules.
2. Establish the test runner and opaque-box test suites in tests/e2e/ (or test/) covering Tiers 1-4:
   - Tier 1: Feature Coverage (happy-path tests verifying features in isolation: auth rejection, draft creation, state transitions, review feedback, idempotency, etc.)
   - Tier 2: Boundary & Corner Cases (empty comments, past scheduling, OCC version conflict, malformed HTML, max text length, rate limits)
   - Tier 3: Cross-Feature Combinations (editorial review with revision cycle, scheduled publishing, partial publication resume)
   - Tier 4: Real-World Application Scenarios (end-to-end editorial publishing lifecycle from author draft to simulated channel publication)
3. Ensure the test harness can run against the application using mocks for the Telegram Bot API and BullMQ triggers so tests run programmatically in CI/CD without real Telegram tokens.
4. When the test suite structure and initial tests are ready, publish c:/TgHelp/.agents/TEST_READY.md.

Write your report to c:/TgHelp/.agents/test_writer_e2e/report.md and handoff to c:/TgHelp/.agents/test_writer_e2e/handoff.md.
When finished, use send_message to notify the parent orchestrator.
