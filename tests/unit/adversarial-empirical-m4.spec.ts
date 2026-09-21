import 'reflect-metadata';
import { PostStatus, PublicationJobStatus, Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PublishingPreflightService } from '../../src/modules/publishing/publishing-preflight.service';
import { PublishingService } from '../../src/modules/publishing/publishing.service';
import { PublishingProcessor } from '../../src/modules/publishing/publishing.processor';
import {
  ITelegramPublisher,
  TelegramErrorCategory,
} from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
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
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';

/**
 * Milestone 4 Empirical Adversarial Stress Suite (m4_challenger_1)
 *
 * Focus areas:
 * 1. Concurrency & Idempotency Stress:
 *    - High-concurrency simultaneous publish requests (double-clicks & multi-client race conditions).
 *    - Zero duplicate DB records, zero duplicate BullMQ jobs.
 *    - P2002 unique constraint collision recovery under concurrent execution.
 *    - Worker-level redelivery idempotency (COMPLETED and CANCELLED skip).
 *    - Partial publication resume and OCC guard against redundant transitions.
 * 2. Preflight Validation Hardening:
 *    - Post status rejection for non-publishable statuses.
 *    - Soft-deleted post rejection.
 *    - ChannelPermission.PUBLISH_POST enforcement.
 *    - Channel inactive or missing telegramChatId rejection.
 *    - Template schema and content validation rejection.
 *    - Media limit and invariant rejection.
 *    - Empty rendered payload rejection.
 */
describe('Milestone 4 Empirical Adversarial Stress Suite (m4_challenger_1)', () => {
  const baseChannel = {
    id: 'chan-adversarial',
    title: 'Adversarial Test Channel',
    telegramChatId: '-1009876543210',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const baseTemplate = {
    id: 'tmpl-adv',
    key: 'adv_tmpl',
    name: 'Adversarial Template',
    schemaJson: {
      fields: [
        { key: 'headline', type: 'text', required: true, maxLength: 100 },
        { key: 'body', type: 'rich_text', required: true, maxLength: 2000 },
      ],
    },
    renderConfig: {},
    supportedMediaTypes: ['photo', 'video'],
    isActive: true,
  };

  const baseApprovedPost = {
    id: 'post-adv-100',
    channelId: 'chan-adversarial',
    authorId: 'usr-author-1',
    templateId: 'tmpl-adv',
    status: PostStatus.APPROVED,
    version: 5,
    contentJson: {
      headline: 'Empirical Verification News',
      body: 'Testing robust idempotency and preflight constraints.',
    },
    metadataJson: {},
    deletedAt: null,
    channel: baseChannel,
    template: baseTemplate,
    media: [],
  };

  // =========================================================================
  // Dimension 1: Concurrency & Idempotency Stress
  // =========================================================================
  describe('1. Concurrency & Idempotency Stress', () => {
    let publishingService: PublishingService;
    let mockPrisma: any;
    let mockPreflight: any;
    let mockAudit: any;
    let mockQueue: any;

    beforeEach(() => {
      mockPreflight = {
        validateStage1: jest.fn().mockResolvedValue({ post: baseApprovedPost }),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-id-1' }),
      };

      mockQueue = {
        add: jest.fn().mockImplementation((jobName, data, opts) =>
          Promise.resolve({ id: opts.jobId, name: jobName, data, opts }),
        ),
      };
    });

    it('1.1 Massive Concurrent Double-Click Simulation (50 simultaneous requests): exactly 1 DB job and 1 queue job', async () => {
      // In-memory atomic store simulating PostgreSQL with unique constraint on idempotencyKey
      const dbStore = new Map<string, any>();
      let createCallCount = 0;
      let findUniqueCallCount = 0;

      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            findUniqueCallCount++;
            // Inject jittered delay simulating database query latency
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8) + 1));
            return dbStore.get(where.idempotencyKey) || null;
          }),
          findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }) => {
            const job = dbStore.get(where.idempotencyKey);
            if (!job) {
              throw new Error(`Record not found for key: ${where.idempotencyKey}`);
            }
            return job;
          }),
          create: jest.fn().mockImplementation(async ({ data }) => {
            createCallCount++;
            // Small async pause to allow real concurrent interleaving
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));
            if (dbStore.has(data.idempotencyKey)) {
              // PostgreSQL unique constraint P2002 collision
              const error = new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed on the fields: (idempotency_key)',
                { code: 'P2002', clientVersion: '6.19.3' },
              );
              throw error;
            }
            const record = {
              id: `pub-job-uuid-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            dbStore.set(data.idempotencyKey, record);
            return record;
          }),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      // Launch 50 concurrent requests simultaneously
      const CONCURRENCY = 50;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(publishingService.enqueuePublish('post-adv-100', 'usr-editor-1'));
      }

      const results = await Promise.all(promises);

      // Assertion 1: All 50 promises resolved successfully
      expect(results.length).toBe(CONCURRENCY);

      // Assertion 2: All 50 returned jobs have identical ID and idempotency key
      const firstJob = results[0];
      expect(firstJob.idempotencyKey).toBe('publish:post-adv-100:5');
      for (const res of results) {
        expect(res.id).toBe(firstJob.id);
        expect(res.idempotencyKey).toBe(firstJob.idempotencyKey);
      }

      // Assertion 3: Exactly 1 record exists in the database
      expect(dbStore.size).toBe(1);

      // Assertion 4: BullMQ queue.add was called at most once or all calls used identical deduplication jobId
      // Due to P2002 recovery early returns, queue.add is only called for the successful insert
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.objectContaining({
          postId: 'post-adv-100',
          postVersion: 5,
        }),
        expect.objectContaining({
          jobId: 'publish:post-adv-100:5',
        }),
      );

      // Assertion 5: Audit record was only created for the single job
      expect(mockAudit.record).toHaveBeenCalledTimes(1);
    });

    it('1.2 P2002 Race Collision: 10 concurrent requests where all findUnique return null and collide on create', async () => {
      let created = false;
      const existingJobRecord = {
        id: 'pub-job-p2002-winner',
        postId: 'post-adv-100',
        postVersion: 5,
        idempotencyKey: 'publish:post-adv-100:5',
        channelId: 'chan-adversarial',
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        telegramMessageIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma = {
        publicationJob: {
          // Both callers check before either has committed -> returns null
          findUnique: jest.fn().mockResolvedValue(null),
          findUniqueOrThrow: jest.fn().mockResolvedValue(existingJobRecord),
          create: jest.fn().mockImplementation(async () => {
            if (!created) {
              created = true;
              return existingJobRecord;
            }
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: '6.19.3',
            });
          }),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      const callers = Array(10).fill(null).map(() =>
        publishingService.enqueuePublish('post-adv-100', 'usr-editor-1'),
      );

      const results = await Promise.all(callers);

      // All 10 callers resolve without throwing
      expect(results.length).toBe(10);
      for (const res of results) {
        expect(res.id).toBe('pub-job-p2002-winner');
      }

      // Exactly 1 winner called queue.add
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      // The other 9 callers called findUniqueOrThrow
      expect(mockPrisma.publicationJob.findUniqueOrThrow).toHaveBeenCalledTimes(9);
    });

    it('1.3 Sequential Duplicate Publishing: subsequent calls return existing DB job without re-enqueueing', async () => {
      const persistedJob = {
        id: 'pub-job-persisted',
        postId: 'post-adv-100',
        postVersion: 5,
        idempotencyKey: 'publish:post-adv-100:5',
        channelId: 'chan-adversarial',
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        telegramMessageIds: [],
      };

      let dbJob: any = null;

      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockImplementation(async () => dbJob),
          findUniqueOrThrow: jest.fn().mockImplementation(async () => dbJob),
          create: jest.fn().mockImplementation(async (args) => {
            dbJob = { id: 'pub-job-persisted', ...args.data };
            return dbJob;
          }),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      // 1st call: creates record
      const job1 = await publishingService.enqueuePublish('post-adv-100', 'usr-editor-1');
      expect(job1.id).toBe('pub-job-persisted');
      expect(mockPrisma.publicationJob.create).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);

      // 2nd call: finds existing
      const job2 = await publishingService.enqueuePublish('post-adv-100', 'usr-editor-1');
      expect(job2.id).toBe('pub-job-persisted');

      // 3rd call: finds existing
      const job3 = await publishingService.enqueuePublish('post-adv-100', 'usr-editor-1');
      expect(job3.id).toBe('pub-job-persisted');

      // Still only 1 create and 1 queue.add
      expect(mockPrisma.publicationJob.create).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockAudit.record).toHaveBeenCalledTimes(1);
    });

    it('1.4 Worker Redelivery Idempotency: skip execution if job is already COMPLETED or CANCELLED', async () => {
      const mockPublisher: Partial<ITelegramPublisher> = {
        publishOutgoingMessage: jest.fn(),
      };
      const mockPostWorkflow = {
        transition: jest.fn(),
      };
      const mockEventBus = {
        publish: jest.fn(),
      };
      const mockProcessorPrisma = {
        publicationJob: {
          findFirst: jest.fn(),
          update: jest.fn(),
        },
        post: {
          findUnique: jest.fn(),
        },
      };

      const processor = new PublishingProcessor(
        mockProcessorPrisma as any,
        mockPostWorkflow as any,
        mockPreflight as any,
        mockPublisher as any,
        {} as any,
        mockAudit,
        mockEventBus as any,
      );

      const jobData = {
        publicationJobId: 'pub-job-done',
        postId: 'post-adv-100',
        postVersion: 5,
        channelId: 'chan-adversarial',
        actorId: 'usr-editor-1',
      };

      // Case A: Job is COMPLETED in DB
      mockProcessorPrisma.publicationJob.findFirst.mockResolvedValueOnce({
        id: 'pub-job-done',
        status: PublicationJobStatus.COMPLETED,
        telegramMessageIds: [9001],
      });

      await processor.process({ id: 'publish:post-adv-100:5', data: jobData, attemptsMade: 0 } as any);

      // Must NOT dispatch to Telegram or transition workflow
      expect(mockPublisher.publishOutgoingMessage).not.toHaveBeenCalled();
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
      expect(mockEventBus.publish).not.toHaveBeenCalled();

      // Case B: Job is CANCELLED in DB
      mockProcessorPrisma.publicationJob.findFirst.mockResolvedValueOnce({
        id: 'pub-job-done',
        status: PublicationJobStatus.CANCELLED,
        telegramMessageIds: [],
      });

      await processor.process({ id: 'publish:post-adv-100:5', data: jobData, attemptsMade: 0 } as any);

      expect(mockPublisher.publishOutgoingMessage).not.toHaveBeenCalled();
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
    });

    it('1.5 Worker OCC Guard: prevent redundant transition to PUBLISHING if post is already PUBLISHING on retry', async () => {
      const mockPublisher: Partial<ITelegramPublisher> = {
        publishOutgoingMessage: jest.fn().mockResolvedValue([9002]),
      };
      const mockPostWorkflow = {
        transition: jest.fn().mockResolvedValue({
          ...baseApprovedPost,
          status: PostStatus.PUBLISHED,
          publishedAt: new Date(),
        }),
      };
      const mockEventBus = {
        publish: jest.fn(),
      };
      const mockProcessorPrisma = {
        publicationJob: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'pub-job-running',
            status: PublicationJobStatus.RUNNING,
            telegramMessageIds: [],
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      // Stage 2 preflight returns post that is ALREADY in PUBLISHING status (retry scenario)
      const mockPreflightWithPublishing = {
        validateStage2: jest.fn().mockResolvedValue({
          post: { ...baseApprovedPost, status: PostStatus.PUBLISHING },
          channel: baseChannel,
          template: baseTemplate,
          media: [],
          payload: { messages: [{ partIndex: 0, type: 'text', html: 'Test' }] },
        }),
      };

      const processor = new PublishingProcessor(
        mockProcessorPrisma as any,
        mockPostWorkflow as any,
        mockPreflightWithPublishing as any,
        mockPublisher as any,
        {} as any,
        mockAudit,
        mockEventBus as any,
      );

      await processor.process({
        id: 'publish:post-adv-100:5',
        data: {
          publicationJobId: 'pub-job-running',
          postId: 'post-adv-100',
          postVersion: 5,
          channelId: 'chan-adversarial',
          actorId: 'usr-editor-1',
        },
        attemptsMade: 1, // retry attempt
      } as any);

      // Verify that transition was called for MARK_PUBLISHED, but NEVER for START_PUBLISHING
      const transitions = mockPostWorkflow.transition.mock.calls;
      const startPublishingCalls = transitions.filter(
        (c: any[]) => c[0].action === PostAction.START_PUBLISHING,
      );
      expect(startPublishingCalls.length).toBe(0);

      const markPublishedCalls = transitions.filter(
        (c: any[]) => c[0].action === PostAction.MARK_PUBLISHED,
      );
      expect(markPublishedCalls.length).toBe(1);
    });
  });

  // =========================================================================
  // Dimension 2: Preflight Validation Hardening
  // =========================================================================
  describe('2. Preflight Validation Hardening', () => {
    let preflightService: PublishingPreflightService;
    let mockPrisma: any;
    let validator: TemplateValidator;
    let sanitizer: HtmlSanitizer;
    let renderer: TelegramRenderer;
    let mockPermission: any;

    beforeEach(() => {
      validator = new TemplateValidator();
      sanitizer = new HtmlSanitizer();
      renderer = new TelegramRenderer(sanitizer);

      mockPrisma = {
        post: {
          findUnique: jest.fn().mockResolvedValue(baseApprovedPost),
        },
      };

      mockPermission = {
        checkChannelPermission: jest.fn().mockResolvedValue(true),
      };

      preflightService = new PublishingPreflightService(
        mockPrisma,
        validator,
        renderer,
        mockPermission,
      );
    });

    describe('2.1 Post Status Invariant Enforcement', () => {
      const illegalStatuses: PostStatus[] = [
        PostStatus.DRAFT,
        PostStatus.PENDING_REVIEW,
        PostStatus.NEEDS_REVISION,
        PostStatus.REJECTED,
        PostStatus.CANCELLED,
        PostStatus.PUBLISHED,
      ];

      for (const status of illegalStatuses) {
        it(`Stage 1 should reject unapproved status: ${status}`, async () => {
          mockPrisma.post.findUnique.mockResolvedValueOnce({
            ...baseApprovedPost,
            status,
          });

          await expect(
            preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
          ).rejects.toThrow(InvalidPostStateTransitionException);
        });
      }

      it('Stage 1 should allow APPROVED, SCHEDULED, and PUBLISH_FAILED (manual retry)', async () => {
        // APPROVED
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          status: PostStatus.APPROVED,
        });
        const res1 = await preflightService.validateStage1('post-adv-100', 'usr-editor-1');
        expect(res1.post.status).toBe(PostStatus.APPROVED);

        // SCHEDULED
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          status: PostStatus.SCHEDULED,
        });
        const res2 = await preflightService.validateStage1('post-adv-100', 'usr-editor-1');
        expect(res2.post.status).toBe(PostStatus.SCHEDULED);

        // PUBLISH_FAILED
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          status: PostStatus.PUBLISH_FAILED,
        });
        const res3 = await preflightService.validateStage1('post-adv-100', 'usr-editor-1');
        expect(res3.post.status).toBe(PostStatus.PUBLISH_FAILED);
      });

      it('Stage 2 should reject non-executable post statuses with TelegramPermanentException', async () => {
        const invalidStage2Statuses: PostStatus[] = [
          PostStatus.DRAFT,
          PostStatus.PENDING_REVIEW,
          PostStatus.NEEDS_REVISION,
          PostStatus.REJECTED,
          PostStatus.CANCELLED,
          PostStatus.PUBLISHED,
        ];

        for (const status of invalidStage2Statuses) {
          mockPrisma.post.findUnique.mockResolvedValueOnce({
            ...baseApprovedPost,
            status,
          });

          await expect(
            preflightService.validateStage2('post-adv-100'),
          ).rejects.toThrow(TelegramPermanentException);
        }
      });
    });

    describe('2.2 Soft-Deleted Post Rejection', () => {
      it('Stage 1 should reject soft-deleted post with ValidationException', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          deletedAt: new Date(),
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(ValidationException);
      });

      it('Stage 1 should reject non-existent post with ValidationException', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce(null);

        await expect(
          preflightService.validateStage1('post-non-existent', 'usr-editor-1'),
        ).rejects.toThrow(ValidationException);
      });

      it('Stage 2 should reject soft-deleted post with TelegramPermanentException (code 400)', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          deletedAt: new Date(),
        });

        await expect(
          preflightService.validateStage2('post-adv-100'),
        ).rejects.toThrow(TelegramPermanentException);
      });

      it('Stage 2 should reject non-existent post with TelegramPermanentException (code 400)', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce(null);

        await expect(
          preflightService.validateStage2('post-non-existent'),
        ).rejects.toThrow(TelegramPermanentException);
      });
    });

    describe('2.3 ChannelPermission.PUBLISH_POST Enforcement', () => {
      it('Stage 1 should reject actor when checkChannelPermission returns false', async () => {
        mockPermission.checkChannelPermission.mockResolvedValueOnce(false);

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-author-no-publish'),
        ).rejects.toThrow(PermissionDeniedException);

        expect(mockPermission.checkChannelPermission).toHaveBeenCalledWith(
          'usr-author-no-publish',
          'chan-adversarial',
          ChannelPermission.PUBLISH_POST,
        );
      });

      it('Stage 1 should succeed when actor has PUBLISH_POST permission', async () => {
        mockPermission.checkChannelPermission.mockResolvedValueOnce(true);

        const result = await preflightService.validateStage1('post-adv-100', 'usr-editor-1');
        expect(result.post.id).toBe('post-adv-100');
      });
    });

    describe('2.4 Target Channel Validity & Missing Telegram Chat ID', () => {
      it('Stage 1 should reject inactive target channel', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          channel: { ...baseChannel, isActive: false },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/inactive or missing/);
      });

      it('Stage 1 should reject channel with empty telegramChatId', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          channel: { ...baseChannel, telegramChatId: '' },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/no valid telegramChatId/);
      });

      it('Stage 1 should reject channel with whitespace-only telegramChatId', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          channel: { ...baseChannel, telegramChatId: '     ' },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/no valid telegramChatId/);
      });

      it('Stage 2 should reject inactive channel with TelegramPermanentException', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          channel: { ...baseChannel, isActive: false },
        });

        await expect(
          preflightService.validateStage2('post-adv-100'),
        ).rejects.toThrow(TelegramPermanentException);
      });

      it('Stage 2 should reject channel missing telegramChatId with TelegramPermanentException', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          channel: { ...baseChannel, telegramChatId: '' },
        });

        await expect(
          preflightService.validateStage2('post-adv-100'),
        ).rejects.toThrow(TelegramPermanentException);
      });
    });

    describe('2.5 Template Schema & Content Validation', () => {
      it('Stage 1 should reject when post content is missing a required schema field', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          contentJson: {
            headline: 'Only headline present',
            // 'body' is required according to template schema, missing here!
          },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(ValidationException);
      });

      it('Stage 1 should reject when content field exceeds schema maxLength', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          contentJson: {
            headline: 'A'.repeat(101), // schema maxLength is 100
            body: 'Valid body text',
          },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(ValidationException);
      });

      it('Stage 1 should reject when post template is inactive', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          template: { ...baseTemplate, isActive: false },
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/inactive or missing/);
      });

      it('Stage 2 should reject inactive template with TelegramPermanentException', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          template: { ...baseTemplate, isActive: false },
        });

        await expect(
          preflightService.validateStage2('post-adv-100'),
        ).rejects.toThrow(TelegramPermanentException);
      });
    });

    describe('2.6 Media Constraints & Invariant Enforcement', () => {
      it('Stage 1 should reject when media count exceeds Telegram maximum of 10', async () => {
        const elevenMedia = Array(11).fill(null).map((_, i) => ({
          id: `media-${i}`,
          postId: 'post-adv-100',
          telegramFileId: `tg-file-${i}`,
          telegramFileUniqueId: `tg-uniq-${i}`,
          mediaType: 'photo' as const,
          sortOrder: i,
        }));

        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          media: elevenMedia,
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/exceeds maximum limit of 10/);
      });

      it('Stage 1 should reject media missing telegramFileId', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          media: [
            {
              id: 'media-missing-fileid',
              postId: 'post-adv-100',
              telegramFileId: '   ',
              telegramFileUniqueId: 'tg-uniq-1',
              mediaType: 'photo' as const,
              sortOrder: 0,
            },
          ],
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/missing telegramFileId/);
      });

      it('Stage 1 should reject media missing telegramFileUniqueId', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          media: [
            {
              id: 'media-missing-uniqueid',
              postId: 'post-adv-100',
              telegramFileId: 'tg-file-1',
              telegramFileUniqueId: '',
              mediaType: 'photo' as const,
              sortOrder: 0,
            },
          ],
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/missing telegramFileUniqueId/);
      });

      it('Stage 1 should reject media type unsupported by template', async () => {
        // template only supports ['photo', 'video']
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...baseApprovedPost,
          media: [
            {
              id: 'media-unsupported-doc',
              postId: 'post-adv-100',
              telegramFileId: 'tg-file-doc',
              telegramFileUniqueId: 'tg-uniq-doc',
              mediaType: 'document' as const, // unsupported!
              sortOrder: 0,
            },
          ],
        });

        await expect(
          preflightService.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/is not supported by template/);
      });
    });

    describe('2.7 Empty Rendered Payload Rejection', () => {
      it('Stage 1 should reject when renderer produces zero outgoing messages', async () => {
        const mockEmptyRenderer = {
          render: jest.fn().mockResolvedValue({ messages: [] }),
        };

        const serviceWithEmptyRenderer = new PublishingPreflightService(
          mockPrisma,
          validator,
          mockEmptyRenderer as any,
          mockPermission,
        );

        await expect(
          serviceWithEmptyRenderer.validateStage1('post-adv-100', 'usr-editor-1'),
        ).rejects.toThrow(/zero outgoing messages/);
      });

      it('Stage 2 should reject when renderer produces zero outgoing messages with TelegramPermanentException', async () => {
        const mockEmptyRenderer = {
          render: jest.fn().mockResolvedValue({ messages: [] }),
        };

        const serviceWithEmptyRenderer = new PublishingPreflightService(
          mockPrisma,
          validator,
          mockEmptyRenderer as any,
          mockPermission,
        );

        await expect(
          serviceWithEmptyRenderer.validateStage2('post-adv-100'),
        ).rejects.toThrow(TelegramPermanentException);
      });
    });
  });
});
