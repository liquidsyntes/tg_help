/**
 * Tier 4: Real-World Application Scenarios (Full End-to-End Lifecycles)
 * Simulates end-to-end editorial workflows from user interactions through
 * the database, queues, workers, and simulated Telegram channel outputs.
 *
 * Scenarios:
 * 1. The Full Editorial Publishing Lifecycle (Critical Flow from tasks.md §34)
 * 2. Security Invariants & Permission Escalation Resistance
 * 3. Publication Outage, Failure Exhaustion & Manual Retry Recovery
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md Requirements R1, R2, R3 & Acceptance Criteria
 * - tasks.md §2, §6, §13, §20, §21, §22, §24, §34, §35
 * - AGENTS.md §8, §9, §10, §20, §21, §22, §23, §26, §27
 * - PROJECT.md F-01 through F-41
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestHarness,
  PermissionDeniedException,
  InvalidStateTransitionException,
} from '../harness/test-harness.ts';
import { TEST_USERS, TEST_CHANNELS, TEST_TEMPLATES } from '../fixtures/test-data.ts';

describe('Tier 4: Real-World Application Scenarios (End-to-End Lifecycles)', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = new TestHarness();
  });

  describe('4.1 The Complete Editorial Publishing Lifecycle (tasks.md §34)', () => {
    it('should execute end-to-end flow from Author draft to Channel publication', async () => {
      // Step 1: Author authenticates via Telegram ID
      const author = await harness.authenticate(TEST_USERS.author.telegramUserId);
      assert.equal(author.channelRole, 'AUTHOR');

      // Step 2: Author starts post creation wizard for Production Channel & News Template
      const post = await harness.createDraft(
        author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      assert.equal(post.status, 'DRAFT');
      assert.equal(post.version, 1);

      // Step 3: Author inputs Title (autosave v1 -> v2)
      const postV2 = await harness.autosaveStep(
        post.id,
        post.version,
        author.id,
        'title',
        '🚀 New Quantum Computing Breakthrough Discovered',
      );
      assert.equal(postV2.version, 2);

      // Step 4: Author inputs Rich Text Body (autosave v2 -> v3)
      const bodyText =
        'Scientists at the national research lab announced a <b>groundbreaking</b> quantum processor. ' +
        'Read more at <a href="https://example.com/quantum">official report</a>.';
      const postV3 = await harness.autosaveStep(post.id, postV2.version, author.id, 'body', bodyText);
      assert.equal(postV3.version, 3);

      // Step 5: Author attaches Media Photo (v3 -> v4)
      await harness.attachMedia(post.id, postV3.version, author.id, {
        telegramFileId: 'AgACAgIAAxkBAAI_QuantumLab',
        telegramFileUniqueId: 'AQADAgAT_Q1',
        mediaType: 'photo',
        caption: 'Laboratory Quantum Processor Prototype',
      });
      const postV4 = harness.posts.get(post.id)!;
      assert.equal(postV4.version, 4);

      // Step 6: Author submits draft for editorial review (v4 -> v5)
      const postV5 = await harness.transitionState(post.id, postV4.version, 'PENDING_REVIEW', author.id);
      assert.equal(postV5.status, 'PENDING_REVIEW');
      assert.equal(postV5.version, 5);

      // Verify Editor receives review notification
      const reviewAlert = harness.notifications
        .getNotifications(TEST_USERS.editor.id)
        .find((n) => n.eventType === 'submitted_for_review');
      assert.ok(reviewAlert, 'Editor must receive review alert');

      // Step 7: Editor inspects and requests revision with comment (v5 -> v6)
      const postV6 = await harness.transitionState(
        post.id,
        postV5.version,
        'NEEDS_REVISION',
        TEST_USERS.editor.id,
        'Please clarify the processor qubit count in the title.',
      );
      assert.equal(postV6.status, 'NEEDS_REVISION');
      assert.equal(postV6.version, 6);

      // Verify Author receives feedback
      const revisionAlert = harness.notifications
        .getNotifications(author.id)
        .find((n) => n.eventType === 'revision_requested');
      assert.ok(revisionAlert);
      assert.match(revisionAlert.details?.comment as string, /qubit count/i);

      // Step 8: Author updates Title based on Editor feedback (v6 -> v7)
      const postV7 = await harness.autosaveStep(
        post.id,
        postV6.version,
        author.id,
        'title',
        '🚀 256-Qubit Quantum Computing Breakthrough Discovered',
      );
      assert.equal(postV7.version, 7);

      // Step 9: Author resubmits revised draft (v7 -> v8)
      const postV8 = await harness.transitionState(post.id, postV7.version, 'PENDING_REVIEW', author.id);
      assert.equal(postV8.status, 'PENDING_REVIEW');
      assert.equal(postV8.version, 8);

      // Step 10: Editor approves post (v8 -> v9)
      const postV9 = await harness.transitionState(
        post.id,
        postV8.version,
        'APPROVED',
        TEST_USERS.editor.id,
        'Excellent revision. Ready for publishing.',
      );
      assert.equal(postV9.status, 'APPROVED');
      assert.equal(postV9.version, 9);

      // Step 11: Editor triggers publication -> enqueues BullMQ publication job
      const publishJob = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);
      assert.ok(publishJob.id);
      assert.equal(publishJob.idempotencyKey, `publish:${post.id}:${postV9.version}`);

      // Step 12: Publication Worker executes the publication job
      await harness.executePublicationWorker(publishJob.id);

      // Step 13: Verify publication outcome in Telegram channel
      const channelMessages = harness.publisher.getSentMessages(TEST_CHANNELS.production.telegramChatId);
      assert.ok(channelMessages.length >= 1, 'Target channel must receive publication message');

      const publishedMsg = channelMessages[0];
      assert.match(publishedMsg.text || '', /256-Qubit Quantum Computing Breakthrough/);
      assert.match(publishedMsg.text || '', /<b>groundbreaking<\/b>/);
      assert.match(publishedMsg.text || '', /<a href="https:\/\/example\.com\/quantum">/);

      // Step 14: Verify final database status and audit trail
      const finalPost = harness.posts.get(post.id)!;
      assert.equal(finalPost.status, 'PUBLISHED');
      assert.ok(finalPost.publishedAt instanceof Date);

      const postAuditEvents = harness.auditLogs
        .filter((a) => a.entityId === post.id)
        .map((a) => a.eventType);

      assert.deepEqual(postAuditEvents, [
        'post_created',
        'post_updated',
        'post_updated',
        'media_added',
        'submitted_for_review',
        'revision_requested',
        'post_updated',
        'submitted_for_review',
        'approved',
        'publication_started',
        'published',
      ]);

      // Step 15: Author received final publication notification
      const publishedAlert = harness.notifications
        .getNotifications(author.id)
        .find((n) => n.eventType === 'published');
      assert.ok(publishedAlert, 'Author must be notified when post is published');
    });
  });

  describe('4.2 Security Invariants & Permission Escalation Resistance', () => {
    it('should prevent Author from directly approving their own post or publishing to channel', async () => {
      const author = await harness.authenticate(TEST_USERS.author.telegramUserId);
      const post = await harness.createDraft(author.id, TEST_CHANNELS.production.id, TEST_TEMPLATES.news.id);
      const p1 = await harness.transitionState(post.id, post.version, 'PENDING_REVIEW', author.id);

      // Attack: Author attempts to approve own post
      await assert.rejects(
        async () => {
          await harness.transitionState(post.id, p1.version, 'APPROVED', author.id);
        },
        (err: unknown) => {
          assert.ok(err instanceof PermissionDeniedException);
          assert.match((err as Error).message, /does not have approve permission/i);
          return true;
        },
      );

      // Attack: Author attempts to trigger publication
      await assert.rejects(
        async () => {
          await harness.enqueuePublishJob(post.id, author.id);
        },
        (err: unknown) => {
          // Cannot publish: status is PENDING_REVIEW and author lacks publish permission
          assert.ok(err instanceof InvalidStateTransitionException || err instanceof PermissionDeniedException);
          return true;
        },
      );

      // Channel received zero messages
      assert.equal(harness.publisher.getSentMessages().length, 0);
    });

    it('should prevent User A from editing User B draft', async () => {
      const author = await harness.authenticate(TEST_USERS.author.telegramUserId);
      const post = await harness.createDraft(author.id, TEST_CHANNELS.production.id, TEST_TEMPLATES.news.id);

      const otherUser = TEST_USERS.deactivatedUser; // Another user entity

      await assert.rejects(
        async () => {
          await harness.autosaveStep(post.id, post.version, otherUser.id, 'title', 'Hijacked Title');
        },
        (err: unknown) => {
          assert.ok(err instanceof PermissionDeniedException);
          return true;
        },
      );

      assert.equal(harness.posts.get(post.id)?.title, null);
    });
  });

  describe('4.3 Outage Recovery & Manual Retry Scenario (tasks.md §22, §35 Scenario 8)', () => {
    it('should handle retry exhaustion to PUBLISH_FAILED and subsequent successful manual retry', async () => {
      const author = await harness.authenticate(TEST_USERS.author.telegramUserId);
      const post = await harness.createDraft(author.id, TEST_CHANNELS.production.id, TEST_TEMPLATES.news.id);
      const p1 = await harness.autosaveStep(post.id, 1, author.id, 'title', 'Urgent Announcement');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      // First publication attempt
      const job1 = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Simulate Telegram outage (3 consecutive failures)
      harness.publisher.simulateTransientFailures(3);

      // Exhaust all 3 worker retries
      await harness.executePublicationWorker(job1.id);
      await harness.executePublicationWorker(job1.id);
      await harness.executePublicationWorker(job1.id);

      // Post is now PUBLISH_FAILED
      const failedPost = harness.posts.get(post.id)!;
      assert.equal(failedPost.status, 'PUBLISH_FAILED');

      // Editor receives failure notification
      const failNotif = harness.notifications
        .getNotifications(TEST_USERS.editor.id)
        .find((n) => n.eventType === 'publication_failed');
      assert.ok(failNotif);

      // --- Manual Retry Phase ---
      // Editor clicks "🔁 Повторить публикацию"
      // Recovery enqueues new publication job for the failed post:
      harness.publisher.resetFailures(); // Telegram outage resolved!

      const job2 = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);
      assert.notEqual(job1.id, job2.id); // New distinct job
      assert.equal(job2.postVersion, failedPost.version);

      // Worker executes manual retry job
      await harness.executePublicationWorker(job2.id);

      // Post successfully published!
      const recoveredPost = harness.posts.get(post.id)!;
      assert.equal(recoveredPost.status, 'PUBLISHED');
      assert.ok(recoveredPost.publishedAt instanceof Date);

      // Channel received publication
      const sent = harness.publisher.getSentMessages(TEST_CHANNELS.production.telegramChatId);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text || '', /Urgent Announcement/);
    });
  });
});
