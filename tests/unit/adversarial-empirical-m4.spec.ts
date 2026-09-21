import 'reflect-metadata';
import { PostStatus, PublicationJobStatus, Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PublishingProcessor } from '../../src/modules/publishing/publishing.processor';
import { PublishingService } from '../../src/modules/publishing/publishing.service';
import { PublishingPreflightService } from '../../src/modules/publishing/publishing-preflight.service';
import { SchedulingService } from '../../src/modules/scheduling/scheduling.service';
import { TelegramErrorClassifier } from '../../src/infrastructure/telegram-api/errors/telegram-error.classifier';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../src/infrastructure/telegram-api/errors/telegram-api.exceptions';
import { TelegramErrorCategory } from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import {
  parseAndValidateScheduledDate,
  formatChannelDate,
  DEFAULT_CHANNEL_TIMEZONE,
} from '../../src/modules/channels/utils/timezone.util';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
} from '../../src/common/exceptions/domain.exceptions';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import { JOB_NAMES } from '../../src/common/constants/queue-names';
import { GrammyError } from 'grammy';

describe('Milestone 4 Adversarial & Empirical Challenge Suite (m4_challenger_2)', () => {
  const mockChannelKyiv = {
    id: 'chan-kyiv',
    title: 'Kyiv News Channel',
    telegramChatId: '-1009876543210',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const mockChannelNY = {
    id: 'chan-ny',
    title: 'New York Channel',
    telegramChatId: '-1001122334455',
    timezone: 'America/New_York',
    isActive: true,
  };

  const mockTemplate = {
    id: 'tmpl-digest',
    key: 'digest',
    name: 'Digest Template',
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
    id: 'post-adv-400',
    channelId: 'chan-kyiv',
    authorId: 'author-uuid-1',
    templateId: 'tmpl-digest',
    status: PostStatus.APPROVED,
    version: 5,
    contentJson: { title: 'Adversarial Post Title', body: 'Deep adversarial payload body' },
    metadataJson: {},
    deletedAt: null,
    channel: mockChannelKyiv,
    template: mockTemplate,
    media: [],
  };

  // =========================================================================
  // Dimension 1: Partial Publication Resume Verification (AGENTS.md §23)
  // =========================================================================
  describe('Dimension 1: Partial Publication Resume Verification (AGENTS.md §23, tasks.md §23)', () => {
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
        id: 'pub-job-adv-1',
        postId: 'post-adv-400',
        postVersion: 5,
        idempotencyKey: 'publish:post-adv-400:5',
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
        validateStage2: jest.fn().mockResolvedValue({
          post: mockApprovedPost,
          channel: mockChannelKyiv,
          template: mockTemplate,
          media: [],
          payload: {
            messages: [
              {
                partIndex: 0,
                type: 'media_group' as const,
                items: [
                  { type: 'photo' as const, fileId: 'photo-1' },
                  { type: 'photo' as const, fileId: 'photo-2' },
                  { type: 'photo' as const, fileId: 'photo-3' },
                ],
              },
              {
                partIndex: 1,
                type: 'text' as const,
                html: 'Overflow text after 3-photo media group',
              },
            ],
          },
        }),
      };

      mockPublisher = {
        publishOutgoingMessage: jest.fn(),
      };

      mockRenderer = {
        render: jest.fn(),
      };

      mockAudit = {
        record: jest.fn().mockResolvedValue({ id: 'audit-record-1' }),
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

    it('1.1 should safely resume on retry after text failure: skip media group, publish text only, and record all message IDs', async () => {
      // ATTEMPT 1: Media group succeeds [2001, 2002, 2003], but second message (text) throws ECONNRESET network failure
      mockPublisher.publishOutgoingMessage
        .mockResolvedValueOnce([2001, 2002, 2003]) // Part 0: media group
        .mockRejectedValueOnce(new Error('read ECONNRESET')); // Part 1: text failure

      const bullJobAttempt1 = {
        id: 'publish:post-adv-400:5',
        data: {
          publicationJobId: 'pub-job-adv-1',
          postId: 'post-adv-400',
          postVersion: 5,
          channelId: 'chan-kyiv',
          actorId: 'editor-adv-1',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      // Attempt 1 must fail and throw retryable error for BullMQ
      await expect(processor.process(bullJobAttempt1)).rejects.toThrow('read ECONNRESET');

      // Verify DB state after Attempt 1 failure:
      // Media group IDs [2001, 2002, 2003] must be durably stored in PostgreSQL!
      expect(dbJob.telegramMessageIds).toEqual([2001, 2002, 2003]);
      expect(dbJob.attempts).toBe(1);

      // Verify post has NOT been marked as PUBLISH_FAILED yet
      expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
      );

      // ATTEMPT 2 (Retry):
      // Worker restarts job with attemptsMade: 1
      // Preflight returns post which is already in PostStatus.PUBLISHING
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannelKyiv,
        template: mockTemplate,
        media: [],
        payload: {
          messages: [
            {
              partIndex: 0,
              type: 'media_group' as const,
              items: [
                { type: 'photo' as const, fileId: 'photo-1' },
                { type: 'photo' as const, fileId: 'photo-2' },
                { type: 'photo' as const, fileId: 'photo-3' },
              ],
            },
            {
              partIndex: 1,
              type: 'text' as const,
              html: 'Overflow text after 3-photo media group',
            },
          ],
        },
      });

      // Clear publisher mock calls and configure Part 1 (text) to succeed on retry with [2004]
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce([2004]);

      const bullJobAttempt2 = {
        ...bullJobAttempt1,
        attemptsMade: 1,
      };

      await processor.process(bullJobAttempt2);

      // CRITICAL ASSERTION: The publisher was called EXACTLY ONCE on retry!
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(1);

      // CRITICAL ASSERTION: The message sent was the TEXT part, NOT the media group!
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '-1009876543210',
        expect.objectContaining({
          type: 'text',
          html: 'Overflow text after 3-photo media group',
        }),
      );

      // CRITICAL ASSERTION: All message IDs must be merged in order [2001, 2002, 2003, 2004]
      expect(dbJob.telegramMessageIds).toEqual([2001, 2002, 2003, 2004]);
      expect(dbJob.status).toBe(PublicationJobStatus.COMPLETED);

      // CRITICAL ASSERTION: Post transitioned to PUBLISHED
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStatus: PostStatus.PUBLISHED,
          action: PostAction.MARK_PUBLISHED,
        }),
      );

      // CRITICAL ASSERTION: PostPublishedEvent dispatched with all 4 IDs
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-adv-400',
          telegramMessageIds: [2001, 2002, 2003, 2004],
        }),
      );
    });

    it('1.2 should safely handle 3-part publication cascading failure and recovery across multiple attempts', async () => {
      // 3 parts: Part 0 (media_group 2 items), Part 1 (text chunk 1), Part 2 (text chunk 2)
      const threePartPayload = {
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
            html: 'Part 1 text chunk',
          },
          {
            partIndex: 2,
            type: 'text' as const,
            html: 'Part 2 text chunk',
          },
        ],
      };

      mockPreflight.validateStage2.mockResolvedValue({
        post: mockApprovedPost,
        channel: mockChannelKyiv,
        template: mockTemplate,
        media: [],
        payload: threePartPayload,
      });

      const bullJob = {
        id: 'publish:post-adv-400:5',
        data: {
          publicationJobId: 'pub-job-adv-1',
          postId: 'post-adv-400',
          postVersion: 5,
          channelId: 'chan-kyiv',
          actorId: 'editor-adv-1',
        },
        attemptsMade: 0,
        opts: { attempts: 4 },
      } as any;

      // ATTEMPT 1: Part 0 succeeds [3001, 3002], Part 1 fails (500)
      mockPublisher.publishOutgoingMessage
        .mockResolvedValueOnce([3001, 3002])
        .mockRejectedValueOnce(new TelegramRetryableException('500 Internal Server Error'));

      await expect(processor.process({ ...bullJob, attemptsMade: 0 })).rejects.toThrow();
      expect(dbJob.telegramMessageIds).toEqual([3001, 3002]);

      // ATTEMPT 2: Part 0 skipped, Part 1 succeeds [3003], Part 2 fails (504)
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage
        .mockResolvedValueOnce([3003])
        .mockRejectedValueOnce(new TelegramRetryableException('504 Gateway Timeout'));

      await expect(processor.process({ ...bullJob, attemptsMade: 1 })).rejects.toThrow();
      expect(dbJob.telegramMessageIds).toEqual([3001, 3002, 3003]);

      // ATTEMPT 3: Part 0 skipped, Part 1 skipped, Part 2 succeeds [3004]
      mockPublisher.publishOutgoingMessage.mockReset();
      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce([3004]);

      await processor.process({ ...bullJob, attemptsMade: 2 });

      // Verifications:
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledTimes(1);
      expect(dbJob.telegramMessageIds).toEqual([3001, 3002, 3003, 3004]);
      expect(dbJob.status).toBe(PublicationJobStatus.COMPLETED);
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISHED }),
      );
    });

    it('1.3 should guard against redundant transition to PUBLISHING when already in PUBLISHING status', async () => {
      mockPreflight.validateStage2.mockResolvedValueOnce({
        post: { ...mockApprovedPost, status: PostStatus.PUBLISHING },
        channel: mockChannelKyiv,
        template: mockTemplate,
        media: [],
        payload: {
          messages: [{ partIndex: 0, type: 'text' as const, html: 'Single message' }],
        },
      });

      mockPublisher.publishOutgoingMessage.mockResolvedValueOnce([5001]);

      const bullJob = {
        id: 'publish:post-adv-400:5',
        data: {
          publicationJobId: 'pub-job-adv-1',
          postId: 'post-adv-400',
          postVersion: 5,
          channelId: 'chan-kyiv',
          actorId: 'editor-adv-1',
        },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      // Verify that transition with targetStatus = PUBLISHING was NOT invoked
      const transitionCalls = mockPostWorkflow.transition.mock.calls;
      const startPublishingCalls = transitionCalls.filter(
        (call: any[]) => call[0].targetStatus === PostStatus.PUBLISHING,
      );
      expect(startPublishingCalls.length).toBe(0);

      // Final transition to PUBLISHED must still occur
      expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
        expect.objectContaining({ targetStatus: PostStatus.PUBLISHED }),
      );
    });

    it('1.4 should immediately skip execution if PublicationJob is already COMPLETED', async () => {
      dbJob.status = PublicationJobStatus.COMPLETED;

      const bullJob = {
        id: 'publish:post-adv-400:5',
        data: {
          publicationJobId: 'pub-job-adv-1',
          postId: 'post-adv-400',
          postVersion: 5,
          channelId: 'chan-kyiv',
          actorId: 'editor-adv-1',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      expect(mockPublisher.publishOutgoingMessage).not.toHaveBeenCalled();
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
      expect(mockPreflight.validateStage2).not.toHaveBeenCalled();
    });

    it('1.5 should immediately skip execution if PublicationJob is CANCELLED', async () => {
      dbJob.status = PublicationJobStatus.CANCELLED;

      const bullJob = {
        id: 'publish:post-adv-400:5',
        data: {
          publicationJobId: 'pub-job-adv-1',
          postId: 'post-adv-400',
          postVersion: 5,
          channelId: 'chan-kyiv',
          actorId: 'editor-adv-1',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await processor.process(bullJob);

      expect(mockPublisher.publishOutgoingMessage).not.toHaveBeenCalled();
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dimension 2: Error Backoff & Unrecoverable Error Handling (AGENTS.md §22, §49, §50)
  // =========================================================================
  describe('Dimension 2: Error Backoff & Unrecoverable Error Handling (AGENTS.md §22, §49, §50)', () => {
    describe('2.1 TelegramErrorClassifier Tri-Tier Classification & Retry Delay Parsing', () => {
      it('should correctly classify 429 RATE_LIMITED and extract retry_after from parameters', () => {
        const error = new GrammyError(
          'Too Many Requests: retry after 17',
          { ok: false, error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } } as any,
          'sendMessage',
          {},
        );

        const result = TelegramErrorClassifier.classify(error);
        expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
        expect(result.statusCode).toBe(429);
        expect(result.retryAfterSeconds).toBe(17);
        expect(result.isPermanent).toBe(false);
        expect(result.isRetryable).toBe(true);
      });

      it('should extract retry_after from description via regex fallback when parameters missing', () => {
        const error = new GrammyError(
          'Too Many Requests: retry after 42',
          { ok: false, error_code: 429, description: 'Too Many Requests: retry after 42' } as any,
          'sendMessage',
          {},
        );

        const result = TelegramErrorClassifier.classify(error);
        expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
        expect(result.retryAfterSeconds).toBe(42);
      });

      it('should classify TelegramRateLimitException typed domain exception', () => {
        const error = new TelegramRateLimitException('Rate limit exceeded', 25);
        const result = TelegramErrorClassifier.classify(error);
        expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
        expect(result.retryAfterSeconds).toBe(25);
        expect(result.statusCode).toBe(429);
      });

      it('should classify string/test double 429 errors', () => {
        const testDoubleErr = {
          statusCode: 429,
          retryAfter: 33,
          message: 'Simulated 429',
        };
        const result = TelegramErrorClassifier.classify(testDoubleErr);
        expect(result.category).toBe(TelegramErrorCategory.RATE_LIMITED);
        expect(result.retryAfterSeconds).toBe(33);

        const strResult = TelegramErrorClassifier.classify(new Error('Rate limited: retry after 55 seconds'));
        expect(strResult.category).toBe(TelegramErrorCategory.RATE_LIMITED);
        expect(strResult.retryAfterSeconds).toBe(55);
      });

      it('should classify 5xx and network socket errors as RETRYABLE', () => {
        const g502 = new GrammyError('Bad Gateway', { ok: false, error_code: 502, description: 'Bad Gateway' } as any, 'sendMessage', {});
        expect(TelegramErrorClassifier.classify(g502).category).toBe(TelegramErrorCategory.RETRYABLE);

        const netErr = new Error('connect ETIMEDOUT');
        expect(TelegramErrorClassifier.classify(netErr).category).toBe(TelegramErrorCategory.RETRYABLE);

        const socketErr = new Error('socket hang up');
        expect(TelegramErrorClassifier.classify(socketErr).category).toBe(TelegramErrorCategory.RETRYABLE);
      });

      it('should classify 400 Bad Request and 403 Forbidden as PERMANENT', () => {
        const g400 = new GrammyError('Bad Request: chat not found', { ok: false, error_code: 400, description: 'Bad Request: chat not found' } as any, 'sendMessage', {});
        const res400 = TelegramErrorClassifier.classify(g400);
        expect(res400.category).toBe(TelegramErrorCategory.PERMANENT);
        expect(res400.isPermanent).toBe(true);
        expect(res400.isRetryable).toBe(false);

        const g403 = new GrammyError('Forbidden: bot was kicked from channel', { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from channel' } as any, 'sendMessage', {});
        const res403 = TelegramErrorClassifier.classify(g403);
        expect(res403.category).toBe(TelegramErrorCategory.PERMANENT);
        expect(res403.isPermanent).toBe(true);
        expect(res403.isRetryable).toBe(false);
      });
    });

    describe('2.2 Worker Error Handling & Unrecoverable Failure Behavior', () => {
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
          id: 'pub-job-adv-2',
          postId: 'post-adv-400',
          postVersion: 5,
          idempotencyKey: 'publish:post-adv-400:5',
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
            channel: mockChannelKyiv,
            template: mockTemplate,
            media: [],
            payload: { messages: [{ partIndex: 0, type: 'text' as const, html: 'Text' }] },
          }),
        };

        mockPublisher = {
          publishOutgoingMessage: jest.fn(),
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
          {} as any,
          mockAudit,
          mockEventBus,
        );
      });

      it('should handle 429 RATE_LIMITED by calling moveToDelayed without marking post as failed', async () => {
        const moveToDelayedMock = jest.fn().mockResolvedValue(undefined);
        const bullJob429 = {
          id: 'publish:post-adv-400:5',
          data: {
            publicationJobId: 'pub-job-adv-2',
            postId: 'post-adv-400',
            postVersion: 5,
            channelId: 'chan-kyiv',
            actorId: 'editor-adv-1',
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
          moveToDelayed: moveToDelayedMock,
        } as any;

        // Publisher throws 429 with retryAfter = 14s
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
          new TelegramRateLimitException('Rate limit hit', 14),
        );

        const nowBefore = Date.now();
        await processor.process(bullJob429, 'token-lock-abc');

        // Verify moveToDelayed called with approximately now + 14000ms
        expect(moveToDelayedMock).toHaveBeenCalledTimes(1);
        const [delayedUntil, tokenPassed] = moveToDelayedMock.mock.calls[0];
        expect(tokenPassed).toBe('token-lock-abc');
        expect(delayedUntil).toBeGreaterThanOrEqual(nowBefore + 13500);
        expect(delayedUntil).toBeLessThanOrEqual(Date.now() + 14500);

        // Post must NOT be marked as failed
        expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
          expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
        );

        // Audit log must record attempt failure with RATE_LIMITED category
        expect(mockAudit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.PUBLICATION_ATTEMPT_FAILED,
            payload: expect.objectContaining({
              category: TelegramErrorCategory.RATE_LIMITED,
            }),
          }),
        );
      });

      it('should immediately fail post and throw UnrecoverableError on 400 Bad Request', async () => {
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
          new TelegramPermanentException('Bad Request: chat not found', 400),
        );

        const bullJob = {
          id: 'publish:post-adv-400:5',
          data: {
            publicationJobId: 'pub-job-adv-2',
            postId: 'post-adv-400',
            postVersion: 5,
            channelId: 'chan-kyiv',
            actorId: 'editor-adv-1',
          },
          attemptsMade: 0, // Attempt 1 of 3
          opts: { attempts: 3 },
        } as any;

        // MUST throw UnrecoverableError immediately without retrying
        await expect(processor.process(bullJob)).rejects.toThrow(UnrecoverableError);

        // Post MUST immediately transition to PUBLISH_FAILED
        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            targetStatus: PostStatus.PUBLISH_FAILED,
            action: PostAction.MARK_PUBLISH_FAILED,
          }),
        );

        // DB Job status MUST be FAILED
        expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
        expect(dbJob.errorMessage).toContain('Bad Request: chat not found');

        // PostPublicationFailedEvent MUST be dispatched
        expect(mockEventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            postId: 'post-adv-400',
          }),
        );
      });

      it('should immediately fail post and throw UnrecoverableError on 403 Forbidden (bot kicked)', async () => {
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
          new TelegramPermanentException('Forbidden: bot was kicked from the channel', 403),
        );

        const bullJob = {
          id: 'publish:post-adv-400:5',
          data: {
            publicationJobId: 'pub-job-adv-2',
            postId: 'post-adv-400',
            postVersion: 5,
            channelId: 'chan-kyiv',
            actorId: 'editor-adv-1',
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any;

        await expect(processor.process(bullJob)).rejects.toThrow(UnrecoverableError);

        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            targetStatus: PostStatus.PUBLISH_FAILED,
            action: PostAction.MARK_PUBLISH_FAILED,
          }),
        );
        expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
      });

      it('should rethrow transient error on attempts 1 and 2, but throw UnrecoverableError on attempt 3 (exhaustion)', async () => {
        const bullJob = {
          id: 'publish:post-adv-400:5',
          data: {
            publicationJobId: 'pub-job-adv-2',
            postId: 'post-adv-400',
            postVersion: 5,
            channelId: 'chan-kyiv',
            actorId: 'editor-adv-1',
          },
          opts: { attempts: 3 },
        } as any;

        // Attempt 1: attemptsMade = 0 -> transient 500 -> rethrown as retryable Error
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
          new TelegramRetryableException('500 Internal Error', 500),
        );
        await expect(processor.process({ ...bullJob, attemptsMade: 0 })).rejects.toThrow('500 Internal Error');
        expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
          expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
        );

        // Attempt 2: attemptsMade = 1 -> transient ETIMEDOUT -> rethrown as retryable Error
        mockPublisher.publishOutgoingMessage.mockReset();
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
        await expect(processor.process({ ...bullJob, attemptsMade: 1 })).rejects.toThrow('connect ETIMEDOUT');
        expect(mockPostWorkflow.transition).not.toHaveBeenCalledWith(
          expect.objectContaining({ targetStatus: PostStatus.PUBLISH_FAILED }),
        );

        // Attempt 3: attemptsMade = 2 (maxAttempts = 3) -> transient 504 -> EXHAUSTED!
        mockPublisher.publishOutgoingMessage.mockReset();
        mockPublisher.publishOutgoingMessage.mockRejectedValueOnce(
          new TelegramRetryableException('504 Gateway Timeout', 504),
        );

        await expect(processor.process({ ...bullJob, attemptsMade: 2 })).rejects.toThrow(UnrecoverableError);

        // Now post MUST be marked PUBLISH_FAILED!
        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            targetStatus: PostStatus.PUBLISH_FAILED,
            action: PostAction.MARK_PUBLISH_FAILED,
          }),
        );
        expect(dbJob.status).toBe(PublicationJobStatus.FAILED);
      });
    });
  });

  // =========================================================================
  // Dimension 3: Scheduling Stress (AGENTS.md §24, §47, tasks.md §6, §19)
  // =========================================================================
  describe('Dimension 3: Scheduling Stress (AGENTS.md §24, §47, tasks.md §6, §19)', () => {
    let schedulingService: SchedulingService;
    let mockPrisma: any;
    let mockPostWorkflow: any;
    let mockPreflight: any;
    let mockPermission: any;
    let mockQueue: any;

    beforeEach(() => {
      mockPrisma = {
        post: {
          findUnique: jest.fn().mockResolvedValue(mockApprovedPost),
        },
        publicationJob: {
          create: jest.fn().mockImplementation((args: any) => ({
            id: 'pub-job-sched-1',
            ...args.data,
          })),
          findFirst: jest.fn(),
          update: jest.fn().mockImplementation((args: any) => ({
            id: args.where.id,
            ...args.data,
          })),
        },
      };

      mockPostWorkflow = {
        transition: jest.fn().mockImplementation((cmd: any) => ({
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
        add: jest.fn().mockResolvedValue({ id: 'bull-job-sched-1' }),
        getJob: jest.fn(),
      };

      schedulingService = new SchedulingService(
        mockPrisma,
        mockPostWorkflow,
        mockPreflight,
        mockPermission,
        mockQueue,
      );
    });

    describe('3.1 Past Date Rejection & Validation Invariants', () => {
      it('should reject string date in the past with Russian ValidationException', async () => {
        const pastString = '21.09.2021 18:30';

        await expect(
          schedulingService.schedulePost('post-adv-400', pastString, 'editor-1'),
        ).rejects.toThrow(ValidationException);

        await expect(
          schedulingService.schedulePost('post-adv-400', pastString, 'editor-1'),
        ).rejects.toThrow('Нельзя планировать публикацию в прошлом.');

        expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
        expect(mockQueue.add).not.toHaveBeenCalled();
      });

      it('should reject Date object in the past or equal to now', async () => {
        const pastDate = new Date(Date.now() - 5000);
        await expect(
          schedulingService.schedulePost('post-adv-400', pastDate, 'editor-1'),
        ).rejects.toThrow('Нельзя планировать публикацию в прошлом.');

        const nowOrPast1ms = new Date(Date.now() - 1);
        await expect(
          schedulingService.schedulePost('post-adv-400', nowOrPast1ms, 'editor-1'),
        ).rejects.toThrow(ValidationException);
      });

      it('should reject invalid date format strings', () => {
        expect(() => parseAndValidateScheduledDate('invalid-date')).toThrow(ValidationException);
        expect(() => parseAndValidateScheduledDate('32.13.2028 25:99')).toThrow(ValidationException);
        expect(() => parseAndValidateScheduledDate('   ')).toThrow(ValidationException);
      });
    });

    describe('3.2 Timezone Conversions (Europe/Kyiv to UTC TIMESTAMPTZ)', () => {
      it('should convert Europe/Kyiv Summer Time (EEST, UTC+3) to correct UTC Date', () => {
        // July is Daylight Saving Time in Europe/Kyiv -> UTC+3
        // 15.07.2028 15:30 in Kyiv -> 12:30 UTC
        const date = parseAndValidateScheduledDate('15.07.2028 15:30', 'Europe/Kyiv', 0);
        expect(date.getUTCFullYear()).toBe(2028);
        expect(date.getUTCMonth()).toBe(6); // July (0-indexed: 6)
        expect(date.getUTCDate()).toBe(15);
        expect(date.getUTCHours()).toBe(12);
        expect(date.getUTCMinutes()).toBe(30);

        // Roundtrip check via formatChannelDate
        const formatted = formatChannelDate(date, 'Europe/Kyiv');
        expect(formatted).toBe('15.07.2028 15:30');
      });

      it('should convert Europe/Kyiv Winter Time (EET, UTC+2) to correct UTC Date', () => {
        // January is Standard Time in Europe/Kyiv -> UTC+2
        // 15.01.2028 15:30 in Kyiv -> 13:30 UTC
        const date = parseAndValidateScheduledDate('15.01.2028 15:30', 'Europe/Kyiv', 0);
        expect(date.getUTCFullYear()).toBe(2028);
        expect(date.getUTCMonth()).toBe(0); // January (0-indexed: 0)
        expect(date.getUTCDate()).toBe(15);
        expect(date.getUTCHours()).toBe(13);
        expect(date.getUTCMinutes()).toBe(30);

        const formatted = formatChannelDate(date, 'Europe/Kyiv');
        expect(formatted).toBe('15.01.2028 15:30');
      });

      it('should convert custom channel timezone (America/New_York) to correct UTC Date', () => {
        // January in America/New_York is EST (UTC-5)
        // 15.01.2028 15:30 EST -> 20:30 UTC
        const date = parseAndValidateScheduledDate('15.01.2028 15:30', 'America/New_York', 0);
        expect(date.getUTCHours()).toBe(20);
        expect(date.getUTCMinutes()).toBe(30);

        const formatted = formatChannelDate(date, 'America/New_York');
        expect(formatted).toBe('15.01.2028 15:30');
      });

      it('should schedule post with custom channel timezone and calculate positive delay', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockApprovedPost,
          channel: mockChannelNY,
        });

        const futureYear = new Date().getFullYear() + 2;
        const result = await schedulingService.schedulePost(
          'post-adv-400',
          `15.01.${futureYear} 15:30`,
          'editor-1',
        );

        expect(result.status).toBe(PostStatus.SCHEDULED);
        expect(mockQueue.add).toHaveBeenCalledWith(
          JOB_NAMES.PUBLISH_POST,
          expect.objectContaining({
            isScheduled: true,
            channelId: 'chan-kyiv',
          }),
          expect.objectContaining({
            delay: expect.any(Number),
            attempts: 3,
          }),
        );

        const queueCall = mockQueue.add.mock.calls[0];
        const delay = queueCall[2].delay;
        expect(delay).toBeGreaterThan(0);
      });
    });

    describe('3.3 Schedule Cancellation Lifecycle (F-38)', () => {
      const mockScheduledPost = {
        ...mockApprovedPost,
        status: PostStatus.SCHEDULED,
        version: 6,
      };

      beforeEach(() => {
        mockPrisma.post.findUnique.mockResolvedValue(mockScheduledPost);
      });

      it('should remove delayed BullMQ job, mark DB job CANCELLED, and transition post SCHEDULED -> CANCELLED', async () => {
        const mockBullJob = { remove: jest.fn().mockResolvedValue(undefined) };
        mockQueue.getJob.mockResolvedValue(mockBullJob);

        mockPrisma.publicationJob.findFirst.mockResolvedValue({
          id: 'pub-job-sched-1',
          postId: 'post-adv-400',
          status: PublicationJobStatus.PENDING,
        });

        const result = await schedulingService.cancelSchedule('post-adv-400', 'editor-1', 6);

        // Verify permission checked
        expect(mockPermission.checkChannelPermission).toHaveBeenCalledWith(
          'editor-1',
          'chan-kyiv',
          ChannelPermission.CANCEL_SCHEDULE,
        );

        // Verify BullMQ delayed job removed
        expect(mockQueue.getJob).toHaveBeenCalledWith('pub-job-sched-1');
        expect(mockBullJob.remove).toHaveBeenCalled();

        // Verify PostgreSQL publication job marked CANCELLED
        expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith({
          where: { id: 'pub-job-sched-1' },
          data: { status: PublicationJobStatus.CANCELLED },
        });

        // Verify post state transitioned to CANCELLED with OCC
        expect(mockPostWorkflow.transition).toHaveBeenCalledWith(
          expect.objectContaining({
            postId: 'post-adv-400',
            expectedVersion: 6,
            targetStatus: PostStatus.CANCELLED,
            action: PostAction.CANCEL,
            actorId: 'editor-1',
          }),
        );

        expect(result.status).toBe(PostStatus.CANCELLED);
      });

      it('should reject cancellation if actor lacks CANCEL_SCHEDULE permission', async () => {
        mockPermission.checkChannelPermission.mockResolvedValueOnce(false);

        await expect(
          schedulingService.cancelSchedule('post-adv-400', 'unauthorized-user'),
        ).rejects.toThrow(PermissionDeniedException);

        expect(mockQueue.getJob).not.toHaveBeenCalled();
        expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
      });

      it('should reject cancellation if post is not in SCHEDULED status (e.g. APPROVED or PUBLISHED)', async () => {
        mockPrisma.post.findUnique.mockResolvedValueOnce({
          ...mockScheduledPost,
          status: PostStatus.APPROVED,
        });

        await expect(
          schedulingService.cancelSchedule('post-adv-400', 'editor-1'),
        ).rejects.toThrow(InvalidPostStateTransitionException);
      });

      it('should handle missing BullMQ job gracefully when cancelling schedule', async () => {
        mockQueue.getJob.mockResolvedValueOnce(null); // job already vanished from Redis

        mockPrisma.publicationJob.findFirst.mockResolvedValueOnce({
          id: 'pub-job-sched-1',
          postId: 'post-adv-400',
          status: PublicationJobStatus.PENDING,
        });

        const result = await schedulingService.cancelSchedule('post-adv-400', 'editor-1');
        expect(result.status).toBe(PostStatus.CANCELLED);
        expect(mockPrisma.publicationJob.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { status: PublicationJobStatus.CANCELLED },
          }),
        );
      });
    });
  });
});
