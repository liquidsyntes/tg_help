import 'reflect-metadata';
import { PostStatus, PublicationJobStatus, Prisma } from '@prisma/client';
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

interface StressResult {
  category: string;
  testName: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  metrics?: Record<string, unknown>;
}

const allResults: StressResult[] = [];

async function executeStressTest(
  category: string,
  testName: string,
  fn: () => Promise<Record<string, unknown> | void>,
) {
  const t0 = Date.now();
  try {
    const metrics = await fn();
    const durationMs = Date.now() - t0;
    allResults.push({
      category,
      testName,
      passed: true,
      durationMs,
      metrics: metrics || undefined,
    });
    console.log(`  [PASS] ${testName} (${durationMs}ms)`);
    if (metrics) {
      console.log(`         Metrics: ${JSON.stringify(metrics)}`);
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    allResults.push({
      category,
      testName,
      passed: false,
      durationMs,
      error: errorMsg,
    });
    console.error(`  [FAIL] ${testName} (${durationMs}ms)`);
    console.error(`         ${errorMsg}\n`);
  }
}

async function runM4EmpiricalHarness() {
  console.log('================================================================================');
  console.log('EMPIRICAL CHALLENGER: Milestone 4 Publishing Idempotency & Preflight Stress Harness');
  console.log('================================================================================\n');

  const mockChannel = {
    id: 'chan-stress-1',
    title: 'Stress Test Channel',
    telegramChatId: '-100999888777',
    timezone: 'Europe/Kyiv',
    isActive: true,
  };

  const mockTemplate = {
    id: 'tmpl-stress-1',
    key: 'stress_tmpl',
    name: 'Stress Template',
    schemaJson: {
      fields: [
        { key: 'title', type: 'text', required: true, maxLength: 120 },
        { key: 'body', type: 'rich_text', required: true, maxLength: 3000 },
      ],
    },
    renderConfig: {},
    supportedMediaTypes: ['photo', 'video'],
    isActive: true,
  };

  const baseApprovedPost = {
    id: 'post-stress-999',
    channelId: 'chan-stress-1',
    authorId: 'usr-author-99',
    templateId: 'tmpl-stress-1',
    status: PostStatus.APPROVED,
    version: 7,
    contentJson: {
      title: 'Breaking Stress News',
      body: 'High-throughput empirical test payload under adversarial load.',
    },
    metadataJson: {},
    deletedAt: null,
    channel: mockChannel,
    template: mockTemplate,
    media: [],
  };

  // ---------------------------------------------------------------------------
  // Category 1: Concurrency & Idempotency Stress
  // ---------------------------------------------------------------------------
  console.log('>>> Category 1: Concurrency & Idempotency Stress');

  await executeStressTest(
    'Concurrency & Idempotency',
    '1.1 100 Simultaneous Concurrent Publish Requests (Double-Click Flooding)',
    async () => {
      const dbStore = new Map<string, any>();
      const queueJobs: any[] = [];
      const auditRecords: any[] = [];

      const mockPrisma: any = {
        publicationJob: {
          findUnique: async ({ where }: any) => {
            // Simulated network latency to cause interleaving
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10) + 1));
            return dbStore.get(where.idempotencyKey) || null;
          },
          findUniqueOrThrow: async ({ where }: any) => {
            const r = dbStore.get(where.idempotencyKey);
            if (!r) throw new Error(`Not found: ${where.idempotencyKey}`);
            return r;
          },
          create: async ({ data }: any) => {
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8) + 1));
            if (dbStore.has(data.idempotencyKey)) {
              throw new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed on the fields: (idempotency_key)',
                { code: 'P2002', clientVersion: '6.19.3' },
              );
            }
            const record = {
              id: `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            dbStore.set(data.idempotencyKey, record);
            return record;
          },
        },
      };

      const mockPreflight: any = {
        validateStage1: async () => ({ post: baseApprovedPost }),
      };

      const mockAudit: any = {
        record: async (rec: any) => {
          auditRecords.push(rec);
          return { id: `audit-${auditRecords.length}` };
        },
      };

      const mockQueue: any = {
        add: async (name: string, data: any, opts: any) => {
          queueJobs.push({ name, data, opts });
          return { id: opts.jobId };
        },
      };

      const service = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      const CONCURRENCY = 100;
      const promises = Array.from({ length: CONCURRENCY }, () =>
        service.enqueuePublish('post-stress-999', 'usr-editor-99'),
      );

      const results = await Promise.all(promises);

      if (results.length !== CONCURRENCY) {
        throw new Error(`Expected ${CONCURRENCY} results, got ${results.length}`);
      }

      const expectedIdempotencyKey = 'publish:post-stress-999:7';
      const firstResult = results[0];
      if (!firstResult) {
        throw new Error('First result is undefined');
      }
      const targetJobId = firstResult.id;

      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        if (!item) {
          throw new Error(`Result ${i} is undefined`);
        }
        if (item.id !== targetJobId) {
          throw new Error(`Result ${i} returned mismatched job ID: ${item.id} vs ${targetJobId}`);
        }
        if (item.idempotencyKey !== expectedIdempotencyKey) {
          throw new Error(`Result ${i} returned wrong idempotency key: ${item.idempotencyKey}`);
        }
      }

      if (dbStore.size !== 1) {
        throw new Error(`Expected exactly 1 DB record, found ${dbStore.size}`);
      }

      if (queueJobs.length !== 1) {
        throw new Error(`Expected exactly 1 queue job, found ${queueJobs.length}`);
      }

      if (auditRecords.length !== 1) {
        throw new Error(`Expected exactly 1 audit record, found ${auditRecords.length}`);
      }

      return {
        concurrency: CONCURRENCY,
        dbRecordsCount: dbStore.size,
        queueJobsCount: queueJobs.length,
        auditRecordsCount: auditRecords.length,
        jobId: targetJobId,
      };
    },
  );

  await executeStressTest(
    'Concurrency & Idempotency',
    '1.2 P2002 Database Collision Race Condition Recovery',
    async () => {
      let created = false;
      const winnerJob = {
        id: 'job-p2002-canonical',
        postId: 'post-stress-999',
        postVersion: 7,
        idempotencyKey: 'publish:post-stress-999:7',
        channelId: 'chan-stress-1',
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        telegramMessageIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPrisma: any = {
        publicationJob: {
          findUnique: async () => null, // Worst case: both callers execute findUnique before insert
          findUniqueOrThrow: async () => winnerJob,
          create: async () => {
            if (!created) {
              created = true;
              return winnerJob;
            }
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: '6.19.3',
            });
          },
        },
      };

      const mockPreflight: any = {
        validateStage1: async () => ({ post: baseApprovedPost }),
      };

      const mockAudit: any = { record: async () => ({ id: 'audit-1' }) };
      const queueJobs: any[] = [];
      const mockQueue: any = {
        add: async (name: string, data: any, opts: any) => {
          queueJobs.push({ name, data, opts });
          return { id: opts.jobId };
        },
      };

      const service = new PublishingService(
        mockPrisma,
        mockPreflight,
        mockAudit,
        mockQueue,
      );

      const callers = Array.from({ length: 20 }, () =>
        service.enqueuePublish('post-stress-999', 'usr-editor-99'),
      );

      const results = await Promise.all(callers);

      if (results.length !== 20) {
        throw new Error(`Expected 20 resolved calls, got ${results.length}`);
      }

      for (const res of results) {
        if (res.id !== 'job-p2002-canonical') {
          throw new Error(`Collision recovery returned unexpected job ID: ${res.id}`);
        }
      }

      if (queueJobs.length !== 1) {
        throw new Error(`Queue add was called ${queueJobs.length} times instead of 1`);
      }

      return {
        collidingCallers: 20,
        queueJobsPushed: queueJobs.length,
        resolvedJobId: winnerJob.id,
      };
    },
  );

  await executeStressTest(
    'Concurrency & Idempotency',
    '1.3 Worker Redelivery Skip on COMPLETED and CANCELLED Jobs',
    async () => {
      let publisherCallCount = 0;
      let workflowTransitionCount = 0;

      const mockPublisher: any = {
        publishOutgoingMessage: async () => {
          publisherCallCount++;
          return [1234];
        },
      };

      const mockWorkflow: any = {
        transition: async () => {
          workflowTransitionCount++;
          return baseApprovedPost;
        },
      };

      const mockPreflight: any = {
        validateStage2: async () => ({
          post: baseApprovedPost,
          channel: mockChannel,
          template: mockTemplate,
          media: [],
          payload: { messages: [{ partIndex: 0, type: 'text', html: 'Hello' }] },
        }),
      };

      const mockPrisma: any = {
        publicationJob: {
          findFirst: async ({ where }: any) => {
            if (where.OR?.[0]?.id === 'job-completed') {
              return { id: 'job-completed', status: PublicationJobStatus.COMPLETED };
            }
            return { id: 'job-cancelled', status: PublicationJobStatus.CANCELLED };
          },
          update: async () => ({}),
        },
        post: {
          findUnique: async () => baseApprovedPost,
        },
      };

      const processor = new PublishingProcessor(
        mockPrisma,
        mockWorkflow,
        mockPreflight,
        mockPublisher,
        {} as any,
        { record: async () => ({}) } as any,
        { publish: () => {} } as any,
      );

      // Process completed job
      await processor.process({
        id: 'publish:post-stress-999:7',
        data: {
          publicationJobId: 'job-completed',
          postId: 'post-stress-999',
          postVersion: 7,
          channelId: 'chan-stress-1',
          actorId: 'usr-editor-99',
        },
        attemptsMade: 0,
      } as any);

      // Process cancelled job
      await processor.process({
        id: 'publish:post-stress-999:7',
        data: {
          publicationJobId: 'job-cancelled',
          postId: 'post-stress-999',
          postVersion: 7,
          channelId: 'chan-stress-1',
          actorId: 'usr-editor-99',
        },
        attemptsMade: 0,
      } as any);

      if (publisherCallCount !== 0) {
        throw new Error(`Publisher was called ${publisherCallCount} times, expected 0`);
      }

      if (workflowTransitionCount !== 0) {
        throw new Error(`Workflow transition called ${workflowTransitionCount} times, expected 0`);
      }

      return {
        completedJobSkipped: true,
        cancelledJobSkipped: true,
        publisherCalls: publisherCallCount,
      };
    },
  );

  await executeStressTest(
    'Concurrency & Idempotency',
    '1.4 Partial Publication Resume: skips already-published parts on retry',
    async () => {
      const dispatchedParts: string[] = [];
      const updatedMessageIds: number[][] = [];

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
            html: 'Secondary text body',
          },
        ],
      };

      // Current job has already recorded media group message IDs [7001, 7002] from previous failed attempt!
      let currentJobState: any = {
        id: 'job-partial-resume',
        postId: 'post-stress-999',
        status: PublicationJobStatus.RUNNING,
        telegramMessageIds: [7001, 7002],
      };

      const mockPrisma: any = {
        publicationJob: {
          findFirst: async () => currentJobState,
          update: async ({ data }: any) => {
            currentJobState = { ...currentJobState, ...data };
            if (data.telegramMessageIds) {
              updatedMessageIds.push(data.telegramMessageIds);
            }
            return currentJobState;
          },
        },
        post: {
          findUnique: async () => baseApprovedPost,
        },
      };

      const mockPublisher: any = {
        publishOutgoingMessage: async (_chatId: string, msg: any) => {
          dispatchedParts.push(msg.type);
          return [7003]; // text message ID
        },
      };

      const mockWorkflow: any = {
        transition: async (cmd: any) => ({
          ...baseApprovedPost,
          status: cmd.targetStatus,
          publishedAt: cmd.targetStatus === PostStatus.PUBLISHED ? new Date() : null,
        }),
      };

      const mockPreflight: any = {
        validateStage2: async () => ({
          post: baseApprovedPost,
          channel: mockChannel,
          template: mockTemplate,
          media: [],
          payload: multiPartPayload,
        }),
      };

      const processor = new PublishingProcessor(
        mockPrisma,
        mockWorkflow,
        mockPreflight,
        mockPublisher,
        {} as any,
        { record: async () => ({}) } as any,
        { publish: () => {} } as any,
      );

      await processor.process({
        id: 'publish:post-stress-999:7',
        data: {
          publicationJobId: 'job-partial-resume',
          postId: 'post-stress-999',
          postVersion: 7,
          channelId: 'chan-stress-1',
          actorId: 'usr-editor-99',
        },
        attemptsMade: 1,
      } as any);

      // Verify that media_group was skipped and ONLY text was sent
      if (dispatchedParts.length !== 1 || dispatchedParts[0] !== 'text') {
        throw new Error(
          `Expected only 'text' to be dispatched, but got: ${JSON.stringify(dispatchedParts)}`,
        );
      }

      if (
        !currentJobState.telegramMessageIds ||
        currentJobState.telegramMessageIds.length !== 3 ||
        currentJobState.telegramMessageIds[2] !== 7003
      ) {
        throw new Error(
          `Final telegramMessageIds invalid: ${JSON.stringify(currentJobState.telegramMessageIds)}`,
        );
      }

      if (currentJobState.status !== PublicationJobStatus.COMPLETED) {
        throw new Error(`Job status was not marked COMPLETED: ${currentJobState.status}`);
      }

      return {
        dispatchedParts,
        finalMessageIds: currentJobState.telegramMessageIds,
        jobStatus: currentJobState.status,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Category 2: Preflight Validation Hardening
  // ---------------------------------------------------------------------------
  console.log('\n>>> Category 2: Preflight Validation Hardening');

  const validator = new TemplateValidator();
  const sanitizer = new HtmlSanitizer();
  const renderer = new TelegramRenderer(sanitizer);

  await executeStressTest(
    'Preflight Hardening',
    '2.1 Rejection of all Non-Publishable Post Statuses in Stage 1',
    async () => {
      const rejectedStatuses = [
        PostStatus.DRAFT,
        PostStatus.PENDING_REVIEW,
        PostStatus.NEEDS_REVISION,
        PostStatus.REJECTED,
        PostStatus.CANCELLED,
        PostStatus.PUBLISHED,
      ];

      for (const status of rejectedStatuses) {
        const mockPrisma: any = {
          post: {
            findUnique: async () => ({ ...baseApprovedPost, status }),
          },
        };
        const preflight = new PublishingPreflightService(
          mockPrisma,
          validator,
          renderer,
          { checkChannelPermission: async () => true } as any,
        );

        let threw = false;
        try {
          await preflight.validateStage1('post-stress-999', 'usr-editor-99');
        } catch (e: any) {
          threw = true;
          if (!(e instanceof InvalidPostStateTransitionException)) {
            throw new Error(`Expected InvalidPostStateTransitionException for ${status}, got ${e.name}`);
          }
        }
        if (!threw) {
          throw new Error(`Status ${status} was unexpectedly accepted in Stage 1 preflight!`);
        }
      }

      return { testedStatusesCount: rejectedStatuses.length, allRejected: true };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.2 Acceptance of Valid Execution Statuses (APPROVED, SCHEDULED, PUBLISH_FAILED)',
    async () => {
      const allowed = [PostStatus.APPROVED, PostStatus.SCHEDULED, PostStatus.PUBLISH_FAILED];

      for (const status of allowed) {
        const mockPrisma: any = {
          post: {
            findUnique: async () => ({ ...baseApprovedPost, status }),
          },
        };
        const preflight = new PublishingPreflightService(
          mockPrisma,
          validator,
          renderer,
          { checkChannelPermission: async () => true } as any,
        );

        const result = await preflight.validateStage1('post-stress-999', 'usr-editor-99');
        if (result.post.status !== status) {
          throw new Error(`Expected status ${status}, got ${result.post.status}`);
        }
      }

      return { testedAllowedStatuses: allowed };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.3 Soft-Deleted Post Rejection in Both Stage 1 and Stage 2',
    async () => {
      const mockPrisma: any = {
        post: {
          findUnique: async () => ({ ...baseApprovedPost, deletedAt: new Date() }),
        },
      };
      const preflight = new PublishingPreflightService(
        mockPrisma,
        validator,
        renderer,
        { checkChannelPermission: async () => true } as any,
      );

      // Stage 1 must throw ValidationException
      let stage1Threw = false;
      try {
        await preflight.validateStage1('post-stress-999', 'usr-editor-99');
      } catch (e: any) {
        stage1Threw = e instanceof ValidationException;
      }
      if (!stage1Threw) {
        throw new Error('Stage 1 failed to throw ValidationException on soft-deleted post');
      }

      // Stage 2 must throw TelegramPermanentException
      let stage2Threw = false;
      try {
        await preflight.validateStage2('post-stress-999');
      } catch (e: any) {
        stage2Threw = e instanceof TelegramPermanentException;
      }
      if (!stage2Threw) {
        throw new Error('Stage 2 failed to throw TelegramPermanentException on soft-deleted post');
      }

      return { stage1Rejection: 'ValidationException', stage2Rejection: 'TelegramPermanentException' };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.4 Actor Permission Rejection when ChannelPermission.PUBLISH_POST is missing',
    async () => {
      const mockPrisma: any = {
        post: {
          findUnique: async () => baseApprovedPost,
        },
      };
      const mockPermission: any = {
        checkChannelPermission: async () => false,
      };

      const preflight = new PublishingPreflightService(
        mockPrisma,
        validator,
        renderer,
        mockPermission,
      );

      let threw = false;
      try {
        await preflight.validateStage1('post-stress-999', 'usr-unauthorized-author');
      } catch (e: any) {
        threw = e instanceof PermissionDeniedException;
      }
      if (!threw) {
        throw new Error('Stage 1 failed to throw PermissionDeniedException for unauthorized actor');
      }

      return { permissionDeniedEnforced: true };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.5 Channel Inactivity and telegramChatId Missing/Whitespace Rejection',
    async () => {
      const testCases = [
        { channel: { ...mockChannel, isActive: false }, desc: 'inactive channel' },
        { channel: { ...mockChannel, telegramChatId: '' }, desc: 'empty telegramChatId' },
        { channel: { ...mockChannel, telegramChatId: '   ' }, desc: 'whitespace telegramChatId' },
      ];

      for (const tc of testCases) {
        const mockPrisma: any = {
          post: {
            findUnique: async () => ({ ...baseApprovedPost, channel: tc.channel }),
          },
        };
        const preflight = new PublishingPreflightService(
          mockPrisma,
          validator,
          renderer,
          { checkChannelPermission: async () => true } as any,
        );

        let s1 = false;
        try {
          await preflight.validateStage1('post-stress-999', 'usr-editor-99');
        } catch (e: any) {
          s1 = e instanceof ValidationException;
        }
        if (!s1) throw new Error(`Stage 1 did not reject: ${tc.desc}`);

        let s2 = false;
        try {
          await preflight.validateStage2('post-stress-999');
        } catch (e: any) {
          s2 = e instanceof TelegramPermanentException;
        }
        if (!s2) throw new Error(`Stage 2 did not reject: ${tc.desc}`);
      }

      return { testedChannelFailureCases: testCases.length };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.6 Template Schema and Content Validation Rejection',
    async () => {
      // 1. Missing required field 'body'
      const invalidContent1 = { title: 'Only title, no body' };
      const mockPrisma1: any = {
        post: {
          findUnique: async () => ({ ...baseApprovedPost, contentJson: invalidContent1 }),
        },
      };
      const p1 = new PublishingPreflightService(
        mockPrisma1,
        validator,
        renderer,
        { checkChannelPermission: async () => true } as any,
      );

      let err1 = false;
      try {
        await p1.validateStage1('post-stress-999', 'usr-editor-99');
      } catch (e: any) {
        err1 = e instanceof ValidationException;
      }
      if (!err1) throw new Error('Stage 1 failed to reject content missing required field');

      // 2. Field exceeds maxLength (title > 120 chars)
      const invalidContent2 = {
        title: 'T'.repeat(125),
        body: 'Valid body text',
      };
      const mockPrisma2: any = {
        post: {
          findUnique: async () => ({ ...baseApprovedPost, contentJson: invalidContent2 }),
        },
      };
      const p2 = new PublishingPreflightService(
        mockPrisma2,
        validator,
        renderer,
        { checkChannelPermission: async () => true } as any,
      );

      let err2 = false;
      try {
        await p2.validateStage1('post-stress-999', 'usr-editor-99');
      } catch (e: any) {
        err2 = e instanceof ValidationException;
      }
      if (!err2) throw new Error('Stage 1 failed to reject content exceeding maxLength');

      return { schemaValidationEnforced: true };
    },
  );

  await executeStressTest(
    'Preflight Hardening',
    '2.7 Media Group Limits & Invariants Rejection (>10 items, unsupported media type)',
    async () => {
      // 11 items
      const elevenMedia = Array.from({ length: 11 }, (_, i) => ({
        id: `m-${i}`,
        postId: 'post-stress-999',
        telegramFileId: `file-${i}`,
        telegramFileUniqueId: `uniq-${i}`,
        mediaType: 'photo' as const,
        sortOrder: i,
      }));

      const mockPrisma: any = {
        post: {
          findUnique: async () => ({ ...baseApprovedPost, media: elevenMedia }),
        },
      };
      const preflight = new PublishingPreflightService(
        mockPrisma,
        validator,
        renderer,
        { checkChannelPermission: async () => true } as any,
      );

      let errCount = false;
      try {
        await preflight.validateStage1('post-stress-999', 'usr-editor-99');
      } catch (e: any) {
        errCount = e instanceof ValidationException && e.message.includes('exceeds maximum limit of 10');
      }
      if (!errCount) throw new Error('Failed to reject media group > 10 items');

      // Unsupported media type
      const unsupportedMedia = [
        {
          id: 'm-doc',
          postId: 'post-stress-999',
          telegramFileId: 'file-doc',
          telegramFileUniqueId: 'uniq-doc',
          mediaType: 'document' as const, // template only supports ['photo', 'video']
          sortOrder: 0,
        },
      ];
      mockPrisma.post.findUnique = async () => ({ ...baseApprovedPost, media: unsupportedMedia });

      let errType = false;
      try {
        await preflight.validateStage1('post-stress-999', 'usr-editor-99');
      } catch (e: any) {
        errType = e instanceof ValidationException && e.message.includes('not supported by template');
      }
      if (!errType) throw new Error('Failed to reject unsupported media type');

      return { mediaLimitsEnforced: true, unsupportedTypeEnforced: true };
    },
  );

  console.log('\n================================================================================');
  console.log('STRESS TEST SUMMARY');
  console.log('================================================================================');
  const total = allResults.length;
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log(`Total Scenarios: ${total}`);
  console.log(`Passed:          ${passed}`);
  console.log(`Failed:          ${failed}`);
  console.log(`Pass Rate:       ${((passed / total) * 100).toFixed(1)}%`);

  if (failed > 0) {
    process.exit(1);
  }
}

runM4EmpiricalHarness().catch((e) => {
  console.error('Fatal harness crash:', e);
  process.exit(1);
});
