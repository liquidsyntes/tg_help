import 'reflect-metadata';
import { PostStatus, PublicationJobStatus } from '@prisma/client';
import { SchedulingService } from '../../src/modules/scheduling/scheduling.service';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
} from '../../src/common/exceptions/domain.exceptions';
import { JOB_NAMES } from '../../src/common/constants/queue-names';

describe('SchedulingService Unit Tests', () => {
  let service: SchedulingService;
  let mockPrisma: any;
  let mockPostWorkflow: any;
  let mockPreflight: any;
  let mockPermission: any;
  let mockQueue: any;

  const mockChannel = {
    id: 'chan-1',
    telegramChatId: '-1001234567890',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const mockApprovedPost = {
    id: 'post-1',
    channelId: 'chan-1',
    authorId: 'user-author',
    templateId: 'tmpl-news',
    status: PostStatus.APPROVED,
    version: 3,
    channel: mockChannel,
    deletedAt: null,
  };

  beforeEach(() => {
    mockPrisma = {
      post: {
        findUnique: jest.fn().mockResolvedValue(mockApprovedPost),
      },
      publicationJob: {
        create: jest.fn().mockImplementation((args) => ({
          id: 'pub-job-1',
          ...args.data,
        })),
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation((args) => ({
          id: args.where.id,
          ...args.data,
        })),
      },
    };

    mockPostWorkflow = {
      transition: jest.fn().mockImplementation((cmd) => ({
        ...mockApprovedPost,
        status: cmd.targetStatus,
        version: cmd.expectedVersion + 1,
        scheduledAt: cmd.scheduledAt,
      })),
    };

    mockPreflight = {
      validateStage1: jest.fn().mockResolvedValue({ isValid: true }),
    };

    mockPermission = {
      checkChannelPermission: jest.fn().mockResolvedValue(true),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bull-job-1' }),
      getJob: jest.fn(),
    };

    service = new SchedulingService(
      mockPrisma,
      mockPostWorkflow,
      mockPreflight,
      mockPermission,
      mockQueue,
    );
  });

  describe('schedulePost', () => {
    it('should parse channel timezone date string, transition APPROVED -> SCHEDULED, and enqueue delayed BullMQ job', async () => {
      // 1 year in the future
      const futureYear = new Date().getFullYear() + 1;
      const scheduledStr = `21.09.${futureYear} 18:30`;

      const result = await service.schedulePost('post-1', scheduledStr, 'user-editor');

      expect(mockPreflight.validateStage1).toHaveBeenCalledWith('post-1', 'user-editor');
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-1',
          expectedVersion: 3,
          targetStatus: PostStatus.SCHEDULED,
          action: PostAction.SCHEDULE,
          actorId: 'user-editor',
        }),
      );

      // Verify DB PublicationJob created with idempotencyKey publish:{postId}:{version}
      expect(mockPrisma.publicationJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postId: 'post-1',
          postVersion: 4,
          idempotencyKey: 'publish:post-1:4',
          channelId: 'chan-1',
          status: PublicationJobStatus.PENDING,
        }),
      });

      // Verify BullMQ delayed job enqueued
      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.objectContaining({
          postId: 'post-1',
          postVersion: 4,
          channelId: 'chan-1',
          actorId: 'user-editor',
          isScheduled: true,
        }),
        expect.objectContaining({
          delay: expect.any(Number),
          attempts: 3,
        }),
      );

      expect(result.status).toBe(PostStatus.SCHEDULED);
      expect(result.version).toBe(4);
    });

    it('should accept future Date object directly', async () => {
      const futureDate = new Date(Date.now() + 3600 * 1000); // +1 hour

      const result = await service.schedulePost('post-1', futureDate, 'user-editor');

      expect(result.status).toBe(PostStatus.SCHEDULED);
      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.any(Object),
        expect.objectContaining({
          delay: expect.any(Number),
        }),
      );
    });

    it('should reject scheduling in the past with ValidationException', async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000); // -1 hour

      await expect(service.schedulePost('post-1', pastDate, 'user-editor')).rejects.toThrow(
        ValidationException,
      );
      await expect(service.schedulePost('post-1', pastDate, 'user-editor')).rejects.toThrow(
        /Нельзя планировать публикацию в прошлом/,
      );

      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should reject scheduling if post is not APPROVED', async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockApprovedPost,
        status: PostStatus.DRAFT,
      });

      const futureDate = new Date(Date.now() + 3600 * 1000);
      await expect(service.schedulePost('post-1', futureDate, 'user-editor')).rejects.toThrow(
        InvalidPostStateTransitionException,
      );
    });

    it('should reject scheduling if post is soft-deleted or not found', async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockApprovedPost,
        deletedAt: new Date(),
      });

      const futureDate = new Date(Date.now() + 3600 * 1000);
      await expect(service.schedulePost('post-1', futureDate, 'user-editor')).rejects.toThrow(
        ValidationException,
      );
    });
  });

  describe('cancelSchedule', () => {
    const mockScheduledPost = {
      ...mockApprovedPost,
      status: PostStatus.SCHEDULED,
      version: 4,
    };

    beforeEach(() => {
      mockPrisma.post.findUnique.mockResolvedValue(mockScheduledPost);
    });

    it('should remove delayed BullMQ job, mark DB job CANCELLED, and transition post SCHEDULED -> CANCELLED', async () => {
      const mockBullJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(mockBullJob);

      mockPrisma.publicationJob.findFirst.mockResolvedValue({
        id: 'pub-job-1',
        postId: 'post-1',
        status: PublicationJobStatus.PENDING,
      });

      const result = await service.cancelSchedule('post-1', 'user-editor', 4);

      expect(mockPermission.checkChannelPermission).toHaveBeenCalledWith(
        'user-editor',
        'chan-1',
        ChannelPermission.CANCEL_SCHEDULE,
      );

      // Verify BullMQ job removed
      expect(mockQueue.getJob).toHaveBeenCalledWith('pub-job-1');
      expect(mockBullJob.remove).toHaveBeenCalled();

      // Verify DB job marked CANCELLED
      expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith({
        where: { id: 'pub-job-1' },
        data: { status: PublicationJobStatus.CANCELLED },
      });

      // Verify post state transitioned to CANCELLED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-1',
          expectedVersion: 4,
          targetStatus: PostStatus.CANCELLED,
          action: PostAction.CANCEL,
          actorId: 'user-editor',
        }),
      );

      expect(result.status).toBe(PostStatus.CANCELLED);
    });

    it('should reject cancellation if post is not in SCHEDULED status', async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockScheduledPost,
        status: PostStatus.APPROVED,
      });

      await expect(service.cancelSchedule('post-1', 'user-editor')).rejects.toThrow(
        InvalidPostStateTransitionException,
      );
    });

    it('should reject cancellation if actor lacks CANCEL_SCHEDULE permission', async () => {
      mockPermission.checkChannelPermission.mockResolvedValueOnce(false);

      await expect(service.cancelSchedule('post-1', 'user-author')).rejects.toThrow(
        PermissionDeniedException,
      );
    });
  });
});
