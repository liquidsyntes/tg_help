/**
 * Tier 1: Feature Coverage (Isolated Happy-Path Tests)
 * Verifies core features in isolation according to requirements:
 * - Auth rejection and role-based access
 * - Draft creation and step-by-step autosave
 * - State machine transitions and audit logging
 * - Editorial review feedback (approve / reject)
 * - Publication idempotency key and queue worker execution
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md Acceptance Criteria
 * - tasks.md §4, §6, §7, §8, §9, §10, §13, §20, §21, §35
 * - AGENTS.md §8, §9, §10, §11, §12, §20, §21, §26
 * - PROJECT.md F-01, F-02, F-08, F-10, F-11, F-23, F-25, F-27, F-30, F-31
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestHarness,
  UnauthorizedUserException,
  UserDeactivatedException,
  InvalidStateTransitionException,
} from '../harness/test-harness.ts';
import { TEST_USERS, TEST_CHANNELS, TEST_TEMPLATES } from '../fixtures/test-data.ts';

describe('Tier 1: Feature Coverage (Isolated Verification)', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = new TestHarness();
  });

  describe('1.1 Authentication & RBAC (F-01, F-02)', () => {
    it('should reject unknown Telegram ID on /start with UnauthorizedUserException', async () => {
      const unregisteredTelegramId = 777777777n;

      await assert.rejects(
        async () => {
          await harness.authenticate(unregisteredTelegramId);
        },
        (err: unknown) => {
          assert.ok(err instanceof UnauthorizedUserException);
          assert.match((err as Error).message, /Access denied/i);
          return true;
        },
      );
    });

    it('should reject deactivated user with UserDeactivatedException', async () => {
      const deactTelegramId = TEST_USERS.deactivatedUser.telegramUserId;

      await assert.rejects(
        async () => {
          await harness.authenticate(deactTelegramId);
        },
        (err: Error) => {
          assert.ok(err instanceof UserDeactivatedException);
          assert.match(err.message, /deactivated/i);
          return true;
        },
      );
    });

    it('should authenticate active Author and resolve author permissions', async () => {
      const user = await harness.authenticate(TEST_USERS.author.telegramUserId);

      assert.equal(user.id, TEST_USERS.author.id);
      assert.equal(user.channelRole, 'AUTHOR');
      assert.equal(user.canPublish, false);
      assert.equal(user.canApprove, false);

      const canCreate = await harness.checkPermission(user.id, TEST_CHANNELS.production.id, 'CREATE_POST');
      assert.equal(canCreate, true);

      const canPublish = await harness.checkPermission(user.id, TEST_CHANNELS.production.id, 'PUBLISH_POST');
      assert.equal(canPublish, false);
    });

    it('should authenticate active Editor and resolve editor permissions', async () => {
      const user = await harness.authenticate(TEST_USERS.editor.telegramUserId);

      assert.equal(user.id, TEST_USERS.editor.id);
      assert.equal(user.channelRole, 'EDITOR');
      assert.equal(user.canPublish, true);
      assert.equal(user.canApprove, true);

      const canApprove = await harness.checkPermission(user.id, TEST_CHANNELS.production.id, 'APPROVE_POST');
      assert.equal(canApprove, true);
    });
  });

  describe('1.2 Draft Creation & Step-by-Step Autosave (F-08, F-10, F-11)', () => {
    it('should create initial draft record in database with status DRAFT and version 1', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      assert.ok(post.id);
      assert.equal(post.status, 'DRAFT');
      assert.equal(post.version, 1);
      assert.equal(post.channelId, TEST_CHANNELS.production.id);
      assert.equal(post.authorId, TEST_USERS.author.id);

      // Verify audit log entry was created
      const audit = harness.auditLogs.find((l) => l.entityId === post.id && l.eventType === 'post_created');
      assert.ok(audit, 'Audit log must record post_created');
      assert.equal(audit.actorId, TEST_USERS.author.id);
    });

    it('should autosave title immediately to database and increment version', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      const updated = await harness.autosaveStep(
        post.id,
        post.version,
        TEST_USERS.author.id,
        'title',
        'Breaking News: Space Mission Launched',
      );

      assert.equal(updated.title, 'Breaking News: Space Mission Launched');
      assert.equal(updated.version, 2);
      assert.equal(updated.contentJson.title, 'Breaking News: Space Mission Launched');

      // Verify durable persistence in store
      const persisted = harness.posts.get(post.id);
      assert.equal(persisted?.title, 'Breaking News: Space Mission Launched');
      assert.equal(persisted?.version, 2);
    });

    it('should autosave body field and attach media incrementally', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      // Save title (v1 -> v2)
      const v2 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Headline');
      // Save body (v2 -> v3)
      const v3 = await harness.autosaveStep(
        post.id,
        v2.version,
        TEST_USERS.author.id,
        'body',
        'Full article text description...',
      );

      assert.equal(v3.version, 3);
      assert.equal(v3.contentJson.body, 'Full article text description...');

      // Attach media (v3 -> v4)
      const media = await harness.attachMedia(post.id, v3.version, TEST_USERS.author.id, {
        telegramFileId: 'AgACAgIAAxkBAAIF123456789',
        telegramFileUniqueId: 'AQADAgATunique',
        mediaType: 'photo',
        caption: 'Rocket on launchpad',
      });

      assert.ok(media.id);
      assert.equal(media.sortOrder, 1);
      assert.equal(media.telegramFileId, 'AgACAgIAAxkBAAIF123456789');

      const persistedPost = harness.posts.get(post.id);
      assert.equal(persistedPost?.version, 4);

      // Verify zero notifications were emitted during autosaves (Rule F-40)
      assert.equal(harness.notifications.getNotifications().length, 0);
    });
  });

  describe('1.3 State Machine Transitions & Audit Logging (F-23, F-41)', () => {
    it('should transition DRAFT to PENDING_REVIEW, log audit entry, and notify editors', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const postWithTitle = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Ready for Review');

      const reviewPost = await harness.transitionState(
        post.id,
        postWithTitle.version,
        'PENDING_REVIEW',
        TEST_USERS.author.id,
      );

      assert.equal(reviewPost.status, 'PENDING_REVIEW');
      assert.equal(reviewPost.version, 3);

      // Audit log check
      const audit = harness.auditLogs.find(
        (l) => l.entityId === post.id && l.eventType === 'submitted_for_review',
      );
      assert.ok(audit, 'Audit log must record submitted_for_review');

      // Notification check
      const notif = harness.notifications.getLastNotification();
      assert.ok(notif);
      assert.equal(notif.eventType, 'submitted_for_review');
      assert.equal(notif.recipientRole, 'EDITOR');
    });

    it('should forbid illegal state transition from DRAFT to APPROVED directly', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      await assert.rejects(
        async () => {
          await harness.transitionState(post.id, post.version, 'APPROVED', TEST_USERS.editor.id);
        },
        (err: Error) => {
          assert.ok(err instanceof InvalidStateTransitionException);
          assert.match(err.message, /Invalid status transition from DRAFT to APPROVED/i);
          return true;
        },
      );

      // Verify post remained in DRAFT
      assert.equal(harness.posts.get(post.id)?.status, 'DRAFT');
    });
  });

  describe('1.4 Editorial Review Actions (F-25, F-27)', () => {
    it('should allow Editor to approve post, transition to APPROVED, and notify author', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Exclusive Report');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);

      const approved = await harness.transitionState(
        post.id,
        p2.version,
        'APPROVED',
        TEST_USERS.editor.id,
        'Looks great, approved for publishing.',
      );

      assert.equal(approved.status, 'APPROVED');

      // Review record recorded
      const review = harness.postReviews.find((r) => r.postId === post.id);
      assert.ok(review);
      assert.equal(review.action, 'APPROVE');
      assert.equal(review.reviewerId, TEST_USERS.editor.id);

      // Notification check to author
      const notifs = harness.notifications.getNotifications(TEST_USERS.author.id);
      const approveNotif = notifs.find((n) => n.eventType === 'approved');
      assert.ok(approveNotif, 'Author must receive approval notification');
    });

    it('should allow Editor to reject post, transition to REJECTED, and notify author', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.transitionState(post.id, post.version, 'PENDING_REVIEW', TEST_USERS.author.id);

      const rejected = await harness.transitionState(
        post.id,
        p1.version,
        'REJECTED',
        TEST_USERS.editor.id,
        'Topic not suitable for channel.',
      );

      assert.equal(rejected.status, 'REJECTED');
      assert.equal(rejected.version, 3);

      const notifs = harness.notifications.getNotifications(TEST_USERS.author.id);
      const rejectNotif = notifs.find((n) => n.eventType === 'rejected');
      assert.ok(rejectNotif, 'Author must receive rejection notification');
    });
  });

  describe('1.5 Publishing Queue & Idempotency Key (F-30, F-31, F-33)', () => {
    it('should enqueue publication job with unique idempotency key publish:{postId}:{version}', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Headline');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      const expectedIdempotencyKey = `publish:${post.id}:${p3.version}`;

      const job = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      assert.ok(job.id);
      assert.equal(job.postId, post.id);
      assert.equal(job.postVersion, p3.version);
      assert.equal(job.idempotencyKey, expectedIdempotencyKey);
      assert.equal(job.status, 'PENDING');
    });

    it('should enforce idempotency by returning existing job when publish triggered twice', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Headline');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      const job1 = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);
      const job2 = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Must return the exact same job ID
      assert.equal(job1.id, job2.id);
      assert.equal(harness.publicationJobs.size, 1);
    });

    it('should process publication job via worker, call Telegram publisher, and set status PUBLISHED', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(
        post.id,
        1,
        TEST_USERS.author.id,
        'title',
        'Official Statement on Mars Rover',
      );
      const p2 = await harness.autosaveStep(
        post.id,
        p1.version,
        TEST_USERS.author.id,
        'body',
        'The rover has landed successfully.',
      );
      const p3 = await harness.transitionState(post.id, p2.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p4 = await harness.transitionState(post.id, p3.version, 'APPROVED', TEST_USERS.editor.id);

      const job = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Execute worker
      await harness.executePublicationWorker(job.id);

      // Verify publisher mock was called
      const sent = harness.publisher.getSentMessages(TEST_CHANNELS.production.telegramChatId);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'text');
      assert.match(sent[0].text!, /The rover has landed successfully\./);

      // Verify post state updated to PUBLISHED
      const finalPost = harness.posts.get(post.id);
      assert.equal(finalPost?.status, 'PUBLISHED');
      assert.ok(finalPost?.publishedAt instanceof Date);

      // Verify job completed and message IDs recorded
      const updatedJob = harness.publicationJobs.get(job.id);
      assert.equal(updatedJob?.status, 'COMPLETED');
      assert.equal(updatedJob?.telegramMessageIdsJson.length, 1);
      assert.equal(updatedJob?.telegramMessageIdsJson[0], sent[0].messageId);
    });
  });
});
