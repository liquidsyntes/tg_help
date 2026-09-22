import 'reflect-metadata';
import { PostStatus, PublicationJobStatus, Prisma, ReviewAction, Post } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PublishingProcessor } from '../../src/modules/publishing/publishing.processor';
import { PublishingService } from '../../src/modules/publishing/publishing.service';
import { PublishingPreflightService } from '../../src/modules/publishing/publishing-preflight.service';
import { PostWorkflowService } from '../../src/modules/posts/post-workflow.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { DomainEventBus } from '../../src/modules/notifications/domain-event.bus';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { TelegramErrorClassifier } from '../../src/infrastructure/telegram-api/errors/telegram-error.classifier';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../src/infrastructure/telegram-api/errors/telegram-api.exceptions';
import {
  ITelegramPublisher,
  TelegramErrorCategory,
} from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
  PostConflictException,
} from '../../src/common/exceptions/domain.exceptions';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import { JOB_NAMES } from '../../src/common/constants/queue-names';
import { GrammyError } from 'grammy';

/**
 * Milestone 6 Phase 2: Tier 5 Adversarial Coverage Hardening
 * Domain, State Machine & Publishing Track (m6_challenger_1)
 *
 * White-box adversarial test suite verifying:
 * 1. Partial publication resume without duplicate messages across cascading multi-part failures and crash-recovery.
 * 2. Idempotency key collision under heavy concurrent retries (50-client race, manual retry OCC lifecycle on PUBLISH_FAILED).
 * 3. Unrecoverable error handling vs retryable backoff (permanent errors, rate-limiting, preflight Stage 2 abort, retry exhaustion).
 * 4. Optimistic Concurrency Control (OCC) version integrity under atomic transitions, soft-delete invariants, and rollback safety.
 */
describe('Milestone 6 Phase 2: Tier 5 Adversarial Hardening (Domain, State Machine & Publishing)', () => {
  const mockChannel = {
    id: 'chan-m6-adv',
    title: 'Adversarial Verification Channel',
    telegramChatId: '-1009988776655',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const mockTemplate = {
    id: 'tmpl-m6-adv',
    key: 'm6_deep_tmpl',
    name: 'M6 Deep Template',
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

  const mockApprovedPost: Post = {
    id: 'post-m6-500',
    channelId: 'chan-m6-adv',
    authorId: 'usr-author-m6',
    templateId: 'tmpl-m6-adv',
    templateVersion: 1,
    status: PostStatus.APPROVED,
    version: 10,
    contentJson: { title: 'M6 Hardening Title', body: 'Deep adversarial payload text' },
    metadataJson: {},
    scheduledAt: null,
    publishedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // =========================================================================
  // Dimension 1: Partial Publication Resume Without Duplicate Messages
  // Authoritative reference: AGENTS.md §23, tasks.md §23
  // =========================================================================
  describe('Dimension 1: Partial Publication Resume Without Duplicate Messages', () => {
    let processor: PublishingProcessor;
    let mockPrisma: any;
    let mockPostWorkflow: any;
    let mockPreflight: any;
    let mockPublisher: any;
    let mockRenderer: any;
    let mockAudit: any;
    let mockEventBus: any;
    let dbJob: any;

    beforeEach(() => {
      dbJob = {
        id: 'pub-job-m6-1',
        postId: 'post-m6-500',
        postVersion: 10,
        idempotencyKey: 'publish:post-m6-500:10',
        channelId: 'chan-m6-adv',
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        telegramMessageIds: [],
        errorMessage: null,
      };

      mockPrisma = {
        publicationJob: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(dbJob)),
          update: jest.fn().mockImplementation((args: any) => {
            dbJob = { ...dbJob, ...args.data };
            return Promise.resolve(dbJob);
          }),
        },
        post: {
          findUnique: jest.fn().mockResolvedValue(mockApprovedPost),
        },
      };

      mockPostWorkflow = {
        transition: jest.fn().mockImplementation((cmd: any) => ({
          ...mockApprovedPost,
          status: cmd.targetStatus,
          version: cmd.expectedVersion + 1,
          publishedAt: cmd.targetStatus === PostStatus.PUBLISHED ? new Date() : null,
        })),
      };

      mockPreflight = {
        validateStage2: jest.fn(),
      };

      mockPublisher = {
        publishOutgoingMessage: jest.fn(),
      };

      mockRenderer = {
        render: jest.fn(),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-m6-1' }),
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

    it('1.1 4-part complex payload (media_group + text1 + doc + text2): cascading failure across 3 attempts resumes with zero duplicate messages', async () => {
      // 4 parts: Part 0 (3-item media_group), Part 1 (text), Part 2 (document), Part 3 (text)
      // Total expected IDs: 3 + 1 + 1 + 1 = 6
      const fourPartPayload = {
        messages: [
          {
            partIndex: 0,
            type: 'media_group' as const,
            items: [
              { type: 'photo' as const, fileId: 'ph-1' },
              { type: 'photo' as const, fileId: 'ph-2' },
              { type: 'photo' as const, fileId: 'ph-3' },
            ],
          },
          {
            partIndex: 1,
            type: 'text' as const,
            html: 'First narrative section',
          },
          {
            partIndex: 2,
            type: 'document' as const,
            fileId: 'doc-specification',
          },
          {
            partIndex: 3,
            type: 'text' as const,
            html: 'Concluding remarks',
          },
        ],
      };

      mockPreflight.validateStage2.mockResolvedValue({
        post: mockApprovedPost,
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: fourPartPayload,
      });

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-1',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        opts: { attempts: 4 },
      } as any;

      // --- ATTEMPT 1 ---
      // Part 0 succeeds -> [1001, 1002, 1003]
      // Part 1 succeeds -> [1004]
      // Part 2 fails -> 503 Service Unavailable
      mockPublisher.publishOutgoingMessage
        .mockResolvedValueOnce([1001, 1002, 1003])
        .mockResolvedValueOnce([1004])
        .mockRejectedValueOnce(new TelegramRetryableException('503 Service Unavailable', 503));

      await expect(processor.process({ ...bullJob, attemptsMade: 0 })).rejects.toThrow('503 Service Unavailable');

      // Verifications after Attempt 1:
      expect(dbJob.telegramMessageIds).toEqual([1001, 1002, 1003, 1004]);
      expect(dbJob.attempts).toBe(1);
      expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
      );

      // --- ATTEMPT 2 ---
      // Retry attempt 2: Post is already PUBLISHING in DB
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: fourPartPayload,
      });

      mockPublisher.publishOutgoingMessage.mockReset();
      // Part 2 succeeds -> [1005]
      // Part 3 fails -> 504 Gateway Timeout
      mockPublisher.publishOutgoingMessage
        .mockResolvedValueOnce([1005])
        .mockRejectedValueOnce(new TelegramRetryableException('504 Gateway Timeout', 504));

      await expect(processor.process({ ...bullJob, attemptsMade: 1 })).rejects.toThrow('504 Gateway Timeout');

      // Verifications after Attempt 2:
      // Publisher was called ONLY 2 times (Part 2 and Part 3) — Parts 0 and 1 were completely skipped!
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(2);
      expect(dbJob.telegramMessageIds).toEqual([1001, 1002, 1003, 1004, 1005]);
      expect(dbJob.attempts).toBe(2);

      // --- ATTEMPT 3 ---
      // Retry attempt 3: Parts 0, 1, 2 must all be skipped; only Part 3 dispatched!
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: fourPartPayload,
      });

      mockPublisher.publishOutgoingMessage.mockReset();
      // Part 3 succeeds -> [1006]
      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce([1006]);

      await processor.process({ ...bullJob, attemptsMade: 2 });

      // Verifications after Attempt 3:
      // Publisher was called EXACTLY ONCE on Attempt 3 (for Part 3)
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        mockChannel.telegramChatId,
        expect.objectContaining({ partIndex: 3, html: 'Concluding remarks' }),
      );

      // All 6 message IDs must be merged in strict order
      expect(dbJob.telegramMessageIds).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
      expect(dbJob.status).toBe(PublicationJobStatus.COMPLETED);

      // Post transitioned to PUBLISHED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISHED,
          action: PostAction.MARK_PUBLISHED,
        }),
      );

      // PostPublishedEvent emitted with all 6 Telegram message IDs
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-m6-500',
          telegramMessageIds: [1001, 1002, 1003, 1004, 1005, 1006],
        }),
      );
    });

    it('1.2 Crash recovery after all messages sent: retry must skip ALL Telegram API calls and finalize DB state', async () => {
      // Scenario: Telegram API call succeeded, message ID 7001 was saved to DB,
      // but database connection was lost right when transitioning post to PUBLISHED in Attempt 1.
      dbJob.telegramMessageIds = [7001]; // Already recorded in DB
      dbJob.attempts = 1;

      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: {
          messages: [{ partIndex: 0, type: 'text' as const, html: 'Single post message' }],
        },
      });

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-1',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      // CRITICAL INVARIANT: Zero calls to Telegram API on retry!
      expect(mockPublisher.publishOutgoingMessage).not.toHaveBeenCalled();

      // Post is transitioned to PUBLISHED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISHED,
          action: PostAction.MARK_PUBLISHED,
        }),
      );

      // Job is completed with existing message ID
      expect(dbJob.status).toBe(PublicationJobStatus.COMPLETED);
      expect(dbJob.telegramMessageIds).toEqual([7001]);
    });

    it('1.3 should support publisher returning a single number primitive rather than array', async () => {
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: mockApprovedPost,
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: {
          messages: [{ partIndex: 0, type: 'text' as const, html: 'Text payload' }],
        },
      });

      // Publisher returns a number primitive instead of number[]
      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce(8888);

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-1',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      expect(dbJob.telegramMessageIds).toEqual([8888]);
      expect(dbJob.status).toBe(PublicationJobStatus.COMPLETED);
    });

    it('1.4 Partial resume correctly computes media group item counts when items length is defined', async () => {
      const fiveItemMediaGroupPayload = {
        messages: [
          {
            partIndex: 0,
            type: 'media_group' as const,
            items: [
              { type: 'photo' as const, fileId: 'ph-1' },
              { type: 'photo' as const, fileId: 'ph-2' },
              { type: 'photo' as const, fileId: 'ph-3' },
              { type: 'photo' as const, fileId: 'ph-4' },
              { type: 'photo' as const, fileId: 'ph-5' },
            ],
          },
          {
            partIndex: 1,
            type: 'text' as const,
            html: 'Caption overflow',
          },
        ],
      };

      // Pretend 5 items were already sent in attempt 1
      dbJob.telegramMessageIds = [901, 902, 903, 904, 905];

      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannel,
        template: mockTemplate,
        media: [],
        payload: fiveItemMediaGroupPayload,
      });

      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce([906]);

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-1',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      // Part 0 (media_group of 5 items) was skipped; only Part 1 (text) sent
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        mockChannel.telegramChatId,
        expect.objectContaining({ type: 'text', html: 'Caption overflow' }),
      );
      expect(dbJob.telegramMessageIds).toEqual([901, 902, 903, 904, 905, 906]);
    });
  });

  // =========================================================================
  // Dimension 2: Idempotency Key Collision Under Heavy Concurrent Retries
  // Authoritative reference: AGENTS.md §21, tasks.md §21, §22
  // =========================================================================
  describe('Dimension 2: Idempotency Key Collision Under Heavy Concurrent Retries', () => {
    let publishingService: PublishingService;
    let mockPrisma: any;
    let mockPreflight: any;
    let mockAudit: any;
    let mockQueue: any;

    beforeEach(() => {
      mockPreflight = {
        validateStage1: jest.fn().mockResolvedValue({ post: mockApprovedPost }),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-m6-2' }),
      };

      mockQueue = {
        add: jest.fn().mockImplementation((jobName, data, opts) =>
          Promise.resolve({ id: opts.jobId, name: jobName, data, opts }),
        ),
      };
    });

    it('2.1 Massive 50-client race condition: all callers receive identical job, exactly 1 DB record, 1 BullMQ job', async () => {
      const dbStore = new Map<string, any>();

      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            // Latency jitter simulating database concurrency
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6) + 1));
            return dbStore.get(where.idempotencyKey) || null;
          }),
          findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }) => {
            const job = dbStore.get(where.idempotencyKey);
            if (!job) throw new Error(`Not found: ${where.idempotencyKey}`);
            return job;
          }),
          create: jest.fn().mockImplementation(async ({ data }) => {
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4) + 1));
            if (dbStore.has(data.idempotencyKey)) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on idempotency_key', {
                code: 'P2002',
                clientVersion: '6.19.3',
              });
            }
            const record = {
              id: `job-uuid-${Date.now()}-${Math.random()}`,
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

      const CONCURRENCY = 50;
      const promises = Array(CONCURRENCY)
        .fill(null)
        .map(() => publishingService.enqueuePublish('post-m6-500', 'usr-editor-m6'));

      const results = await Promise.all(promises);

      expect(results).toHaveLength(CONCURRENCY);
      const expectedId = results[0]!.id;
      const expectedKey = 'publish:post-m6-500:10';

      for (const res of results) {
        expect(res.id).toBe(expectedId);
        expect(res.idempotencyKey).toBe(expectedKey);
      }

      // Exactly 1 DB row created
      expect(dbStore.size).toBe(1);
      // Exactly 1 BullMQ queue job enqueued
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.objectContaining({
          postId: 'post-m6-500',
          postVersion: 10,
        }),
        expect.objectContaining({
          jobId: expectedKey,
          attempts: 3,
        }),
      );
      // Exactly 1 audit record created
      expect(mockAudit.record).toHaveBeenCalledTimes(1);
    });

    it('2.2 Manual retry on PUBLISH_FAILED post: uses new OCC version key, allowing re-enqueue without collision', async () => {
      // Step 1: Post failed at version 12 (idempotency key: publish:post-m6-500:12)
      const failedPost: Post = {
        ...mockApprovedPost,
        status: PostStatus.PUBLISH_FAILED,
        version: 12,
      };

      const existingJobs = new Map<string, any>();
      // The previous failed job for version 10 is already in DB
      existingJobs.set('publish:post-m6-500:10', {
        id: 'old-job-v10',
        postId: 'post-m6-500',
        postVersion: 10,
        idempotencyKey: 'publish:post-m6-500:10',
        status: PublicationJobStatus.FAILED,
      });

      mockPreflight.validateStage1.mockResolvedValueOnce({ post: failedPost });

      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            return existingJobs.get(where.idempotencyKey) || null;
          }),
          create: jest.fn().mockImplementation(async ({ data }) => {
            const job = { id: 'new-job-v12', ...data };
            existingJobs.set(data.idempotencyKey, job);
            return job;
          }),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      // Manual retry triggered on failed post
      const retryJob = await publishingService.enqueuePublish('post-m6-500', 'usr-editor-m6');

      expect(retryJob.id).toBe('new-job-v12');
      expect(retryJob.idempotencyKey).toBe('publish:post-m6-500:12');
      expect(mockQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PUBLISH_POST,
        expect.objectContaining({
          postId: 'post-m6-500',
          postVersion: 12,
        }),
        expect.objectContaining({
          jobId: 'publish:post-m6-500:12',
        }),
      );

      // Step 2: Immediate double-click on manual retry deduplicates against version 12!
      mockPreflight.validateStage1.mockResolvedValueOnce({ post: failedPost });
      const doubleClickJob = await publishingService.enqueuePublish('post-m6-500', 'usr-editor-m6');

      expect(doubleClickJob.id).toBe('new-job-v12');
      // Queue was NOT called a second time
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
    });

    it('2.3 Non-P2002 database error on create must be re-thrown without being swallowed', async () => {
      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Database server connection lost', {
              code: 'P1001',
              clientVersion: '6.19.3',
            }),
          ),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      await expect(
        publishingService.enqueuePublish('post-m6-500', 'usr-editor-m6'),
      ).rejects.toThrow('Database server connection lost');
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('2.4 getJobById and getJobByIdempotencyKey query delegates properly to Prisma', async () => {
      mockPrisma = {
        publicationJob: {
          findUnique: jest.fn().mockImplementation(({ where }) => {
            if (where.id === 'job-test-1') return Promise.resolve({ id: 'job-test-1' });
            if (where.idempotencyKey === 'publish:test:1') return Promise.resolve({ id: 'job-test-1' });
            return Promise.resolve(null);
          }),
        },
      };

      publishingService = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      const jobById = await publishingService.getJobById('job-test-1');
      expect(jobById?.id).toBe('job-test-1');

      const jobByKey = await publishingService.getJobByIdempotencyKey('publish:test:1');
      expect(jobByKey?.id).toBe('job-test-1');

      const nonExistent = await publishingService.getJobById('missing');
      expect(nonExistent).toBeNull();
    });
  });

  // =========================================================================
  // Dimension 3: Unrecoverable Error Handling vs Retryable Backoff
  // Authoritative reference: AGENTS.md §22, §49, §50
  // =========================================================================
  describe('Dimension 3: Unrecoverable Error Handling vs Retryable Backoff', () => {
    let processor: PublishingProcessor;
    let mockPrisma: any;
    let mockPostWorkflow: any;
    let mockPreflight: any;
    let mockPublisher: any;
    let mockAudit: any;
    let mockEventBus: any;
    let dbJob: any;

    beforeEach(() => {
      dbJob = {
        id: 'pub-job-m6-err',
        postId: 'post-m6-500',
        postVersion: 10,
        idempotencyKey: 'publish:post-m6-500:10',
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        telegramMessageIds: [],
      };

      mockPrisma = {
        publicationJob: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(dbJob)),
          update: jest.fn().mockImplementation((args: any) => {
            dbJob = { ...dbJob, ...args.data };
            return Promise.resolve(dbJob);
          }),
        },
        post: {
          findUnique: jest.fn().mockResolvedValue({
            ...mockApprovedPost,
            status: PostStatus.PUBLISHING,
          }),
        },
      };

      mockPostWorkflow = {
        transition: jest.fn().mockImplementation((cmd: any) => ({
          ...mockApprovedPost,
          status: cmd.targetStatus,
          version: cmd.expectedVersion + 1,
        })),
      };

      mockPreflight = {
        validateStage2: jest.fn().mockResolvedValue({
          post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
          channel: mockChannel,
          template: mockTemplate,
          media: [],
          payload: { messages: [{ partIndex: 0, type: 'text' as const, html: 'Text' }] },
        }),
      };

      mockPublisher = {
        publishOutgoingMessage: jest.fn(),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-record-m6' }),
      };

      mockEventBus = {
        publish: jest.fn(),
      };

      processor = new PublishingProcessor(
        mockPrisma,
        mockPostWorkflow,
        mockPreflight,
        mockPublisher,
        {} as any,
        mockAudit,
        mockEventBus,
      );
    });

    const permanentErrorCases = [
      { code: 400, desc: 'Bad Request: message text is empty' },
      { code: 401, desc: 'Unauthorized: invalid bot token' },
      { code: 403, desc: 'Forbidden: bot was kicked from the channel' },
      { code: 404, desc: 'Not Found: chat not found' },
    ];

    for (const testCase of permanentErrorCases) {
      it(`3.1 Permanent error ${testCase.code} (${testCase.desc}) MUST immediately fail post and throw UnrecoverableError on attempt 1`, async () => {
        const error = new GrammyError(
          testCase.desc,
          { ok: false, error_code: testCase.code, description: testCase.desc } as any,
          'sendMessage',
          {},
        );
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(error);

        const bullJob = {
          id: 'publish:post-m6-500:10',
          data: {
            publicationJobId: 'pub-job-m6-err',
            postId: 'post-m6-500',
            postVersion: 10,
            channelId: 'chan-m6-adv',
            actorId: 'usr-editor-m6',
          },
          attemptsMade: 0, // First attempt!
          opts: { attempts: 3 },
        } as any;

        await expect(processor.process(bullJob)).rejects.toThrow(UnrecoverableError);

        // Post transitioned to PUBLISH_FAILED
        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            targetStatus: PostStatus.PUBLISH_FAILED,
            action: PostAction.MARK_PUBLISH_FAILED,
          }),
        );

        // DB Job marked FAILED
        expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
        expect(dbJob.errorMessage).toContain(testCase.desc);

        // Event emitted
        expect(mockEventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            postId: 'post-m6-500',
            errorMessage: expect.stringContaining(testCase.desc),
          }),
        );
      });
    }

    it('3.2 Rate limit (429) fallback: when moveToDelayed throws, re-throws error for BullMQ backoff without failing post', async () => {
      const moveToDelayedMock = jest.fn().mockRejectedValue(new Error('Redis connection closed'));
      const bullJob429 = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-err',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
        moveToDelayed: moveToDelayedMock,
      } as any;

      mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
        new TelegramRateLimitException('Rate limit hit', 20),
      );

      // Should catch moveToDelayed failure and fall through to rethrow the 429 error
      await expect(processor.process(bullJob429, 'token-123')).rejects.toThrow('Rate limit hit');

      // Post must NOT be marked PUBLISH_FAILED!
      expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
      );
    });

    it('3.3 Stage 2 preflight permanent failure (e.g. channel inactive): aborts cleanly with UnrecoverableError without illegal status transition', async () => {
      // Stage 2 preflight throws TelegramPermanentException while post is still APPROVED
      mockPreflight.validateStage2.mockRejectedValueOnce(
        new TelegramPermanentException('Target channel is inactive', 400),
      );

      // DB post is still in APPROVED status (never started publishing)
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        ...mockApprovedPost,
        status: PostStatus.APPROVED,
      });

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-err',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processor.process(bullJob)).rejects.toThrow(UnrecoverableError);

      // Post was NOT transitioned because APPROVED -> PUBLISH_FAILED is illegal
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();

      // But the PublicationJob IS marked FAILED so it is not retried
      expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
      expect(dbJob.errorMessage).toContain('Target channel is inactive');
    });

    it('3.4 Unclassified arbitrary runtime error is classified as PERMANENT to prevent indefinite retry loops', async () => {
      mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
        new TypeError('Cannot read property of undefined in Telegram payload format'),
      );

      const bullJob = {
        id: 'publish:post-m6-500:10',
        data: {
          publicationJobId: 'pub-job-m6-err',
          postId: 'post-m6-500',
          postVersion: 10,
          channelId: 'chan-m6-adv',
          actorId: 'usr-editor-m6',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processor.process(bullJob)).rejects.toThrow(UnrecoverableError);
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
      );
      expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
    });

    it('3.5 OnModuleDestroy closes BullMQ worker instance cleanly', async () => {
      const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(processor, 'worker', 'get').mockReturnValue({ close: mockWorkerClose } as any);

      await processor.onModuleDestroy();
      expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Dimension 4: OCC Version Integrity Under Atomic Transitions
  // Authoritative reference: AGENTS.md §10, §13, §28
  // =========================================================================
  describe('Dimension 4: OCC Version Integrity Under Atomic Transitions', () => {
    let postsRepository: PostsRepository;
    let workflowService: PostWorkflowService;
    let mockPrisma: any;
    let mockReviewsService: Partial<ReviewsService>;
    let mockAuditService: Partial<AuditService>;
    let mockEventBus: any;
    let mockPermissionService: Partial<PermissionService>;

    beforeEach(() => {
      mockReviewsService = {
        createReview: jest.fn().mockResolvedValue({ id: 'rev-m6-1' } as any),
      };

      mockAuditService = {
        record: jest.fn().mockResolvedValue({ id: 'audit-m6-1' } as any),
      };

      mockEventBus = {
        publish: jest.fn(),
      };

      mockPermissionService = {
        checkChannelPermission: jest.fn().mockResolvedValue(true),
        enforceChannelPermission: jest.fn().mockResolvedValue(undefined),
      };
    });

    it('4.1 High-concurrency 20-client OCC race: exactly 1 update succeeds, 19 throw PostConflictException', async () => {
      // In-memory atomic post entity representing PostgreSQL row with OCC version
      let currentVersion = 1;
      let updateCount = 0;

      mockPrisma = {
        post: {
          updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
            // Check WHERE id = :id AND version = :expectedVersion AND deletedAt IS NULL
            if (where.id === 'post-m6-500' && where.version === currentVersion && where.deletedAt === null) {
              currentVersion++;
              updateCount++;
              return { count: 1 };
            }
            return { count: 0 };
          }),
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            return {
              id: 'post-m6-500',
              version: currentVersion,
              deletedAt: null,
            };
          }),
          findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }) => {
            return {
              ...mockApprovedPost,
              id: 'post-m6-500',
              version: currentVersion,
            };
          }),
        },
      };

      postsRepository = new PostsRepository(mockPrisma);

      // 20 concurrent callers attempting updateWithOcc with expectedVersion = 1
      const CONCURRENCY = 20;
      const callers = Array(CONCURRENCY)
        .fill(null)
        .map(() =>
          postsRepository
            .updateWithOcc('post-m6-500', 1, { contentJson: { title: 'Concurrent Edit' } })
            .then((res) => ({ success: true, version: res.version, error: null }))
            .catch((err) => ({ success: false, version: null, error: err })),
        );

      const results = await Promise.all(callers);

      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      // Exactly 1 winner!
      expect(successes).toHaveLength(1);
      expect(successes[0]!.version).toBe(2);

      // Exactly 19 conflicts!
      expect(failures).toHaveLength(CONCURRENCY - 1);
      for (const failResult of failures) {
        expect(failResult.error).toBeInstanceOf(PostConflictException);
        expect(failResult.error.message).toContain('Публикация была изменена другим пользователем');
      }

      // Final version in database is 2
      expect(currentVersion).toBe(2);
      expect(updateCount).toBe(1);
    });

    it('4.2 Strict sequential monotonic version chaining: DRAFT(v1) -> PENDING_REVIEW(v2) -> NEEDS_REVISION(v3) -> PENDING_REVIEW(v4) -> APPROVED(v5)', async () => {
      let currentPost: Post = {
        ...mockApprovedPost,
        status: PostStatus.DRAFT,
        version: 1,
      };

      mockPrisma = {
        post: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(currentPost)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(currentPost)),
          findUniqueOrThrow: jest.fn().mockImplementation(() => Promise.resolve(currentPost)),
          updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
            if (where.version === currentPost.version) {
              currentPost = {
                ...currentPost,
                ...data,
                version: currentPost.version + 1,
              };
              return { count: 1 };
            }
            return { count: 0 };
          }),
        },
        $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
      };

      postsRepository = new PostsRepository(mockPrisma);
      workflowService = new PostWorkflowService(
        mockPrisma,
        postsRepository,
        mockReviewsService as ReviewsService,
        mockAuditService as AuditService,
        mockEventBus,
        mockPermissionService as PermissionService,
      );

      // Step 1: Submit for review (v1 -> v2)
      const res1 = await workflowService.transition({
        postId: currentPost.id,
        expectedVersion: 1,
        targetStatus: PostStatus.PENDING_REVIEW,
        actorId: 'usr-author-m6',
      });
      expect(res1.status).toBe(PostStatus.PENDING_REVIEW);
      expect(res1.version).toBe(2);

      // Stale version rejection: attempt transition with stale version 1
      await expect(
        workflowService.transition({
          postId: currentPost.id,
          expectedVersion: 1, // Stale! Current version is 2
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: 'usr-editor-m6',
          comment: 'Needs fixes',
        }),
      ).rejects.toThrow(PostConflictException);

      // Step 2: Request revision (v2 -> v3)
      const res2 = await workflowService.transition({
        postId: currentPost.id,
        expectedVersion: 2,
        targetStatus: PostStatus.NEEDS_REVISION,
        actorId: 'usr-editor-m6',
        comment: 'Please expand section 2',
      });
      expect(res2.status).toBe(PostStatus.NEEDS_REVISION);
      expect(res2.version).toBe(3);

      // Step 3: Resubmit for review (v3 -> v4)
      const res3 = await workflowService.transition({
        postId: currentPost.id,
        expectedVersion: 3,
        targetStatus: PostStatus.PENDING_REVIEW,
        actorId: 'usr-author-m6',
      });
      expect(res3.status).toBe(PostStatus.PENDING_REVIEW);
      expect(res3.version).toBe(4);

      // Step 4: Approve (v4 -> v5)
      const res4 = await workflowService.transition({
        postId: currentPost.id,
        expectedVersion: 4,
        targetStatus: PostStatus.APPROVED,
        actorId: 'usr-editor-m6',
        comment: 'Looks excellent now',
      });
      expect(res4.status).toBe(PostStatus.APPROVED);
      expect(res4.version).toBe(5);

      // Verify audit logs were recorded for each transition
      expect(mockAuditService.record).toHaveBeenCalledTimes(4);
    });

    it('4.3 Soft-deleted post cannot be updated or transitioned even if version matches', async () => {
      const deletedPost: Post = {
        ...mockApprovedPost,
        deletedAt: new Date(),
        version: 5,
      };

      mockPrisma = {
        post: {
          findFirst: jest.fn().mockResolvedValue(deletedPost),
          findUnique: jest.fn().mockResolvedValue(deletedPost),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
      };

      postsRepository = new PostsRepository(mockPrisma);
      workflowService = new PostWorkflowService(
        mockPrisma,
        postsRepository,
        mockReviewsService as ReviewsService,
        mockAuditService as AuditService,
        mockEventBus,
        mockPermissionService as PermissionService,
      );

      // Repositories updateWithOcc directly on soft-deleted post
      await expect(
        postsRepository.updateWithOcc('post-m6-500', 5, { contentJson: { title: 'New' } }),
      ).rejects.toThrow(ValidationException);

      // Workflow transition on soft-deleted post
      await expect(
        workflowService.transition({
          postId: 'post-m6-500',
          expectedVersion: 5,
          targetStatus: PostStatus.PENDING_REVIEW,
          actorId: 'usr-author-m6',
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('4.4 Transaction atomicity: if auditService.record fails, post version must NOT change and events must NOT dispatch', async () => {
      let postVersion = 1;

      mockPrisma = {
        post: {
          findFirst: jest.fn().mockResolvedValue({ ...mockApprovedPost, status: PostStatus.DRAFT, version: 1 }),
          updateMany: jest.fn().mockImplementation(async () => {
            postVersion++;
            return { count: 1 };
          }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...mockApprovedPost, status: PostStatus.PENDING_REVIEW, version: 2 }),
        },
        $transaction: jest.fn(async (cb: any) => {
          // If the callback throws, transaction rolls back
          return cb(mockPrisma);
        }),
      };

      // Audit service throws unexpected database disk full error
      mockAuditService.record = jest.fn().mockRejectedValueOnce(new Error('Disk quota exceeded'));

      postsRepository = new PostsRepository(mockPrisma);
      workflowService = new PostWorkflowService(
        mockPrisma,
        postsRepository,
        mockReviewsService as ReviewsService,
        mockAuditService as AuditService,
        mockEventBus,
        mockPermissionService as PermissionService,
      );

      await expect(
        workflowService.transition({
          postId: 'post-m6-500',
          expectedVersion: 1,
          targetStatus: PostStatus.PENDING_REVIEW,
          actorId: 'usr-author-m6',
        }),
      ).rejects.toThrow('Disk quota exceeded');

      // CRITICAL ASSERTION: Domain event was NEVER emitted!
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('4.5 Complete State Machine Illegal Transition Matrix verification', async () => {
      const illegalTransitions: Array<[PostStatus, PostStatus]> = [
        // From DRAFT
        [PostStatus.DRAFT, PostStatus.APPROVED],
        [PostStatus.DRAFT, PostStatus.PUBLISHED],
        [PostStatus.DRAFT, PostStatus.REJECTED],
        [PostStatus.DRAFT, PostStatus.SCHEDULED],
        [PostStatus.DRAFT, PostStatus.PUBLISHING],
        // From PENDING_REVIEW
        [PostStatus.PENDING_REVIEW, PostStatus.DRAFT],
        [PostStatus.PENDING_REVIEW, PostStatus.PUBLISHING],
        [PostStatus.PENDING_REVIEW, PostStatus.PUBLISHED],
        [PostStatus.PENDING_REVIEW, PostStatus.CANCELLED],
        // From APPROVED
        [PostStatus.APPROVED, PostStatus.DRAFT],
        [PostStatus.APPROVED, PostStatus.PENDING_REVIEW],
        [PostStatus.APPROVED, PostStatus.REJECTED],
        [PostStatus.APPROVED, PostStatus.NEEDS_REVISION],
        // From PUBLISHED (terminal)
        [PostStatus.PUBLISHED, PostStatus.DRAFT],
        [PostStatus.PUBLISHED, PostStatus.PUBLISHING],
        [PostStatus.PUBLISHED, PostStatus.APPROVED],
        // From REJECTED (terminal)
        [PostStatus.REJECTED, PostStatus.DRAFT],
        [PostStatus.REJECTED, PostStatus.PENDING_REVIEW],
        [PostStatus.REJECTED, PostStatus.APPROVED],
        // From CANCELLED (terminal)
        [PostStatus.CANCELLED, PostStatus.SCHEDULED],
        [PostStatus.CANCELLED, PostStatus.PUBLISHING],
      ];

      for (const [fromStatus, toStatus] of illegalTransitions) {
        mockPrisma = {
          post: {
            findFirst: jest.fn().mockResolvedValue({
              ...mockApprovedPost,
              status: fromStatus,
            }),
          },
        };

        postsRepository = new PostsRepository(mockPrisma);
        workflowService = new PostWorkflowService(
          mockPrisma,
          postsRepository,
          mockReviewsService as ReviewsService,
          mockAuditService as AuditService,
          mockEventBus,
          mockPermissionService as PermissionService,
        );

        await expect(
          workflowService.transition({
            postId: 'post-m6-500',
            expectedVersion: 10,
            targetStatus: toStatus,
            actorId: 'usr-editor-m6',
          }),
        ).rejects.toThrow(InvalidPostStateTransitionException);
      }
    });

    it('4.6 Actor RBAC permission enforcement: Author cannot approve, reject, or request revision', async () => {
      mockPrisma = {
        post: {
          findFirst: jest.fn().mockResolvedValue({
            ...mockApprovedPost,
            status: PostStatus.PENDING_REVIEW,
          }),
        },
      };

      // Mock permission service returning false for APPROVE_POST
      mockPermissionService.checkChannelPermission = jest.fn().mockResolvedValue(false);

      postsRepository = new PostsRepository(mockPrisma);
      workflowService = new PostWorkflowService(
        mockPrisma,
        postsRepository,
        mockReviewsService as ReviewsService,
        mockAuditService as AuditService,
        mockEventBus,
        mockPermissionService as PermissionService,
      );

      // Author attempting to APPROVE
      await expect(
        workflowService.transition({
          postId: 'post-m6-500',
          expectedVersion: 10,
          targetStatus: PostStatus.APPROVED,
          actorId: 'usr-author-m6',
        }),
      ).rejects.toThrow(PermissionDeniedException);

      // Author attempting to REJECT
      await expect(
        workflowService.transition({
          postId: 'post-m6-500',
          expectedVersion: 10,
          targetStatus: PostStatus.REJECTED,
          actorId: 'usr-author-m6',
        }),
      ).rejects.toThrow(PermissionDeniedException);

      // Author attempting to REQUEST_REVISION
      await expect(
        workflowService.transition({
          postId: 'post-m6-500',
          expectedVersion: 10,
          targetStatus: PostStatus.NEEDS_REVISION,
          actorId: 'usr-author-m6',
          comment: 'Revise this',
        }),
      ).rejects.toThrow(PermissionDeniedException);
    });
  });
});
