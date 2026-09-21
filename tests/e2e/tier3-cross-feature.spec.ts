/**
 * Tier 3: Cross-Feature Combinations & Multi-Step Workflows
 * Verifies complex interactions between domain services across state lifecycles:
 * - Full editorial revision cycle (Draft -> Review -> Revision -> Edit -> Resubmit -> Approve)
 * - Scheduled publishing and schedule cancellation
 * - Partial publication resume (preventing duplicate message sends on worker retry)
 * - Soft-delete invariants (deleted posts cannot enter review or publishing)
 *
 * Authoritative Sources:
 * - tasks.md §6, §13, §19, §23, §34, §35
 * - AGENTS.md §10, §23, §24, §31
 * - PROJECT.md F-15, F-23, F-25, F-26, F-28, F-33, F-34, F-37, F-38
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestHarness,
  InvalidStateTransitionException,
  ValidationError,
} from '../harness/test-harness.ts';
import { TEST_USERS, TEST_CHANNELS, TEST_TEMPLATES } from '../fixtures/test-data.ts';

describe('Tier 3: Cross-Feature Combinations & Complex Lifecycles', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = new TestHarness();
  });

  describe('3.1 Complete Editorial Revision & Resubmission Cycle (F-23, F-26, F-28, F-25)', () => {
    it('should complete Draft -> Review -> Revision -> Edit -> Resubmit -> Approve with complete audit trail', async () => {
      // 1. Author creates draft (v1)
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      assert.equal(post.status, 'DRAFT');
      assert.equal(post.version, 1);

      // 2. Author fills in initial draft content (v1 -> v2)
      const savedPost = await harness.autosaveStep(
        post.id,
        post.version,
        TEST_USERS.author.id,
        'title',
        'Initial Draft Title',
      );
      assert.equal(savedPost.version, 2);

      // 3. Author submits for review (v2 -> v3)
      const submittedPost = await harness.transitionState(
        post.id,
        savedPost.version,
        'PENDING_REVIEW',
        TEST_USERS.author.id,
      );
      assert.equal(submittedPost.status, 'PENDING_REVIEW');
      assert.equal(submittedPost.version, 3);

      // Verify Editor was notified
      const editorNotif = harness.notifications.getLastNotification();
      assert.equal(editorNotif?.eventType, 'submitted_for_review');
      assert.equal(editorNotif?.recipientId, 'usr-editor-001');

      // 4. Editor reviews and requests changes with feedback comment (v3 -> v4)
      const revisionComment = 'Please expand the body and provide a more informative headline.';
      const revisionPost = await harness.transitionState(
        post.id,
        submittedPost.version,
        'NEEDS_REVISION',
        TEST_USERS.editor.id,
        revisionComment,
      );
      assert.equal(revisionPost.status, 'NEEDS_REVISION');
      assert.equal(revisionPost.version, 4);

      // Verify Author received notification with revision comment
      const authorNotif = harness.notifications.getLastNotification();
      assert.equal(authorNotif?.recipientId, TEST_USERS.author.id);
      assert.equal(authorNotif?.eventType, 'revision_requested');
      assert.equal(authorNotif?.details?.comment, revisionComment);

      // 5. Author updates title and body based on feedback (v4 -> v5 -> v6)
      const revisedTitlePost = await harness.autosaveStep(
        post.id,
        revisionPost.version,
        TEST_USERS.author.id,
        'title',
        'Revised Informative Headline: Major Discovery Announced',
      );
      assert.equal(revisedTitlePost.version, 5);

      const revisedBodyPost = await harness.autosaveStep(
        post.id,
        revisedTitlePost.version,
        TEST_USERS.author.id,
        'body',
        'Here is the expanded and comprehensive body text with all facts verified.',
      );
      assert.equal(revisedBodyPost.version, 6);

      // 6. Author resubmits revised post for review (v6 -> v7)
      const resubmittedPost = await harness.transitionState(
        post.id,
        revisedBodyPost.version,
        'PENDING_REVIEW',
        TEST_USERS.author.id,
      );
      assert.equal(resubmittedPost.status, 'PENDING_REVIEW');
      assert.equal(resubmittedPost.version, 7);

      // 7. Editor approves resubmitted post (v7 -> v8)
      const approvedPost = await harness.transitionState(
        post.id,
        resubmittedPost.version,
        'APPROVED',
        TEST_USERS.editor.id,
        'Headline and body look excellent. Approved.',
      );
      assert.equal(approvedPost.status, 'APPROVED');
      assert.equal(approvedPost.version, 8);

      // Verify complete chronological audit history
      const postAudits = harness.auditLogs.filter((a) => a.entityId === post.id);
      const auditEventTypes = postAudits.map((a) => a.eventType);

      assert.deepEqual(auditEventTypes, [
        'post_created',
        'post_updated',
        'submitted_for_review',
        'revision_requested',
        'post_updated',
        'post_updated',
        'submitted_for_review',
        'approved',
      ]);
    });
  });

  describe('3.2 Scheduling & Cancellation Lifecycle (F-37, F-38)', () => {
    it('should schedule approved post, then cancel schedule without publication', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );
      const p1 = await harness.autosaveStep(post.id, 1, TEST_USERS.author.id, 'title', 'Scheduled Article');
      const p2 = await harness.transitionState(post.id, p1.version, 'PENDING_REVIEW', TEST_USERS.author.id);
      const p3 = await harness.transitionState(post.id, p2.version, 'APPROVED', TEST_USERS.editor.id);

      // Schedule 2 hours in the future
      const scheduledTime = new Date(Date.now() + 2 * 3600 * 1000);
      const scheduledPost = await harness.schedulePost(post.id, p3.version, TEST_USERS.editor.id, scheduledTime);

      assert.equal(scheduledPost.status, 'SCHEDULED');
      assert.equal(scheduledPost.scheduledAt?.getTime(), scheduledTime.getTime());

      // Verify author received scheduled notification
      const schedNotif = harness.notifications.getLastNotification();
      assert.equal(schedNotif?.eventType, 'scheduled');
      assert.equal(schedNotif?.recipientId, TEST_USERS.author.id);

      // Editor cancels the scheduled publication
      const cancelledPost = await harness.cancelSchedule(post.id, scheduledPost.version, TEST_USERS.editor.id);

      assert.equal(cancelledPost.status, 'CANCELLED');

      // Attempting to publish cancelled post must fail
      await assert.rejects(
        async () => {
          await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);
        },
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionException);
          return true;
        },
      );

      // Telegram publisher was never invoked
      assert.equal(harness.publisher.getSentMessages().length, 0);
    });
  });

  describe('3.3 Partial Publication Resume (F-33, F-34, AGENTS.md §23)', () => {
    it('should resume failed multi-part publication on retry without duplicating already-sent parts', async () => {
      // Create post with media group (2 photos) and separate text
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
        'Photo Gallery With Detailed Report',
      );
      const p2 = await harness.autosaveStep(
        post.id,
        p1.version,
        TEST_USERS.author.id,
        'body',
        'Detailed long description accompanying the photos...',
      );

      // Attach 2 photos for media group
      await harness.attachMedia(post.id, p2.version, TEST_USERS.author.id, {
        telegramFileId: 'AgACAgIAAxkBAAI_Photo1',
        telegramFileUniqueId: 'AQADAgAT_P1',
        mediaType: 'photo',
        caption: 'First photo caption',
      });
      const currentPost = harness.posts.get(post.id)!;

      await harness.attachMedia(post.id, currentPost.version, TEST_USERS.author.id, {
        telegramFileId: 'AgACAgIAAxkBAAI_Photo2',
        telegramFileUniqueId: 'AQADAgAT_P2',
        mediaType: 'photo',
        caption: 'Second photo caption',
      });
      const readyPost = harness.posts.get(post.id)!;

      // Review and Approve
      const reviewPost = await harness.transitionState(
        post.id,
        readyPost.version,
        'PENDING_REVIEW',
        TEST_USERS.author.id,
      );
      const approvedPost = await harness.transitionState(
        post.id,
        reviewPost.version,
        'APPROVED',
        TEST_USERS.editor.id,
      );

      // Enqueue publish job
      const job = await harness.enqueuePublishJob(post.id, TEST_USERS.editor.id);

      // Simulate partial failure:
      // Media group call will succeed (returning IDs [1001, 1002]).
      // Subsequent text sendMessage call will fail with a transient 500 error!
      // We configure 1 transient failure on sendMessage by temporarily monkey-patching sendMessage:
      const originalSendMessage = harness.publisher.sendMessage.bind(harness.publisher);
      let sendMessageFailedOnce = false;

      harness.publisher.sendMessage = async (chatId, text, options) => {
        if (!sendMessageFailedOnce) {
          sendMessageFailedOnce = true;
          throw new Error('ETIMEDOUT: Connection lost while sending text message');
        }
        return originalSendMessage(chatId, text, options);
      };

      // Attempt 1: Media group succeeds, sendMessage fails
      await harness.executePublicationWorker(job.id);

      const jobAfterFail = harness.publicationJobs.get(job.id)!;
      assert.equal(jobAfterFail.status, 'PENDING');
      assert.equal(jobAfterFail.attemptCount, 1);
      // Verify media group message IDs were recorded despite text failure!
      assert.equal(jobAfterFail.telegramMessageIdsJson.length, 2);
      assert.deepEqual(jobAfterFail.telegramMessageIdsJson, [1001, 1002]);

      // Verify that media group was recorded once in the publisher
      const sentAfterAttempt1 = harness.publisher.getSentMessages();
      assert.equal(sentAfterAttempt1.length, 1);
      assert.equal(sentAfterAttempt1[0].type, 'media_group');

      // Attempt 2 (Retry): Worker resumes.
      // Must NOT re-send media group, but MUST send the remaining text!
      await harness.executePublicationWorker(job.id);

      const jobAfterSuccess = harness.publicationJobs.get(job.id)!;
      assert.equal(jobAfterSuccess.status, 'COMPLETED');
      assert.equal(jobAfterSuccess.telegramMessageIdsJson.length, 3); // 2 media + 1 text
      assert.equal(jobAfterSuccess.telegramMessageIdsJson[2], 1003);

      const finalPost = harness.posts.get(post.id)!;
      assert.equal(finalPost.status, 'PUBLISHED');

      // Verify publisher history: media group was sent EXACTLY once, text sent once!
      const totalSent = harness.publisher.getSentMessages();
      assert.equal(totalSent.length, 2); // 1 media group + 1 text message
      assert.equal(totalSent[0].type, 'media_group');
      assert.equal(totalSent[1].type, 'text');
    });
  });

  describe('3.4 Soft-Delete Draft Invariants (F-15, AGENTS.md §31)', () => {
    it('should refuse submission and editing for soft-deleted posts', async () => {
      const post = await harness.createDraft(
        TEST_USERS.author.id,
        TEST_CHANNELS.production.id,
        TEST_TEMPLATES.news.id,
      );

      // Soft delete
      await harness.softDeletePost(post.id, post.version, TEST_USERS.author.id);

      const current = harness.posts.get(post.id);
      assert.ok(current?.deletedAt instanceof Date);

      // Attempt to edit soft-deleted post must fail
      await assert.rejects(
        async () => {
          await harness.autosaveStep(post.id, current!.version, TEST_USERS.author.id, 'title', 'Revived Title');
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /not found or deleted/i);
          return true;
        },
      );

      // Attempt to transition soft-deleted post must fail
      await assert.rejects(
        async () => {
          await harness.transitionState(post.id, current!.version, 'PENDING_REVIEW', TEST_USERS.author.id);
        },
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /not found or deleted/i);
          return true;
        },
      );
    });
  });
});
