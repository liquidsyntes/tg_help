/**
 * Milestone 4 Empirical Adversarial Verification Harness (m4_challenger_2)
 * Tests:
 * 1. Partial Publication Resume Verification (AGENTS.md §23)
 * 2. Error Backoff & Unrecoverable Error Handling (429, 400, 403, retry exhaustion)
 * 3. Scheduling Stress (past dates, Europe/Kyiv UTC conversion, schedule cancellation)
 */

import 'reflect-metadata';
import { PostStatus, PublicationJobStatus } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PublishingProcessor } from '../../src/modules/publishing/publishing.processor';
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

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  details: string;
  error?: string;
}

const results: TestResult[] = [];

function assert(
  condition: boolean,
  name: string,
  category: string,
  details: string,
  errorMsg?: string,
) {
  results.push({
    name,
    category,
    passed: condition,
    details,
    error: condition ? undefined : errorMsg || 'Assertion failed',
  });
  const symbol = condition ? '✅ PASS' : '❌ FAIL';
  console.log(`${symbol} [${category}] ${name}: ${details}`);
  if (!condition && errorMsg) {
    console.error(`       ERROR: ${errorMsg}`);
  }
}

async function runEmpiricalSuite() {
  console.log('================================================================');
  console.log('STARTING EMPIRICAL ADVERSARIAL STRESS SUITE (M4 CHALLENGER 2)');
  console.log('================================================================\n');

  // =========================================================================
  // Dimension 1: Partial Publication Resume (AGENTS.md §23)
  // =========================================================================
  console.log('>>> Testing Dimension 1: Partial Publication Resume (AGENTS.md §23)');

  {
    // Setup Mock Post & DB Job
    let dbJob: any = {
      id: 'job-part-1',
      postId: 'post-multi-1',
      postVersion: 2,
      idempotencyKey: 'publish:post-multi-1:2',
      status: PublicationJobStatus.PENDING,
      attempts: 0,
      telegramMessageIds: [],
    };

    let postRecord: any = {
      id: 'post-multi-1',
      channelId: 'chan-kyiv',
      status: PostStatus.APPROVED,
      version: 2,
      deletedAt: null,
      contentJson: { title: 'Multi-part Post' },
    };

    const mockPrisma: any = {
      publicationJob: {
        findFirst: async () => dbJob,
        update: async (args: any) => {
          dbJob = { ...dbJob, ...args.data };
          return dbJob;
        },
      },
      post: {
        findUnique: async () => postRecord,
      },
    };

    const mockPostWorkflow: any = {
      transition: async (cmd: any) => {
        postRecord = {
          ...postRecord,
          status: cmd.targetStatus,
          version: cmd.expectedVersion + 1,
          publishedAt: cmd.targetStatus === PostStatus.PUBLISHED ? new Date() : null,
        };
        return postRecord;
      },
    };

    const payload = {
      messages: [
        {
          partIndex: 0,
          type: 'media_group' as const,
          items: [
            { type: 'photo' as const, fileId: 'ph-1' },
            { type: 'photo' as const, fileId: 'ph-2' },
          ],
        },
        {
          partIndex: 1,
          type: 'text' as const,
          html: 'Long overflow text accompanying media group',
        },
      ],
    };

    const mockPreflight: any = {
      validateStage2: async () => ({
        post: postRecord,
        channel: { id: 'chan-kyiv', telegramChatId: '-100123456789' },
        template: { id: 't1' },
        media: [],
        payload,
      }),
    };

    let publisherCalls: any[] = [];
    const mockPublisher: any = {
      publishOutgoingMessage: async (chatId: string, msg: any) => {
        publisherCalls.push({ chatId, type: msg.type });
        if (msg.type === 'media_group') {
          return [7001, 7002];
        }
        if (msg.type === 'text') {
          if (publisherCalls.filter((c) => c.type === 'text').length === 1) {
            throw new Error('connect ECONNRESET');
          }
          return [7003];
        }
        return [9999];
      },
    };

    const mockEventBus: any = {
      publishedEvents: [] as any[],
      publish: (evt: any) => mockEventBus.publishedEvents.push(evt),
    };

    const processor = new PublishingProcessor(
      mockPrisma,
      mockPostWorkflow,
      mockPreflight,
      mockPublisher,
      {} as any,
      { record: async () => ({}) } as any,
      mockEventBus,
    );

    const bullJob = {
      id: 'publish:post-multi-1:2',
      data: {
        publicationJobId: 'job-part-1',
        postId: 'post-multi-1',
        postVersion: 2,
        channelId: 'chan-kyiv',
        actorId: 'editor-1',
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any;

    // Run Attempt 1: Part 0 (media_group) succeeds, Part 1 (text) fails
    let attempt1Failed = false;
    try {
      await processor.process(bullJob);
    } catch (e: any) {
      attempt1Failed = true;
      assert(
        e.message.includes('ECONNRESET'),
        'Attempt 1 fails with ECONNRESET',
        'Partial Resume',
        `Error caught: ${e.message}`,
      );
    }

    assert(
      attempt1Failed,
      'Attempt 1 threw error',
      'Partial Resume',
      'Processor correctly threw retryable error',
    );

    assert(
      JSON.stringify(dbJob.telegramMessageIds) === JSON.stringify([7001, 7002]),
      'Part 0 Message IDs persisted after Attempt 1',
      'Partial Resume',
      `DB stored IDs: ${JSON.stringify(dbJob.telegramMessageIds)}`,
    );

    assert(
      postRecord.status === PostStatus.PUBLISHING,
      'Post remains in PUBLISHING status during retry',
      'Partial Resume',
      `Status: ${postRecord.status}`,
    );

    // Run Attempt 2 (Retry): Worker must skip media_group and ONLY publish text!
    const callsBeforeAttempt2 = publisherCalls.length;
    await processor.process({ ...bullJob, attemptsMade: 1 });

    const newCalls = publisherCalls.slice(callsBeforeAttempt2);
    assert(
      newCalls.length === 1 && newCalls[0].type === 'text',
      'Retry skips media group and publishes only text',
      'Partial Resume',
      `Calls made on retry: ${JSON.stringify(newCalls)}`,
    );

    assert(
      JSON.stringify(dbJob.telegramMessageIds) === JSON.stringify([7001, 7002, 7003]),
      'All Telegram message IDs merged in DB',
      'Partial Resume',
      `Final IDs: ${JSON.stringify(dbJob.telegramMessageIds)}`,
    );

    assert(
      postRecord.status === PostStatus.PUBLISHED,
      'Post transitions to PUBLISHED after partial resume succeeds',
      'Partial Resume',
      `Final status: ${postRecord.status}`,
    );

    assert(
      dbJob.status === PublicationJobStatus.COMPLETED,
      'PublicationJob marked COMPLETED in PostgreSQL',
      'Partial Resume',
      `Job status: ${dbJob.status}`,
    );
  }

  // =========================================================================
  // Dimension 2: Error Backoff & Unrecoverable Error Handling
  // =========================================================================
  console.log('\n>>> Testing Dimension 2: Error Backoff & Unrecoverable Errors');

  {
    // 2.1 429 Rate Limit classification & retry_after extraction
    const g429WithParam = new GrammyError(
      'Too Many Requests',
      { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 35 } } as any,
      'sendMessage',
      {},
    );
    const cl429_1 = TelegramErrorClassifier.classify(g429WithParam);
    assert(
      cl429_1.category === TelegramErrorCategory.RATE_LIMITED && cl429_1.retryAfterSeconds === 35,
      'Classify 429 from parameters.retry_after',
      'Error Classification',
      `Category: ${cl429_1.category}, retryAfter: ${cl429_1.retryAfterSeconds}s`,
    );

    const g429DescOnly = new GrammyError(
      'Too Many Requests: retry after 48',
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 48' } as any,
      'sendMessage',
      {},
    );
    const cl429_2 = TelegramErrorClassifier.classify(g429DescOnly);
    assert(
      cl429_2.category === TelegramErrorCategory.RATE_LIMITED && cl429_2.retryAfterSeconds === 48,
      'Classify 429 via regex extraction from description',
      'Error Classification',
      `Category: ${cl429_2.category}, retryAfter: ${cl429_2.retryAfterSeconds}s`,
    );

    // 2.2 400 & 403 Permanent Error Immediate Failure
    const g403 = new GrammyError(
      'Forbidden: bot was kicked from the channel',
      { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the channel' } as any,
      'sendMessage',
      {},
    );
    const cl403 = TelegramErrorClassifier.classify(g403);
    assert(
      cl403.category === TelegramErrorCategory.PERMANENT && cl403.isPermanent === true,
      'Classify 403 bot kicked as PERMANENT',
      'Error Classification',
      `Category: ${cl403.category}, isPermanent: ${cl403.isPermanent}`,
    );

    // Test Worker handling of 403 Permanent error: must immediately throw UnrecoverableError and set PUBLISH_FAILED
    let dbJob403: any = {
      id: 'job-403',
      postId: 'post-403',
      postVersion: 1,
      status: PublicationJobStatus.PENDING,
      attempts: 0,
    };
    let post403: any = {
      id: 'post-403',
      channelId: 'chan-1',
      status: PostStatus.PUBLISHING,
      version: 1,
    };

    const mockPrisma403: any = {
      publicationJob: {
        findFirst: async () => dbJob403,
        update: async (args: any) => {
          dbJob403 = { ...dbJob403, ...args.data };
          return dbJob403;
        },
      },
      post: {
        findUnique: async () => post403,
      },
    };

    const mockPostWorkflow403: any = {
      transition: async (cmd: any) => {
        post403 = { ...post403, status: cmd.targetStatus, version: cmd.expectedVersion + 1 };
        return post403;
      },
    };

    const processor403 = new PublishingProcessor(
      mockPrisma403,
      mockPostWorkflow403,
      {
        validateStage2: async () => ({
          post: post403,
          channel: { telegramChatId: '-100' },
          template: {},
          media: [],
          payload: { messages: [{ type: 'text', html: 'Hi' }] },
        }),
      } as any,
      {
        publishOutgoingMessage: async () => {
          throw g403;
        },
      } as any,
      {} as any,
      { record: async () => ({}) } as any,
      { publish: () => {} } as any,
    );

    let threwUnrecoverable = false;
    try {
      await processor403.process({
        id: 'job-403',
        data: { postId: 'post-403', postVersion: 1, actorId: 'ed-1', channelId: 'chan-1' },
        attemptsMade: 0, // Attempt 1 of 3!
        opts: { attempts: 3 },
      } as any);
    } catch (err: any) {
      if (err instanceof UnrecoverableError) {
        threwUnrecoverable = true;
      }
    }

    assert(
      threwUnrecoverable,
      '403 Forbidden immediately throws UnrecoverableError on attempt 1',
      'Unrecoverable Handling',
      'BullMQ will not retry permanently failed job',
    );

    assert(
      post403.status === PostStatus.PUBLISH_FAILED,
      'Post immediately transitioned to PUBLISH_FAILED on attempt 1',
      'Unrecoverable Handling',
      `Post status: ${post403.status}`,
    );

    assert(
      dbJob403.status === PublicationJobStatus.FAILED,
      'PublicationJob marked FAILED in PostgreSQL',
      'Unrecoverable Handling',
      `Job status: ${dbJob403.status}`,
    );
  }

  // =========================================================================
  // Dimension 3: Scheduling Stress (AGENTS.md §24, §47, tasks.md §6, §19)
  // =========================================================================
  console.log('\n>>> Testing Dimension 3: Scheduling Stress');

  {
    // 3.1 Past Date Rejection
    let pastRejected = false;
    try {
      parseAndValidateScheduledDate('20.09.2021 12:00', 'Europe/Kyiv', Date.now());
    } catch (e: any) {
      if (e instanceof ValidationException && e.message.includes('в прошлом')) {
        pastRejected = true;
      }
    }
    assert(
      pastRejected,
      'Rejects date in the past with Russian ValidationException',
      'Scheduling Validation',
      'Threw "Нельзя планировать публикацию в прошлом."',
    );

    // 3.2 Timezone Conversions: Europe/Kyiv Summer vs Winter
    // Summer (July): UTC+3
    const summerDate = parseAndValidateScheduledDate('15.07.2028 14:00', 'Europe/Kyiv', 0);
    assert(
      summerDate.getUTCHours() === 11 && summerDate.getUTCMinutes() === 0,
      'Europe/Kyiv Summer Time (EEST, UTC+3) correctly converted to UTC (14:00 -> 11:00 UTC)',
      'Timezone Conversion',
      `Result UTC: ${summerDate.toISOString()}`,
    );

    // Winter (January): UTC+2
    const winterDate = parseAndValidateScheduledDate('15.01.2028 14:00', 'Europe/Kyiv', 0);
    assert(
      winterDate.getUTCHours() === 12 && winterDate.getUTCMinutes() === 0,
      'Europe/Kyiv Winter Time (EET, UTC+2) correctly converted to UTC (14:00 -> 12:00 UTC)',
      'Timezone Conversion',
      `Result UTC: ${winterDate.toISOString()}`,
    );

    // Roundtrip format check
    const formattedSummer = formatChannelDate(summerDate, 'Europe/Kyiv');
    assert(
      formattedSummer === '15.07.2028 14:00',
      'formatChannelDate roundtrips UTC Date back to channel timezone string',
      'Timezone Conversion',
      `Formatted: ${formattedSummer}`,
    );

    // 3.3 Schedule Cancellation Lifecycle
    let schedJob: any = {
      id: 'job-sched-9',
      postId: 'post-sched-9',
      status: PublicationJobStatus.PENDING,
    };
    let schedPost: any = {
      id: 'post-sched-9',
      channelId: 'chan-1',
      status: PostStatus.SCHEDULED,
      version: 4,
      deletedAt: null,
    };

    let bullJobRemoved = false;
    const mockSchedQueue: any = {
      getJob: async (id: string) => ({
        id,
        remove: async () => {
          bullJobRemoved = true;
        },
      }),
    };

    const mockSchedPrisma: any = {
      post: { findUnique: async () => schedPost },
      publicationJob: {
        findFirst: async () => schedJob,
        update: async (args: any) => {
          schedJob = { ...schedJob, ...args.data };
          return schedJob;
        },
      },
    };

    const mockSchedWorkflow: any = {
      transition: async (cmd: any) => {
        schedPost = { ...schedPost, status: cmd.targetStatus, version: cmd.expectedVersion + 1 };
        return schedPost;
      },
    };

    const mockSchedPermission: any = {
      checkChannelPermission: async () => true,
    };

    const schedService = new SchedulingService(
      mockSchedPrisma,
      mockSchedWorkflow,
      {} as any,
      mockSchedPermission,
      mockSchedQueue,
    );

    await schedService.cancelSchedule('post-sched-9', 'editor-1', 4);

    assert(
      bullJobRemoved,
      'BullMQ delayed job removed from queue upon schedule cancellation',
      'Schedule Cancellation',
      'bullJob.remove() invoked',
    );

    assert(
      schedJob.status === PublicationJobStatus.CANCELLED,
      'PublicationJob status set to CANCELLED in PostgreSQL',
      'Schedule Cancellation',
      `Job status: ${schedJob.status}`,
    );

    assert(
      schedPost.status === PostStatus.CANCELLED,
      'Post state transitioned SCHEDULED -> CANCELLED',
      'Schedule Cancellation',
      `Post status: ${schedPost.status}, version: ${schedPost.version}`,
    );
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n================================================================');
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  console.log(`EMPIRICAL TEST SUMMARY: ${passed}/${total} passed (${failed} failed)`);
  console.log('================================================================');

  if (failed > 0) {
    console.error(`\nFAILED TESTS (${failed}):`);
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.error(` - [${r.category}] ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

runEmpiricalSuite().catch((err) => {
  console.error('Unhandled failure during empirical suite execution:', err);
  process.exit(1);
});
