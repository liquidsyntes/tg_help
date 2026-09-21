import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostWorkflowService } from '../../src/modules/posts/post-workflow.service';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { DomainEventBus } from '../../src/modules/notifications/domain-event.bus';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { PostStatus, ReviewAction, SystemRole, ChannelRole } from '@prisma/client';
import {
  PostConflictException,
  ValidationException,
  PostNotFoundException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
} from '../../src/common/exceptions/domain.exceptions';
import { PostAction, ChannelPermission } from '../../src/common/enums';

interface TestResult {
  category: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const testResults: TestResult[] = [];

async function recordTest(category: string, name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    testResults.push({ category, name, passed: true, durationMs: duration });
    console.log(`  [PASS] ${name} (${duration}ms)`);
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    testResults.push({ category, name, passed: false, error: errorMsg, durationMs: duration });
    console.error(`  [FAIL] ${name} (${duration}ms)`);
    console.error(`         ${errorMsg}\n`);
  }
}

async function runM2EmpiricalChallenge() {
  console.log('================================================================================');
  console.log('EMPIRICAL CHALLENGER: Milestone 2 State Machine, OCC, and Reviews Stress Tests');
  console.log('                      Direct Live PostgreSQL & Redis Verification');
  console.log('================================================================================\n');

  // Boot NestJS application context with all modules and live connections
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const postsRepo = app.get(PostsRepository);
  const postsService = app.get(PostsService);
  const workflowService = app.get(PostWorkflowService);
  const reviewsService = app.get(ReviewsService);
  const auditService = app.get(AuditService);
  const eventBus = app.get(DomainEventBus);
  const permissionService = app.get(PermissionService);

  // Collect emitted domain events for event bus assertions
  const capturedEvents: any[] = [];
  const eventSubscription = eventBus.asObservable().subscribe((ev) => {
    capturedEvents.push(ev);
  });

  const createdPostIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdChannelIds: string[] = [];

  try {
    // --------------------------------------------------------------------------
    // Setup Test Personas in Live PostgreSQL
    // --------------------------------------------------------------------------
    console.log('0. Setting up test personas and fixtures in live PostgreSQL:');

    // Default template (e.g. news)
    const template = await prisma.postTemplate.findFirstOrThrow({
      where: { key: 'news' },
    });

    // Test Channel
    const testChannel = await prisma.channel.create({
      data: {
        telegramChatId: `-100999${Date.now().toString().slice(-7)}`,
        title: 'Empirical Test Channel',
        username: `test_chan_${Date.now()}`,
        timezone: 'Europe/Kyiv',
        publicationMode: 'DIRECT',
        isActive: true,
      },
    });
    createdChannelIds.push(testChannel.id);

    // Test Author (systemRole: USER, channel: AUTHOR)
    const testAuthor = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now()),
        username: `author_${Date.now()}`,
        firstName: 'Test',
        lastName: 'Author',
        systemRole: SystemRole.USER,
        isActive: true,
        channelMembers: {
          create: {
            channelId: testChannel.id,
            role: ChannelRole.AUTHOR,
            canApprove: false,
            canPublish: false,
          },
        },
      },
    });
    createdUserIds.push(testAuthor.id);

    // Test Editor (systemRole: USER, channel: EDITOR with canApprove & canPublish)
    const testEditor = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now() + 1),
        username: `editor_${Date.now()}`,
        firstName: 'Test',
        lastName: 'Editor',
        systemRole: SystemRole.USER,
        isActive: true,
        channelMembers: {
          create: {
            channelId: testChannel.id,
            role: ChannelRole.EDITOR,
            canApprove: true,
            canPublish: true,
          },
        },
      },
    });
    createdUserIds.push(testEditor.id);

    // Test Viewer (systemRole: USER, channel: VIEWER without write permissions)
    const testViewer = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now() + 2),
        username: `viewer_${Date.now()}`,
        firstName: 'Test',
        lastName: 'Viewer',
        systemRole: SystemRole.USER,
        isActive: true,
        channelMembers: {
          create: {
            channelId: testChannel.id,
            role: ChannelRole.VIEWER,
            canApprove: false,
            canPublish: false,
          },
        },
      },
    });
    createdUserIds.push(testViewer.id);

    console.log(`  Initialized Channel (${testChannel.id}), Author (${testAuthor.id}), Editor (${testEditor.id})\n`);

    // Helper to create a draft post
    async function createTestPost(initialStatus: PostStatus = PostStatus.DRAFT, title = 'Challenge Test Post') {
      const post = await prisma.post.create({
        data: {
          channelId: testChannel.id,
          authorId: testAuthor.id,
          templateId: template.id,
          templateVersion: 1,
          status: initialStatus,
          version: 1,
          contentJson: { title, body: 'Initial test body' },
          metadataJson: { rubric: 'Test' },
        },
      });
      createdPostIds.push(post.id);
      return post;
    }

    // ==========================================================================
    // 1. CONCURRENCY STRESS (OCC)
    // ==========================================================================
    console.log('1. STRESS SUITE: Concurrency Stress (OCC)');

    await recordTest('OCC Concurrency', 'Simulate two concurrent updates on same post with initial version 1: exactly one succeeds (v2), second receives PostConflictException (DB remains v2)', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'OCC Post Initial');
      if (post.version !== 1) throw new Error(`Expected initial version 1, got ${post.version}`);

      // Fire two concurrent updates targeting version 1
      const update1Promise = postsRepo.updateWithOcc(post.id, 1, {
        contentJson: { title: 'Update 1 by Worker A' },
      });
      const update2Promise = postsRepo.updateWithOcc(post.id, 1, {
        contentJson: { title: 'Update 2 by Worker B' },
      });

      const settled = await Promise.allSettled([update1Promise, update2Promise]);

      const fulfilled = settled.filter((s): s is PromiseFulfilledResult<any> => s.status === 'fulfilled');
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');

      if (fulfilled.length !== 1) {
        throw new Error(`Expected exactly 1 fulfilled promise, got ${fulfilled.length}`);
      }
      if (rejected.length !== 1) {
        throw new Error(`Expected exactly 1 rejected promise, got ${rejected.length}`);
      }

      // Check successful update version
      const winner = fulfilled[0]!.value;
      if (winner.version !== 2) {
        throw new Error(`Expected winner version to be 2, got ${winner.version}`);
      }

      // Check rejected error type and Russian prefix
      const failureReason = rejected[0]!.reason;
      if (!(failureReason instanceof PostConflictException)) {
        throw new Error(`Expected PostConflictException, got ${failureReason?.constructor?.name}: ${failureReason}`);
      }
      if (!failureReason.message.includes('Публикация была изменена другим пользователем')) {
        throw new Error(`Expected Russian OCC conflict prefix, got: "${failureReason.message}"`);
      }

      // Inspect live PostgreSQL directly
      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 2) {
        throw new Error(`Expected live DB post version to be 2, got ${dbPost.version}`);
      }
      if (dbPost.deletedAt !== null) {
        throw new Error('Post must not be deleted');
      }
    });

    await recordTest('OCC Concurrency', 'High-burst race condition: 10 concurrent updates targeting version 1 (exactly 1 succeeds, 9 fail with PostConflictException, DB version=2)', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Burst Post Initial');

      const burstPromises = Array.from({ length: 10 }, (_, i) =>
        postsRepo.updateWithOcc(post.id, 1, {
          contentJson: { title: `Burst Attempt ${i}` },
        }),
      );

      const burstResults = await Promise.allSettled(burstPromises);
      const successes = burstResults.filter((r) => r.status === 'fulfilled');
      const failures = burstResults.filter((r) => r.status === 'rejected');

      if (successes.length !== 1) {
        throw new Error(`Expected exactly 1 success in 10-way burst, got ${successes.length}`);
      }
      if (failures.length !== 9) {
        throw new Error(`Expected exactly 9 failures in 10-way burst, got ${failures.length}`);
      }

      for (const fail of failures) {
        const err = (fail as PromiseRejectedResult).reason;
        if (!(err instanceof PostConflictException)) {
          throw new Error(`All failures in OCC race must be PostConflictException, got: ${err}`);
        }
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 2) {
        throw new Error(`Expected live DB post version to remain 2, got ${dbPost.version}`);
      }
    });

    await recordTest('OCC Concurrency', 'Retry after OCC conflict: subsequent update with correct version 2 succeeds and increments version to 3', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Retry Post');
      // Bump to v2
      await postsRepo.updateWithOcc(post.id, 1, { contentJson: { title: 'First Bump' } });

      // Stale attempt with v1 fails
      let caught = false;
      try {
        await postsRepo.updateWithOcc(post.id, 1, { contentJson: { title: 'Stale Bump' } });
      } catch (e) {
        if (e instanceof PostConflictException) caught = true;
      }
      if (!caught) throw new Error('Expected PostConflictException on stale update');

      // Retry with v2 succeeds
      const retried = await postsRepo.updateWithOcc(post.id, 2, { contentJson: { title: 'Valid Bump' } });
      if (retried.version !== 3) {
        throw new Error(`Expected version 3 after retry, got ${retried.version}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 3) {
        throw new Error(`Expected live DB version 3, got ${dbPost.version}`);
      }
    });

    await recordTest('OCC Concurrency', 'Concurrent autosave steps (PostsService.autosaveStep): 2 simultaneous autosaves with expectedVersion 1 (1 succeeds, 1 PostConflictException)', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Autosave Post');

      const auto1 = postsService.autosaveStep(post.id, 1, testAuthor.id, 'title', 'Concurrent Title A');
      const auto2 = postsService.autosaveStep(post.id, 1, testAuthor.id, 'body', 'Concurrent Body B');

      const results = await Promise.allSettled([auto1, auto2]);
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      if (successes.length !== 1 || failures.length !== 1) {
        throw new Error(`Expected 1 success and 1 failure in autosave race, got ${successes.length} / ${failures.length}`);
      }

      const err = (failures[0] as PromiseRejectedResult).reason;
      if (!(err instanceof PostConflictException)) {
        throw new Error(`Expected PostConflictException in autosave race, got: ${err}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 2) {
        throw new Error(`Expected DB version to be 2, got ${dbPost.version}`);
      }
    });

    await recordTest('OCC Concurrency', 'Concurrent workflow transitions (PostWorkflowService.transition): Editor A approves vs Editor B rejects simultaneously on version 1', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Transition Race Post');

      const transA = workflowService.transition({
        postId: post.id,
        expectedVersion: 1,
        targetStatus: PostStatus.APPROVED,
        actorId: testEditor.id,
      });

      const transB = workflowService.transition({
        postId: post.id,
        expectedVersion: 1,
        targetStatus: PostStatus.REJECTED,
        actorId: testEditor.id,
      });

      const settled = await Promise.allSettled([transA, transB]);
      const succ = settled.filter((r) => r.status === 'fulfilled');
      const fail = settled.filter((r) => r.status === 'rejected');

      if (succ.length !== 1 || fail.length !== 1) {
        throw new Error(`Expected 1 transition to succeed and 1 to fail, got ${succ.length} / ${fail.length}`);
      }

      const failErr = (fail[0] as PromiseRejectedResult).reason;
      if (!(failErr instanceof PostConflictException)) {
        throw new Error(`Expected PostConflictException in transition race, got: ${failErr}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 2) {
        throw new Error(`Expected DB version 2, got ${dbPost.version}`);
      }
      if (dbPost.status !== PostStatus.APPROVED && dbPost.status !== PostStatus.REJECTED) {
        throw new Error(`Post status must be either APPROVED or REJECTED, got: ${dbPost.status}`);
      }
    });

    // ==========================================================================
    // 2. REVIEW COMMENT INVARIANT
    // ==========================================================================
    console.log('\n2. STRESS SUITE: Review Comment Invariant (NEEDS_REVISION)');

    await recordTest('Review Comment Invariant', 'Attempt transition to NEEDS_REVISION with empty string comment: rejected, status remains PENDING_REVIEW, version remains 1', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Review Comment Post 1');

      let rejectedError: any = null;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: testEditor.id,
          comment: '',
        });
      } catch (err) {
        rejectedError = err;
      }

      if (!rejectedError) {
        throw new Error('Expected transition with empty comment to be rejected, but it succeeded');
      }
      if (!(rejectedError instanceof ValidationException)) {
        throw new Error(`Expected ValidationException, got ${rejectedError?.constructor?.name}: ${rejectedError}`);
      }
      if (!rejectedError.message.includes('Для возврата на доработку обязателен комментарий')) {
        throw new Error(`Unexpected error message: "${rejectedError.message}"`);
      }

      // Live PostgreSQL assertions
      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.PENDING_REVIEW) {
        throw new Error(`Expected status to remain PENDING_REVIEW, but was: ${dbPost.status}`);
      }
      if (dbPost.version !== 1) {
        throw new Error(`Expected version to remain 1, but was: ${dbPost.version}`);
      }

      const reviews = await prisma.postReview.findMany({ where: { postId: post.id } });
      if (reviews.length !== 0) {
        throw new Error(`Expected 0 reviews in DB, found: ${reviews.length}`);
      }
    });

    await recordTest('Review Comment Invariant', 'Attempt transition to NEEDS_REVISION with spaces-only comment ("   "): rejected, status remains PENDING_REVIEW', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Review Comment Post 2');

      let rejectedError: any = null;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: testEditor.id,
          comment: '     ',
        });
      } catch (err) {
        rejectedError = err;
      }

      if (!(rejectedError instanceof ValidationException)) {
        throw new Error(`Expected ValidationException, got: ${rejectedError}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.PENDING_REVIEW || dbPost.version !== 1) {
        throw new Error(`Expected PENDING_REVIEW v1, got ${dbPost.status} v${dbPost.version}`);
      }
    });

    await recordTest('Review Comment Invariant', 'Attempt transition to NEEDS_REVISION with complex whitespace ("\\n\\t  \\r\\n  "): rejected, DB unmodified', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Review Comment Post 3');

      let rejectedError: any = null;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: testEditor.id,
          comment: '\n\t  \r\n \t  ',
        });
      } catch (err) {
        rejectedError = err;
      }

      if (!(rejectedError instanceof ValidationException)) {
        throw new Error(`Expected ValidationException, got: ${rejectedError}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.PENDING_REVIEW || dbPost.version !== 1) {
        throw new Error(`Expected PENDING_REVIEW v1, got ${dbPost.status} v${dbPost.version}`);
      }
    });

    await recordTest('Review Comment Invariant', 'Direct call to ReviewsService.createReview with action REQUEST_REVISION and empty/whitespace comment: rejected', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Review Direct Post');

      let rejected = false;
      try {
        await reviewsService.createReview({
          postId: post.id,
          reviewerId: testEditor.id,
          action: ReviewAction.REQUEST_REVISION,
          comment: '   \n  ',
        });
      } catch (err) {
        if (err instanceof ValidationException) rejected = true;
      }

      if (!rejected) {
        throw new Error('ReviewsService.createReview must reject whitespace comment for REQUEST_REVISION');
      }

      const reviews = await prisma.postReview.findMany({ where: { postId: post.id } });
      if (reviews.length !== 0) {
        throw new Error('Expected no review record to be persisted in DB');
      }
    });

    await recordTest('Review Comment Invariant', 'Transition to NEEDS_REVISION with valid non-empty comment: succeeds, status=NEEDS_REVISION, version=2, review record saved', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Valid Review Comment Post');
      const validComment = '  Пожалуйста, замените изображение в превью и уточните дату события.  ';

      const transitioned = await workflowService.transition({
        postId: post.id,
        expectedVersion: 1,
        targetStatus: PostStatus.NEEDS_REVISION,
        actorId: testEditor.id,
        comment: validComment,
      });

      if (transitioned.status !== PostStatus.NEEDS_REVISION) {
        throw new Error(`Expected status NEEDS_REVISION, got ${transitioned.status}`);
      }
      if (transitioned.version !== 2) {
        throw new Error(`Expected version 2, got ${transitioned.version}`);
      }

      // Verify in live PostgreSQL
      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.NEEDS_REVISION || dbPost.version !== 2) {
        throw new Error(`Live DB post mismatch: status=${dbPost.status}, version=${dbPost.version}`);
      }

      // Check review record in DB
      const dbReviews = await prisma.postReview.findMany({ where: { postId: post.id } });
      if (dbReviews.length !== 1) {
        throw new Error(`Expected exactly 1 review record in DB, got ${dbReviews.length}`);
      }
      const rev = dbReviews[0]!;
      if (rev.action !== ReviewAction.REQUEST_REVISION) {
        throw new Error(`Expected action REQUEST_REVISION, got ${rev.action}`);
      }
      if (rev.comment !== validComment.trim()) {
        throw new Error(`Expected trimmed comment "${validComment.trim()}", got "${rev.comment}"`);
      }
      if (rev.reviewerId !== testEditor.id) {
        throw new Error(`Expected reviewerId ${testEditor.id}, got ${rev.reviewerId}`);
      }

      // Check author resubmission from NEEDS_REVISION back to PENDING_REVIEW
      const resubmitted = await workflowService.transition({
        postId: post.id,
        expectedVersion: 2,
        targetStatus: PostStatus.PENDING_REVIEW,
        actorId: testAuthor.id,
      });
      if (resubmitted.status !== PostStatus.PENDING_REVIEW || resubmitted.version !== 3) {
        throw new Error(`Resubmission failed: status=${resubmitted.status}, version=${resubmitted.version}`);
      }
    });

    // ==========================================================================
    // 3. SOFT DELETE INVARIANT
    // ==========================================================================
    console.log('\n3. STRESS SUITE: Soft Delete Invariant');

    await recordTest('Soft Delete Invariant', 'Soft-delete a post: deletedAt set, version incremented, excluded from active queries', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Post to Soft-Delete');

      const deleted = await postsService.softDeletePost(post.id, 1, testAuthor.id);
      if (deleted.deletedAt === null) {
        throw new Error('Expected deletedAt to be set');
      }
      if (deleted.version !== 2) {
        throw new Error(`Expected version to be 2 after soft delete, got ${deleted.version}`);
      }

      // Live PostgreSQL assertions
      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.deletedAt === null) {
        throw new Error('Live DB post must have deletedAt not null');
      }
      if (dbPost.version !== 2) {
        throw new Error(`Live DB version must be 2, got ${dbPost.version}`);
      }

      // findById without includeDeleted returns null
      const foundDefault = await postsRepo.findById(post.id);
      if (foundDefault !== null) {
        throw new Error('findById without includeDeleted must return null for soft-deleted post');
      }

      // findById with includeDeleted=true returns post
      const foundInclude = await postsRepo.findById(post.id, true);
      if (!foundInclude || foundInclude.deletedAt === null) {
        throw new Error('findById with includeDeleted=true must return post');
      }

      // getPost throws PostNotFoundException
      let getPostThrown = false;
      try {
        await postsService.getPost(post.id);
      } catch (e) {
        if (e instanceof PostNotFoundException) getPostThrown = true;
      }
      if (!getPostThrown) {
        throw new Error('postsService.getPost must throw PostNotFoundException for soft-deleted post');
      }
    });

    await recordTest('Soft Delete Invariant', 'Attempt to update soft-deleted post via PostsService.autosaveStep: rejected with PostNotFoundException, DB untouched', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Post for Deleted Autosave');
      await postsService.softDeletePost(post.id, 1, testAuthor.id);

      let caught = false;
      try {
        await postsService.autosaveStep(post.id, 2, testAuthor.id, 'title', 'Hacked Title');
      } catch (e) {
        if (e instanceof PostNotFoundException) caught = true;
      }

      if (!caught) {
        throw new Error('autosaveStep must throw PostNotFoundException on soft-deleted post');
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      const content = dbPost.contentJson as Record<string, unknown>;
      if (content.title === 'Hacked Title') {
        throw new Error('Content of soft-deleted post must NOT be updated');
      }
      if (dbPost.version !== 2) {
        throw new Error(`DB version must remain 2, got ${dbPost.version}`);
      }
    });

    await recordTest('Soft Delete Invariant', 'Attempt to update soft-deleted post directly via PostsRepository.updateWithOcc: rejected with ValidationException', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Post for Direct OCC Deleted');
      await postsService.softDeletePost(post.id, 1, testAuthor.id);

      let caught = false;
      try {
        await postsRepo.updateWithOcc(post.id, 2, { contentJson: { title: 'Direct Hacked' } });
      } catch (e) {
        if (e instanceof ValidationException) caught = true;
      }

      if (!caught) {
        throw new Error('updateWithOcc must throw ValidationException on soft-deleted post');
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.version !== 2) {
        throw new Error(`Version must remain 2, got ${dbPost.version}`);
      }
    });

    await recordTest('Soft Delete Invariant', 'Attempt to transition soft-deleted post via PostWorkflowService.transition: rejected with ValidationException', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Post for Deleted Transition');
      await postsService.softDeletePost(post.id, 1, testAuthor.id);

      let caught = false;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 2,
          targetStatus: PostStatus.PENDING_REVIEW,
          actorId: testAuthor.id,
        });
      } catch (e) {
        if (e instanceof ValidationException) caught = true;
      }

      if (!caught) {
        throw new Error('transition must throw ValidationException on soft-deleted post');
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.DRAFT) {
        throw new Error(`Status must remain DRAFT, got ${dbPost.status}`);
      }
      if (dbPost.version !== 2) {
        throw new Error(`Version must remain 2, got ${dbPost.version}`);
      }
    });

    await recordTest('Soft Delete Invariant', 'Channel queries automatically exclude soft-deleted posts', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Channel Query Excluded Post');
      await postsService.softDeletePost(post.id, 1, testAuthor.id);

      const channelPosts = await postsRepo.findByChannel(testChannel.id);
      if (channelPosts.some((p) => p.id === post.id)) {
        throw new Error('findByChannel must NOT contain soft-deleted post');
      }

      const authorPosts = await postsRepo.findByAuthor(testAuthor.id);
      if (authorPosts.some((p) => p.id === post.id)) {
        throw new Error('findByAuthor must NOT contain soft-deleted post');
      }

      const pendingPosts = await postsRepo.findPendingReview(testChannel.id);
      if (pendingPosts.some((p) => p.id === post.id)) {
        throw new Error('findPendingReview must NOT contain soft-deleted post');
      }
    });

    // ==========================================================================
    // 4. TRANSACTION ATOMICITY
    // ==========================================================================
    console.log('\n4. STRESS SUITE: Transaction Atomicity');

    await recordTest('Transaction Atomicity', 'Audit log write failure during state transition rolls back status and version completely in PostgreSQL', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Atomicity Post - Audit Failure');
      const initialUpdatedAt = post.updatedAt;

      // Count pre-existing audit logs and reviews
      const initialAuditCount = await prisma.auditLog.count({ where: { entityId: post.id } });
      const initialReviewCount = await prisma.postReview.count({ where: { postId: post.id } });
      const preEventCount = capturedEvents.length;

      // Temporarily monkey-patch auditService.record to simulate database failure on audit write
      const originalRecord = auditService.record.bind(auditService);
      (auditService as any).record = async () => {
        throw new Error('SIMULATED_AUDIT_LOG_WRITE_FAILURE');
      };

      let caughtError: any = null;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.APPROVED,
          actorId: testEditor.id,
          comment: 'Approved before audit failure',
        });
      } catch (err) {
        caughtError = err;
      } finally {
        // Restore original method
        (auditService as any).record = originalRecord;
      }

      if (!caughtError) {
        throw new Error('Expected transaction to fail when audit write throws');
      }
      if (caughtError.message !== 'SIMULATED_AUDIT_LOG_WRITE_FAILURE') {
        throw new Error(`Unexpected error thrown: ${caughtError.message}`);
      }

      // CRUCIAL: Inspect live PostgreSQL directly
      const postInDb = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (postInDb.status !== PostStatus.PENDING_REVIEW) {
        throw new Error(`ATOMICITY VIOLATION: Post status was not rolled back! Found: ${postInDb.status}, expected: PENDING_REVIEW`);
      }
      if (postInDb.version !== 1) {
        throw new Error(`ATOMICITY VIOLATION: Post version was not rolled back! Found: ${postInDb.version}, expected: 1`);
      }

      // Verify no review record was committed
      const auditCountAfter = await prisma.auditLog.count({ where: { entityId: post.id } });
      const reviewCountAfter = await prisma.postReview.count({ where: { postId: post.id } });

      if (reviewCountAfter !== initialReviewCount) {
        throw new Error(`ATOMICITY VIOLATION: Review record was committed despite rollback! Reviews: ${reviewCountAfter}`);
      }
      if (auditCountAfter !== initialAuditCount) {
        throw new Error(`ATOMICITY VIOLATION: Audit record was committed despite rollback! Audits: ${auditCountAfter}`);
      }

      // Verify NO domain events were dispatched
      if (capturedEvents.length !== preEventCount) {
        throw new Error(`ATOMICITY VIOLATION: Domain events were emitted for aborted transaction! Emitted: ${capturedEvents.length - preEventCount}`);
      }
    });

    await recordTest('Transaction Atomicity', 'Review creation failure during state transition rolls back status and version completely in PostgreSQL', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Atomicity Post - Review Failure');

      const initialAuditCount = await prisma.auditLog.count({ where: { entityId: post.id } });
      const initialReviewCount = await prisma.postReview.count({ where: { postId: post.id } });
      const preEventCount = capturedEvents.length;

      // Temporarily monkey-patch reviewsService.createReview to simulate failure
      const originalCreateReview = reviewsService.createReview.bind(reviewsService);
      (reviewsService as any).createReview = async () => {
        throw new Error('SIMULATED_REVIEW_INSERTION_FAILURE');
      };

      let caughtError: any = null;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.APPROVED,
          actorId: testEditor.id,
          comment: 'Approved before review failure',
        });
      } catch (err) {
        caughtError = err;
      } finally {
        (reviewsService as any).createReview = originalCreateReview;
      }

      if (!caughtError || caughtError.message !== 'SIMULATED_REVIEW_INSERTION_FAILURE') {
        throw new Error(`Expected SIMULATED_REVIEW_INSERTION_FAILURE, got: ${caughtError}`);
      }

      // Direct live DB assertions
      const postInDb = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (postInDb.status !== PostStatus.PENDING_REVIEW) {
        throw new Error(`ATOMICITY VIOLATION: Status was ${postInDb.status}, expected PENDING_REVIEW`);
      }
      if (postInDb.version !== 1) {
        throw new Error(`ATOMICITY VIOLATION: Version was ${postInDb.version}, expected 1`);
      }

      const reviewCountAfter = await prisma.postReview.count({ where: { postId: post.id } });
      const auditCountAfter = await prisma.auditLog.count({ where: { entityId: post.id } });

      if (reviewCountAfter !== initialReviewCount) {
        throw new Error(`ATOMICITY VIOLATION: Review count changed from ${initialReviewCount} to ${reviewCountAfter}`);
      }
      if (auditCountAfter !== initialAuditCount) {
        throw new Error(`ATOMICITY VIOLATION: Audit count changed from ${initialAuditCount} to ${auditCountAfter}`);
      }
      if (capturedEvents.length !== preEventCount) {
        throw new Error('Domain event emitted despite review failure rollback');
      }
    });

    await recordTest('Transaction Atomicity', 'Successful state transition atomically commits status update, review record, and audit log, then dispatches domain event', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Atomicity Post - Clean Success');
      const preEventCount = capturedEvents.length;

      const transitioned = await workflowService.transition({
        postId: post.id,
        expectedVersion: 1,
        targetStatus: PostStatus.APPROVED,
        actorId: testEditor.id,
        comment: 'Clean approval test',
      });

      if (transitioned.status !== PostStatus.APPROVED || transitioned.version !== 2) {
        throw new Error(`Unexpected transition result: ${transitioned.status} v${transitioned.version}`);
      }

      // Check PostgreSQL
      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.APPROVED || dbPost.version !== 2) {
        throw new Error(`DB post mismatch: ${dbPost.status} v${dbPost.version}`);
      }

      const reviews = await prisma.postReview.findMany({ where: { postId: post.id } });
      if (reviews.length !== 1 || reviews[0]!.action !== ReviewAction.APPROVE) {
        throw new Error('Expected 1 APPROVE review in DB');
      }

      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'post', entityId: post.id, action: 'approved' },
      });
      if (audits.length !== 1) {
        throw new Error('Expected 1 approved audit log entry');
      }

      // Verify post-commit domain event was emitted
      if (capturedEvents.length !== preEventCount + 1) {
        throw new Error(`Expected 1 event emitted, got ${capturedEvents.length - preEventCount}`);
      }
      const lastEvent = capturedEvents[capturedEvents.length - 1]!;
      if (lastEvent.eventType !== 'post.approved') {
        throw new Error(`Expected post.approved event, got ${lastEvent.eventType}`);
      }
    });

    // ==========================================================================
    // 5. ADVERSARIAL EDGE CASES & INVARIANTS
    // ==========================================================================
    console.log('\n5. STRESS SUITE: Adversarial Invariants & Edge Cases');

    await recordTest('Adversarial Invariants', 'State machine rejects illegal transition DRAFT -> APPROVED directly (InvalidPostStateTransitionException)', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Illegal Transition Draft->Approved');

      let caught = false;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.APPROVED,
          actorId: testEditor.id,
        });
      } catch (e) {
        if (e instanceof InvalidPostStateTransitionException) caught = true;
      }

      if (!caught) throw new Error('Expected InvalidPostStateTransitionException on DRAFT -> APPROVED');

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.DRAFT || dbPost.version !== 1) {
        throw new Error('DB post was altered after illegal transition attempt');
      }
    });

    await recordTest('Adversarial Invariants', 'State machine rejects illegal transitions from terminal states (REJECTED, PUBLISHED, CANCELLED)', async () => {
      for (const terminalStatus of [PostStatus.REJECTED, PostStatus.PUBLISHED, PostStatus.CANCELLED]) {
        const post = await createTestPost(terminalStatus, `Terminal Post ${terminalStatus}`);

        for (const target of [PostStatus.DRAFT, PostStatus.PENDING_REVIEW, PostStatus.APPROVED, PostStatus.PUBLISHING]) {
          let caught = false;
          try {
            await workflowService.transition({
              postId: post.id,
              expectedVersion: 1,
              targetStatus: target,
              actorId: testEditor.id,
            });
          } catch (e) {
            if (e instanceof InvalidPostStateTransitionException) caught = true;
          }
          if (!caught) {
            throw new Error(`Expected InvalidPostStateTransitionException transitioning ${terminalStatus} -> ${target}`);
          }
        }
      }
    });

    await recordTest('Adversarial Invariants', 'RBAC invariant: Author without APPROVE_POST permission cannot approve own draft (PermissionDeniedException)', async () => {
      const post = await createTestPost(PostStatus.PENDING_REVIEW, 'Author Self-Approve Attack');

      let caught = false;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.APPROVED,
          actorId: testAuthor.id, // Author has canApprove=false
        });
      } catch (e) {
        if (e instanceof PermissionDeniedException) caught = true;
      }

      if (!caught) {
        throw new Error('Author must be forbidden from approving post without APPROVE_POST permission');
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.PENDING_REVIEW) {
        throw new Error('Post status must remain PENDING_REVIEW after unauthorized approve attempt');
      }
    });

    await recordTest('Adversarial Invariants', 'RBAC invariant: Viewer role cannot create drafts (PermissionDeniedException)', async () => {
      let caught = false;
      try {
        await postsService.createDraft({
          channelId: testChannel.id,
          authorId: testViewer.id,
          templateId: template.id,
        });
      } catch (e) {
        if (e instanceof PermissionDeniedException) caught = true;
      }

      if (!caught) {
        throw new Error('Viewer must be forbidden from creating drafts');
      }
    });

    await recordTest('Adversarial Invariants', 'Scheduling invariant: Transition to SCHEDULED with past date is rejected (ValidationException)', async () => {
      const post = await createTestPost(PostStatus.APPROVED, 'Schedule Past Date Post');

      let caught = false;
      try {
        await workflowService.transition({
          postId: post.id,
          expectedVersion: 1,
          targetStatus: PostStatus.SCHEDULED,
          actorId: testEditor.id,
          scheduledAt: new Date(Date.now() - 3600000), // 1 hour in the past
        });
      } catch (e) {
        if (e instanceof ValidationException) caught = true;
      }

      if (!caught) {
        throw new Error('Scheduling in the past must throw ValidationException');
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.APPROVED) {
        throw new Error('Post status must remain APPROVED after past schedule rejection');
      }
    });

    await recordTest('Adversarial Invariants', 'Scheduling invariant: Transition to SCHEDULED with future date succeeds, sets scheduledAt, version=2', async () => {
      const post = await createTestPost(PostStatus.APPROVED, 'Schedule Future Date Post');
      const futureDate = new Date(Date.now() + 7200000); // 2 hours in future

      const scheduled = await workflowService.transition({
        postId: post.id,
        expectedVersion: 1,
        targetStatus: PostStatus.SCHEDULED,
        actorId: testEditor.id,
        scheduledAt: futureDate,
      });

      if (scheduled.status !== PostStatus.SCHEDULED || scheduled.version !== 2) {
        throw new Error(`Expected SCHEDULED v2, got ${scheduled.status} v${scheduled.version}`);
      }

      const dbPost = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      if (dbPost.status !== PostStatus.SCHEDULED) {
        throw new Error(`DB status mismatch: ${dbPost.status}`);
      }
      if (!dbPost.scheduledAt) {
        throw new Error('scheduledAt must be set in DB');
      }

      // Cancel schedule: SCHEDULED -> CANCELLED
      const cancelled = await workflowService.transition({
        postId: post.id,
        expectedVersion: 2,
        targetStatus: PostStatus.CANCELLED,
        actorId: testEditor.id,
      });
      if (cancelled.status !== PostStatus.CANCELLED || cancelled.version !== 3) {
        throw new Error(`Expected CANCELLED v3, got ${cancelled.status} v${cancelled.version}`);
      }
    });

    await recordTest('Adversarial Invariants', 'Autosave Silent Rule (F-40): Multiple autosave steps update DB and audit logs with ZERO emitted domain events', async () => {
      const post = await createTestPost(PostStatus.DRAFT, 'Autosave Silent Rule Post');
      const eventCountBefore = capturedEvents.length;

      const step1 = await postsService.autosaveStep(post.id, 1, testAuthor.id, 'title', 'Silent Step 1');
      if (step1.version !== 2) throw new Error('Expected version 2 after step 1');

      const step2 = await postsService.autosaveStep(post.id, 2, testAuthor.id, 'body', 'Silent Step 2');
      if (step2.version !== 3) throw new Error('Expected version 3 after step 2');

      const step3 = await postsService.autosaveStep(post.id, 3, testAuthor.id, 'tags', ['news', 'tghelp']);
      if (step3.version !== 4) throw new Error('Expected version 4 after step 3');

      // Verify ZERO new domain events were emitted!
      const newEvents = capturedEvents.length - eventCountBefore;
      if (newEvents !== 0) {
        throw new Error(`AUTOSAVE SILENT RULE VIOLATED: ${newEvents} domain events emitted during autosave!`);
      }

      // Verify audit logs were recorded
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'post', entityId: post.id, action: 'post_updated' },
      });
      if (audits.length !== 3) {
        throw new Error(`Expected 3 post_updated audit logs, got ${audits.length}`);
      }
    });

  } finally {
    // Teardown and Cleanup
    console.log('\nTeardown: Cleaning up test fixtures from live PostgreSQL...');
    try {
      if (createdPostIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { entityId: { in: createdPostIds } } });
        await prisma.postReview.deleteMany({ where: { postId: { in: createdPostIds } } });
        await prisma.postMedia.deleteMany({ where: { postId: { in: createdPostIds } } });
        await prisma.publicationJob.deleteMany({ where: { postId: { in: createdPostIds } } });
        await prisma.post.deleteMany({ where: { id: { in: createdPostIds } } });
      }
      if (createdUserIds.length > 0) {
        await prisma.channelMember.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      if (createdChannelIds.length > 0) {
        await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr);
    }

    eventSubscription.unsubscribe();
    await app.close();
  }

  // Summary
  console.log('\n================================================================================');
  console.log('EMPIRICAL CHALLENGER TEST RESULTS SUMMARY');
  console.log('================================================================================');
  const total = testResults.length;
  const passed = testResults.filter((t) => t.passed).length;
  const failed = testResults.filter((t) => !t.passed).length;

  console.log(`Total Stress Tests Run: ${total}`);
  console.log(`Passed:                 ${passed}`);
  console.log(`Failed:                 ${failed}`);

  if (failed > 0) {
    console.log('\nFAILED TESTS:');
    for (const f of testResults.filter((t) => !t.passed)) {
      console.log(`- [${f.category}] ${f.name}`);
      console.log(`  Error: ${f.error}`);
    }
  }
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runM2EmpiricalChallenge().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
