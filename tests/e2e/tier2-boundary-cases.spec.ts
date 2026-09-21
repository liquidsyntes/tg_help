/**
 * Tier 2: Boundary & Corner Cases (Negative Invariants & Constraints)
 * Verifies edge cases, boundary limits, concurrency conflicts, and failure modes:
 * - Empty revision comments (mandatory feedback enforcement)
 * - Scheduling dates in the past rejection
 * - Optimistic Concurrency Control (OCC) version conflict under concurrent edits
 * - HTML sanitization (stripping dangerous and unsupported tags)
 * - Telegram constraints enforcement (text length, media group bounds)
 * - Rate limit (429) handling and retry exhaustion transitioning to PUBLISH_FAILED
 *
 * Authoritative Sources:
 * - tasks.md §12, §13, §17, §18, §19, §22, §35
 * - AGENTS.md §13, §17, §18, §22, §24, §49, §50
 * - PROJECT.md F-06, F-16, F-17, F-19, F-26, F-35
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestHarness,
  PostConflictException,
  ValidationError,
  sanitizeTelegramHtml,
} from '../harness/test-harness.ts';
import { TEST_USERS, TEST_CHANNELS, TEST_TEMPLATES } from '../fixtures/test-data.ts';
import { TelegramApiError } from '../mocks/mock-telegram-publisher.ts';

describe('Tier 2: Boundary & Corner Cases (Invariants & Limits)', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = new TestHarness();
  });

  describe('2.1 Mandatory Review Comments (F-26, tasks.md §13)', () => {
    it('should reject request revision with empty string comment', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.transitionState(post.id, post.version, 'PENDING_REVIEW', TEST_USERS.author.id);

      await assert.rejects(
        async () => {
          // Attempting revision request with empty string
          await harness.transitionState(post.id, p1.version, 'NEEDS_REVISION', TEST_USERS.editor.id, '');
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /обязателен комментарий/i);
          return true;
        },
      );

      // Verify status remained PENDING_REVIEW
      assert.equal(harness.posts.get(post.id)?.status, 'PENDING_REVIEW');
    });

    it('should reject request revision with whitespace-only comment', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.transitionState(post.id, post.version, 'PENDING_REVIEW', TEST_USERS.author.id);

      await assert.rejects(
        async () => {
          await harness.transitionState(post.id, p1.version, 'NEEDS_REVISION', TEST_USERS.editor.id, '    \t\n  ');
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /обязателен комментарий/i);
          return true;
        },
      );

      assert.equal(harness.posts.get(post.id)?.status, 'PENDING_REVIEW');
    });
  });

  describe('2.2 Scheduling Invariants (F-06, tasks.md §19, AGENTS.md §24)', () => {
    it('should reject scheduling for a date/time in the past', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.transitionState(post.id, post.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p2 = await harness.transitionState(post.id, p1.version, 'APPROVED', TEST_USERS.editor.id);

      const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago

      await assert.rejects(
        async () => {
          await harness.schedulePost(post.id, p2.version, TEST_USERS.editor.id, pastDate);
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /Нельзя планировать публикацию в прошлом/i);
          return true;
        },
      );

      // Verify post remained APPROVED and not SCHEDULED
      assert.equal(harness.posts.get(post.id)?.status, 'APPROVED');
    });
  });

  describe('2.3 Optimistic Concurrency Control (OCC) Conflicts (F-16, AGENTS.md §13)', () => {
    it('should reject conflicting update when version mismatch occurs (WHERE version = :expected)', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      // User A reads version 1
      const initialVersion = post.version; // 1

      // User A saves title -> increments version to 2
      const userAUpdate = await harness.autosaveStep(
        post.id,
        initialVersion,
        TEST_USERS.author.id,
        'title',
        'Title by User A',
      );
      assert.equal(userAUpdate.version, 2);

      // User B attempts to save body using stale expected version 1
      await assert.rejects(
        async () => {
          await harness.autosaveStep(
            post.id,
            initialVersion, // Stale version 1!
            TEST_USERS.editor.id,
            'body',
            'Body by User B',
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof PostConflictException);
          assert.match((err as Error).message, /Публикация была изменена другим пользователем/i);
          return true;
        },
      );

      // Verify User B's change was NOT applied and version remains 2
      const current = harness.posts.get(post.id);
      assert.equal(current?.version, 2);
      assert.equal(current?.title, 'Title by User A');
      assert.equal(current?.contentJson.body, undefined);
    });
  });

  describe('2.4 Telegram HTML Sanitization (F-19, AGENTS.md §17, tasks.md §17)', () => {
    it('should strip malicious script tags and inline event handlers', () => {
      const dirtyHtml = '<p>Hello <script>alert("hack")</script><b onclick="bad()">World</b></p>';
      const clean = sanitizeTelegramHtml(dirtyHtml);

      assert.equal(clean.includes('<script>'), false);
      assert.equal(clean.includes('alert'), false);
      assert.equal(clean.includes('onclick'), false);
      assert.equal(clean, 'Hello <b>World</b>');
    });

    it('should preserve valid Telegram HTML tags (b, i, u, s, code, pre, blockquote, a)', () => {
      const validTelegramMarkup =
        '<b>Bold</b> <i>Italic</i> <u>Underline</u> <s>Strikethrough</s> <code>code</code> <blockquote>quote</blockquote> <a href="https://t.me/news">Link</a>';
      const clean = sanitizeTelegramHtml(validTelegramMarkup);

      assert.equal(clean, validTelegramMarkup);
    });

    it('should strip unsupported tags while preserving inner text content', () => {
      const unsupported = '<div><span>Section</span><h1>Title</h1><table><tr><td>Data</td></tr></table></div>';
      const clean = sanitizeTelegramHtml(unsupported);

      assert.equal(clean, 'SectionTitleData');
    });
  });

  describe('2.5 Telegram Limits & Validation Bounds (F-17, AGENTS.md §18)', () => {
    it('should reject text exceeding template schema maxLength', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      // News template title maxLength is 256
      const hugeTitle = 'A'.repeat(300);

      await assert.rejects(
        async () => {
          await harness.autosaveStep(post.id, post.version, TEST_USERS.author.id, 'title', hugeTitle);
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /exceeds max length/i);
          return true;
        },
      );
    });

    it('should reject media group with less than 2 items in publisher double', async () => {
      await assert.rejects(
        async () => {
          await harness.publisher.sendMediaGroup(TEST_CHANNELS.production.telegramChatId, [
            { type: 'photo', fileId: 'AgACAgIAAxkBAAI001' },
          ]);
        },
        (err: unknown) => {
          assert.ok(err instanceof TelegramApiError);
          assert.equal((err as TelegramApiError).statusCode, 400);
          assert.match((err as Error).message, /between 2 and 10 items/i);
          return true;
        },
      );
    });

    it('should reject media group with more than 10 items in publisher double', async () => {
      const elevenItems = Array.from({ length: 11 }, (_, i) => ({
        type: 'photo' as const,
        fileId: `file_${i}`,
      }));

      await assert.rejects(
        async () => {
          await harness.publisher.sendMediaGroup(TEST_CHANNELS.production.telegramChatId, elevenItems);
        },
        (err: unknown) => {
          assert.ok(err instanceof TelegramApiError);
          assert.equal((err as TelegramApiError).statusCode, 400);
          assert.match((err as Error).message, /between 2 and 10 items/i);
          return true;
        },
      );
    });
  });

  describe('2.6 Rate Limiting (429) & Retry Exhaustion (F-35, tasks.md §22, §35)', () => {
    it('should retry on transient 429 rate limit error and mark job PENDING for next attempt', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Headline');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      const job = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Simulate 1 rate limit response (HTTP 429, retry-after 3s)
      harness.publisher.simulateRateLimit(1, 3);

      // Execute worker attempt 1
      await harness.executePublicationWorker(job.id);

      // Job should be marked PENDING for retry, with attemptCount = 1
      const jobAfterAttempt1 = harness.publicationJobs.get(job.id);
      assert.equal(jobAfterAttempt1?.attemptCount, 1);
      assert.equal(jobAfterAttempt1?.status, 'PENDING');
      assert.match(jobAfterAttempt1?.lastError || '', /Too Many Requests/);

      // Post should not be marked PUBLISHED or PUBLISH_FAILED yet
      assert.equal(harness.posts.get(post.id)?.status, 'PUBLISHING');

      // Now rate limit is exhausted; attempt 2 should succeed
      await harness.executePublicationWorker(job.id);

      const jobAfterAttempt2 = harness.publicationJobs.get(job.id);
      assert.equal(jobAfterAttempt2?.status, 'COMPLETED');
      assert.equal(harness.posts.get(post.id)?.status, 'PUBLISHED');
    });

    it('should transition post to PUBLISH_FAILED when retries are exhausted after 3 attempts', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Critical Headline');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      const job = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Simulate 5 consecutive 500 errors (exceeds maxRetries = 3)
      harness.publisher.simulateTransientFailures(5);

      // Attempt 1
      await harness.executePublicationWorker(job.id);
      assert.equal(harness.publicationJobs.get(job.id)?.status, 'PENDING');

      // Attempt 2
      await harness.executePublicationWorker(job.id);
      assert.equal(harness.publicationJobs.get(job.id)?.status, 'PENDING');

      // Attempt 3 (final attempt)
      await harness.executePublicationWorker(job.id);

      // Retry exhausted!
      const failedJob = harness.publicationJobs.get(job.id);
      assert.equal(failedJob?.status, 'FAILED');
      assert.equal(failedJob?.attemptCount, 3);

      const finalPost = harness.posts.get(post.id);
      assert.equal(finalPost?.status, 'PUBLISH_FAILED');

      // Editor must be notified of failure (tasks.md §24, §35 Scenario 8)
      const editorNotifs = harness.notifications.getNotifications(TEST_USERS.editor.id);
      const failNotif = editorNotifs.find((n) => n.eventType === 'publication_failed');
      assert.ok(failNotif, 'Editor must receive publication_failed notification');
    });
  });
});
