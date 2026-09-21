import 'reflect-metadata';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { PostWorkflowService } from '../../src/modules/posts/post-workflow.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { DomainEventBus } from '../../src/modules/notifications/domain-event.bus';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { PostStatus, ReviewAction } from '@prisma/client';
import {
  PostConflictException,
  InvalidPostStateTransitionException,
  ValidationException,
} from '../../src/common/exceptions/domain.exceptions';

describe('PostsRepository & PostWorkflowService Unit Tests', () => {
  let postsRepository: PostsRepository;
  let workflowService: PostWorkflowService;
  let postsService: PostsService;
  let mockPrisma: any;
  let mockReviewsService: Partial<ReviewsService>;
  let mockAuditService: Partial<AuditService>;
  let eventBus: DomainEventBus;
  let mockPermissionService: Partial<PermissionService>;
  let mockLogger: any;

  const basePost = {
    id: 'post-1',
    channelId: 'chan-1',
    authorId: 'author-1',
    templateId: 'tmpl-1',
    templateVersion: 1,
    status: PostStatus.DRAFT,
    version: 1,
    contentJson: { title: 'Initial Draft' },
    metadataJson: {},
    scheduledAt: null,
    publishedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockPrisma = {
      post: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      postMedia: {
        create: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => {
        return cb(mockPrisma);
      }),
    };

    mockReviewsService = {
      createReview: jest.fn().mockResolvedValue({ id: 'rev-1' } as any),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' } as any),
    };

    eventBus = new DomainEventBus(mockLogger);

    mockPermissionService = {
      checkChannelPermission: jest.fn().mockResolvedValue(true),
      enforceChannelPermission: jest.fn().mockResolvedValue(undefined),
      checkPostEditPermission: jest.fn().mockResolvedValue(true),
      enforcePostEditPermission: jest.fn().mockResolvedValue(undefined),
    };

    postsRepository = new PostsRepository(mockPrisma as any);

    workflowService = new PostWorkflowService(
      mockPrisma as any,
      postsRepository,
      mockReviewsService as ReviewsService,
      mockAuditService as AuditService,
      eventBus,
      mockPermissionService as PermissionService,
    );

    postsService = new PostsService(
      mockPrisma as any,
      postsRepository,
      mockAuditService as AuditService,
      mockPermissionService as PermissionService,
    );
  });

  describe('Optimistic Concurrency Control (updateWithOcc)', () => {
    it('should atomically check id, version, and deletedAt is null, and increment version', async () => {
      mockPrisma.post.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.post.findUniqueOrThrow.mockResolvedValue({
        ...basePost,
        version: 2,
        contentJson: { title: 'Updated' },
      });

      const updated = await postsRepository.updateWithOcc('post-1', 1, {
        contentJson: { title: 'Updated' },
      });

      expect(mockPrisma.post.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'post-1',
          version: 1,
          deletedAt: null,
        },
        data: expect.objectContaining({
          version: { increment: 1 },
          contentJson: { title: 'Updated' },
        }),
      });
      expect(updated.version).toBe(2);
    });

    it('should throw PostConflictException with Russian message on version mismatch', async () => {
      // 0 rows updated because version was already 2
      mockPrisma.post.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        version: 2,
        deletedAt: null,
      });

      await expect(
        postsRepository.updateWithOcc('post-1', 1, { contentJson: { title: 'Stale' } }),
      ).rejects.toThrow(PostConflictException);

      await expect(
        postsRepository.updateWithOcc('post-1', 1, { contentJson: { title: 'Stale' } }),
      ).rejects.toThrow(/Публикация была изменена другим пользователем/i);
    });

    it('should throw ValidationException if post is soft-deleted', async () => {
      mockPrisma.post.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        version: 1,
        deletedAt: new Date(),
      });

      await expect(
        postsRepository.updateWithOcc('post-1', 1, { contentJson: { title: 'Update' } }),
      ).rejects.toThrow(ValidationException);
    });
  });

  describe('PostWorkflowService 10-Status State Machine', () => {
    it('should allow valid transition DRAFT -> PENDING_REVIEW and emit PostSubmittedEvent', async () => {
      mockPrisma.post.findFirst.mockResolvedValue({ ...basePost, status: PostStatus.DRAFT });
      mockPrisma.post.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.post.findUniqueOrThrow.mockResolvedValue({
        ...basePost,
        status: PostStatus.PENDING_REVIEW,
        version: 2,
      });

      const publishedEvents: any[] = [];
      eventBus.asObservable().subscribe((e) => publishedEvents.push(e));

      const transitioned = await workflowService.transition({
        postId: 'post-1',
        expectedVersion: 1,
        targetStatus: PostStatus.PENDING_REVIEW,
        actorId: 'author-1',
      });

      expect(transitioned.status).toBe(PostStatus.PENDING_REVIEW);
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'submitted_for_review', entityId: 'post-1' }),
        expect.anything(),
      );
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].eventType).toBe('post.submitted_for_review');
    });

    it('should forbid illegal transition DRAFT -> APPROVED directly', async () => {
      mockPrisma.post.findFirst.mockResolvedValue({ ...basePost, status: PostStatus.DRAFT });

      await expect(
        workflowService.transition({
          postId: 'post-1',
          expectedVersion: 1,
          targetStatus: PostStatus.APPROVED,
          actorId: 'editor-1',
        }),
      ).rejects.toThrow(InvalidPostStateTransitionException);
    });

    it('should require non-empty comment for PENDING_REVIEW -> NEEDS_REVISION', async () => {
      mockPrisma.post.findFirst.mockResolvedValue({
        ...basePost,
        status: PostStatus.PENDING_REVIEW,
      });

      // Empty comment
      await expect(
        workflowService.transition({
          postId: 'post-1',
          expectedVersion: 1,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: 'editor-1',
          comment: '',
        }),
      ).rejects.toThrow(ValidationException);

      // Whitespace comment
      await expect(
        workflowService.transition({
          postId: 'post-1',
          expectedVersion: 1,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: 'editor-1',
          comment: '   \n\t  ',
        }),
      ).rejects.toThrow(/Для возврата на доработку обязателен комментарий/);
    });

    it('should create PostReview record inside transaction for editorial review actions', async () => {
      mockPrisma.post.findFirst.mockResolvedValue({
        ...basePost,
        status: PostStatus.PENDING_REVIEW,
      });
      mockPrisma.post.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.post.findUniqueOrThrow.mockResolvedValue({
        ...basePost,
        status: PostStatus.APPROVED,
        version: 2,
      });

      await workflowService.transition({
        postId: 'post-1',
        expectedVersion: 1,
        targetStatus: PostStatus.APPROVED,
        actorId: 'editor-1',
        comment: 'Great work',
      });

      expect(mockReviewsService.createReview).toHaveBeenCalledWith(
        {
          postId: 'post-1',
          reviewerId: 'editor-1',
          action: ReviewAction.APPROVE,
          comment: 'Great work',
        },
        expect.anything(),
      );
    });

    it('should forbid any transition from terminal states (REJECTED, PUBLISHED, CANCELLED)', async () => {
      for (const terminalStatus of [PostStatus.REJECTED, PostStatus.PUBLISHED, PostStatus.CANCELLED]) {
        mockPrisma.post.findFirst.mockResolvedValue({ ...basePost, status: terminalStatus });

        await expect(
          workflowService.transition({
            postId: 'post-1',
            expectedVersion: 1,
            targetStatus: PostStatus.PUBLISHING,
            actorId: 'editor-1',
          }),
        ).rejects.toThrow(InvalidPostStateTransitionException);
      }
    });
  });

  describe('Autosave Silent Rule (F-40)', () => {
    it('should update post via OCC and record audit log without emitting any domain events', async () => {
      mockPrisma.post.findFirst.mockResolvedValue(basePost);
      mockPrisma.post.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.post.findUniqueOrThrow.mockResolvedValue({
        ...basePost,
        version: 2,
        contentJson: { title: 'Initial Draft', body: 'New autosaved body' },
      });

      const publishedEvents: any[] = [];
      eventBus.asObservable().subscribe((e) => publishedEvents.push(e));

      const updated = await postsService.autosaveStep(
        'post-1',
        1,
        'author-1',
        'body',
        'New autosaved body',
      );

      expect(updated.version).toBe(2);
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'post_updated', entityId: 'post-1' }),
      );
      // Autosave silent rule: ZERO notifications / events emitted!
      expect(publishedEvents).toHaveLength(0);
    });
  });
});
