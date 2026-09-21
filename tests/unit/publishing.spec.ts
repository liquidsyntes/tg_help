import 'reflect-metadata';
import { PostStatus, PublicationJobStatus, Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PublishingPreflightService } from '../../src/modules/publishing/publishing-preflight.service';
import { PublishingService } from '../../src/modules/publishing/publishing.service';
import { PublishingProcessor } from '../../src/modules/publishing/publishing.processor';
import { TelegramErrorCategory } from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../src/infrastructure/telegram-api/errors/telegram-api.exceptions';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
} from '../../src/common/exceptions/domain.exceptions';
import { JOB_NAMES } from '../../src/common/constants/queue-names';

describe('Publishing Module Comprehensive Unit Tests', () => {
  const mockChannel = {
    id: 'chan-prod',
    title: 'Production Channel',
    telegramChatId: '-1001234567890',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const mockTemplate = {
    id: 'tmpl-news',
    key: 'news',
    name: 'News Article',
    schemaJson: {
      fields: [
        { key: 'title', type: 'text', required: true, maxLength: 256 },
        { key: 'body', type: 'rich_text', required: true },
      ],
    },
    renderConfig: {},
    supportedMediaTypes: ['photo', 'video', 'document'],
    isActive: true,
  };

  const mockApprovedPost = {
    id: 'post-100',
    channelId: 'chan-prod',
    authorId: 'user-author',
    templateId: 'tmpl-news',
    status: PostStatus.APPROVED,
    version: 3,
    contentJson: { title: 'Big Announcement', body: 'This is the main news body.' },
    metadataJson: {},
    deletedAt: null,
    channel: mockChannel,
    template: mockTemplate,
    media: [],
  };

  describe('PublishingPreflightService', () => {
    let preflightService: PublishingPreflightService;
    let mockPrisma: any;
    let mockValidator: any;
    let mockRenderer: any;
    let mockPermission: any;

    beforeEach(() => {
      mockPrisma = {
        post: {
          findUnique: jest.fn().mockResolvedValue(mockApprovedPost),
        },
      };

      mockValidator = {
        validateContent: jest.fn().mockReturnValue({ isValid: true, errors: [] }),
      };

      mockRenderer = {
        render: jest.fn().mockResolvedValue({
          messages: [{ partIndex: 0, type: 'text', html: '<b>Big Announcement</b>\n\nBody' }],
        }),
      };

      mockPermission = {
        checkChannelPermission: jest.fn().mockResolvedValue(true),
      };

      preflightService = new PublishingPreflightService(
        mockPrisma,
        mockValidator,
        mockRenderer,
        mockPermission,
      );
    });

    describe('Stage 1 Validation', () => {
      it('should pass for valid approved post and return stage 1 result', async () => {
        const result = await preflightService.validateStage1('post-100', 'user-editor');
        expect(result.post.id).toBe('post-100');
        expect(result.payload.messages.length).toBe(1);
      });

      it('should reject non-publishable post status (e.g. DRAFT)', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          status: PostStatus.DRAFT,
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          InvalidPostStateTransitionException,
        );
      });

      it('should reject soft-deleted post', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          deletedAt: new Date(),
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          ValidationException,
        );
      });

      it('should reject when channel is inactive or telegramChatId is missing', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          channel: { ...mockChannel, isActive: false },
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          /inactive or missing/,
        );

        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          channel: { ...mockChannel, telegramChatId: '' },
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          /no valid telegramChatId/,
        );
      });

      it('should reject when actor lacks PUBLISH_POST permission', async () => {
        mockPermission.checkChannelPermission.mockResolvedValueOnce(false);

        await expect(preflightService.validateStage1('post-100', 'user-author')).rejects.toThrow(
          PermissionDeniedException,
        );
      });

      it('should reject when template content validation fails', async () => {
        mockValidator.validateContent.mockReturnValueOnce({
          isValid: false,
          errors: [{ field: 'body', message: 'Field body is required' }],
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          /Validation against template/,
        );
      });

      it('should reject media group exceeding 10 items or unsupported types', async () => {
        const elevenMedia = Array(11).fill(null).map((_, i) => ({
          id: `m-${i}`,
          telegramFileId: `file-${i}`,
          telegramFileUniqueId: `uniq-${i}`,
          mediaType: 'photo' as const,
        }));

        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          media: elevenMedia,
        });

        await expect(preflightService.validateStage1('post-100', 'user-editor')).rejects.toThrow(
          /exceeds maximum limit of 10/,
        );
      });
    });

    describe('Stage 2 Validation', () => {
      it('should pass and return stage 2 result for valid post in worker', async () => {
        const result = await preflightService.validateStage2('post-100');
        expect(result.post.id).toBe('post-100');
        expect(result.payload.messages.length).toBe(1);
      });

      it('should throw TelegramPermanentException if post is deleted or invalid in stage 2', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce(null);
        await expect(preflightService.validateStage2('post-100')).rejects.toThrow(
          TelegramPermanentException,
        );

        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          status: PostStatus.CANCELLED,
        });
        await expect(preflightService.validateStage2('post-100')).rejects.toThrow(
          TelegramPermanentException,
        );
      });
    });
  });

  describe('PublishingService', () => {
    let service: PublishingService;
    let mockPrisma: any;
    let mockPreflight: any;
    let mockAudit: any;
    let mockQueue: any;

    beforeEach(() => {
      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockResolvedValue(null),
          findUniqueOrThrow: jest.fn(),
          create: jest.fn().mockImplementation((args) => ({
            id: 'pub-job-new',
            ...args.data,
          })),
        },
      };

      mockPreflight = {
        validateStage1: jest.fn().mockResolvedValue({ post: mockApprovedPost }),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      };

      mockQueue = {
        add: jest.fn().mockResolvedValue({ id: 'publish:post-100:3' }),
      };

      service = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );
    });

    it('should perform stage 1 preflight, create DB job, and enqueue to BullMQ', async () => {
      const job = await service.enqueuePublish('post-100', 'user-editor');

      expect(mockPreflight.validateStage1).toHaveBeenCalledWith('post-100', 'user-editor');

      const expectedKey = 'publish:post-100:3';
      expect(mockPrisma.publicationJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postId: 'post-100',
          postVersion: 3,
          idempotencyKey: expectedKey,
          status: PublicationJobStatus.PENDING,
        }),
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.objectContaining({
          postId: 'post-100',
          postVersion: 3,
          actorId: 'user-editor',
        }),
        expect.objectContaining({
          jobId: expectedKey,
          attempts: 3,
        }),
      );

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PUBLICATION_JOB_CREATED,
          entityId: 'pub-job-new',
        }),
      );

      expect(job.idempotencyKey).toBe(expectedKey);
    });

    it('should return existing job if idempotency key already exists in DB (Idempotency Rule F-31)', async () => {
      const existingJob = {
        id: 'pub-job-existing',
        postId: 'post-100',
        postVersion: 3,
        idempotencyKey: 'publish:post-100:3',
        status: PublicationJobStatus.PENDING,
      };
      mockPrisma.publicationJob.findUnique.mockResolvedValueOnce(existingJob);

      const job = await service.enqueuePublish('post-100', 'user-editor');

      expect(job.id).toBe('pub-job-existing');
      expect(mockPrisma.publicationJob.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should gracefully handle P2002 race condition collision and return existing job', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      mockPrisma.publicationJob.create.mockRejectedValueOnce(p2002Error);

      const existingJob = {
        id: 'pub-job-concurrent',
        idempotencyKey: 'publish:post-100:3',
        status: PublicationJobStatus.PENDING,
      };
      mockPrisma.publicationJob.findUniqueOrThrow.mockResolvedValueOnce(existingJob);

      const job = await service.enqueuePublish('post-100', 'user-editor');
      expect(job.id).toBe('pub-job-concurrent');
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('PublishingProcessor (BullMQ Worker)', () => {
    let processor: PublishingProcessor;
    let mockPrisma: any;
    let mockPostWorkflow: any;
    let mockPreflight: any;
    let mockPublisher: any;
    let mockRenderer: any;
    let mockAudit: any;
    let mockEventBus: any;

    const mockJobData = {
      publicationJobId: 'pub-job-1',
      postId: 'post-100',
      postVersion: 3,
      channelId: 'chan-prod',
      actorId: 'user-editor',
    };

    const mockBullJob = {
      id: 'publish:post-100:3',
      data: mockJobData,
      attemptsMade: 0,
      opts: { attempts: 3 },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    } as any;

    const multiPartPayload = {
      messages: [
        {
          partIndex: 0,
          type: 'media_group' as const,
          items: [
            { type: 'photo' as const, fileId: 'p1' },
            { type: 'photo' as const, fileId: 'p2' },
          ],
        },
        {
          partIndex: 1,
          type: 'text' as const,
          html: 'Overflow body text description',
        },
      ],
    };

    let currentPubJob: any = {
      id: 'pub-job-1',
      postId: 'post-100',
      status: PublicationJobStatus.PENDING,
      telegramMessageIds: [],
    };

    beforeEach(() => {
      currentPubJob = {
        id: 'pub-job-1',
        postId: 'post-100',
        status: PublicationJobStatus.PENDING,
        telegramMessageIds: [],
      };

      mockPrisma = {
        publicationJob: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(currentPubJob)),
          update: jest.fn().mockImplementation((args) => {
            currentPubJob = {
              ...currentPubJob,
              ...args.data,
            };
            return Promise.resolve(currentPubJob);
          }),
        },
        post: {
          findUnique: jest.fn().mockResolvedValue(mockApprovedPost),
        },
      };

      mockPostWorkflow = {
        transition: jest.fn().mockImplementation((cmd) => ({
          ...mockApprovedPost,
          status: cmd.targetStatus,
          version: cmd.expectedVersion + 1,
          publishedAt: cmd.targetStatus === PostStatus.PUBLISHED ? new Date() : null,
        })),
      };

      mockPreflight = {
        validateStage2: jest.fn().mockResolvedValue({
          post: mockApprovedPost,
          channel: mockChannel,
          template: mockTemplate,
          media: [],
          payload: multiPartPayload,
        }),
      };

      mockPublisher = {
        publishOutgoingMessage: jest.fn()
          .mockResolvedValueOnce([1001, 1002]) // media group
          .mockResolvedValueOnce([1003]),       // text
      };

      mockRenderer = {
        render: jest.fn().mockResolvedValue(multiPartPayload),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      };

      mockEventBus = {
        publish: jest.fn(),
      };

      processor = new PublishingProcessor(
        mockPrisma,
        mockPostWorkflow,
        mockPreflight,
        mockPublisher,
        mockRenderer,
        mockAudit,
        mockEventBus,
      );
    });

    it('should execute full publishing flow: APPROVED -> PUBLISHING -> send parts -> PUBLISHED', async () => {
      await processor.process(mockBullJob);

      // 1. Preflight Stage 2 called
      expect(mockPreflight.validateStage2).toHaveBeenCalledWith('post-100');

      // 2. State transition: APPROVED -> PUBLISHING
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-100',
          targetStatus: PostStatus.PUBLISHING,
          action: PostAction.START_PUBLISHING,
        }),
      );

      // 3. Sent both parts
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(2);

      // 4. State transition: PUBLISHING -> PUBLISHED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-100',
          targetStatus: PostStatus.PUBLISHED,
          action: PostAction.MARK_PUBLISHED,
        }),
      );

      // 5. DB job marked COMPLETED
      expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pub-job-1' },
          data: expect.objectContaining({
            status: PublicationJobStatus.COMPLETED,
          }),
        }),
      );

      // 6. Dispatched PostPublishedEvent with all message IDs [1001, 1002, 1003]
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-100',
          telegramMessageIds: [1001, 1002, 1003],
        }),
      );
    });

    it('should skip transition to PUBLISHING if post is already PUBLISHING on retry (Guard Rule)', async () => {
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: multiPartPayload,
      });

      await processor.process(mockBullJob);

      // Should NOT have transitioned to PUBLISHING again!
      const calls = mockPostWorkflow.transition.mock.calls;
      const publishingCalls = calls.filter((c: any[]) => c[0].targetStatus === PostStatus.PUBLISHING);
      expect(publishingCalls.length).toBe(0);

      // But should have transitioned to PUBLISHED at the end
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISHED,
        }),
      );
    });

    it('should implement Partial Publication Resume (Rule F-34, AGENTS.md §23) by skipping already sent parts', async () => {
      // In this retry, Part 0 (media group with IDs 1001, 1002) was already sent in attempt 1!
      mockPrisma.publicationJob.findFirst.mockResolvedValueOnce({
        id: 'pub-job-1',
        postId: 'post-100',
        status: PublicationJobStatus.PENDING,
        telegramMessageIds: [1001, 1002], // media group already recorded
      });

      // Publisher only needs to send part 1 (text)
      mockPublisher.publishOutgoingMessage = jest.fn().mockResolvedValueOnce([1003]);

      await processor.process(mockBullJob);

      // Crucial assertion: publisher was called ONCE for the text part only, NOT for media group!
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '-1001234567890',
        expect.objectContaining({ type: 'text' }),
      );

      // Final message IDs in DB must contain all [1001, 1002, 1003]
      expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            telegramMessageIds: [1001, 1002, 1003],
          }),
        }),
      );
    });

    it('should re-throw transient errors for BullMQ backoff retry when attempts not exhausted', async () => {
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
        new TelegramRetryableException('Gateway Timeout (504)'),
      );

      const jobAttempt1 = { ...mockBullJob, attemptsMade: 0 };

      await expect(processor.process(jobAttempt1)).rejects.toThrow('Gateway Timeout (504)');

      expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorMessage: 'Gateway Timeout (504)',
            attempts: 1,
          }),
        }),
      );

      // Post should NOT transition to PUBLISH_FAILED yet
      const failedTransitions = mockPostWorkflow.transition.mock.calls.filter(
        (c: any[]) => c[0].targetStatus === PostStatus.PUBLISH_FAILED,
      );
      expect(failedTransitions.length).toBe(0);
    });

    it('should transition post to PUBLISH_FAILED and throw UnrecoverableError on retry exhaustion', async () => {
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
        new TelegramRetryableException('Internal Server Error (500)'),
      );

      // Attempt 3 of 3 -> Exhausted!
      const jobAttempt3 = { ...mockBullJob, attemptsMade: 2, opts: { attempts: 3 } };

      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockApprovedPost,
        status: PostStatus.PUBLISHING,
      });

      await expect(processor.process(jobAttempt3)).rejects.toThrow(UnrecoverableError);

      // Post transitioned to PUBLISH_FAILED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISH_FAILED,
          action: PostAction.MARK_PUBLISH_FAILED,
        }),
      );

      // Job marked FAILED in DB
      expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PublicationJobStatus.FAILED,
          }),
        }),
      );

      // Dispatched PostPublicationFailedEvent
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-100',
          attempts: 3,
        }),
      );
    });

    it('should fail fast on permanent error (e.g. 403 bot kicked) and throw UnrecoverableError', async () => {
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
        new TelegramPermanentException('Forbidden: bot was kicked from the channel', 403),
      );

      const jobAttempt1 = { ...mockBullJob, attemptsMade: 0 };

      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockApprovedPost,
        status: PostStatus.PUBLISHING,
      });

      await expect(processor.process(jobAttempt1)).rejects.toThrow(UnrecoverableError);

      // Post immediately transitioned to PUBLISH_FAILED without waiting for retry exhaustion
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISH_FAILED,
        }),
      );
    });

    it('should close worker gracefully onModuleDestroy', async () => {
      const mockClose = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(processor, 'worker', {
        value: { close: mockClose },
        configurable: true,
      });

      await processor.onModuleDestroy();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
