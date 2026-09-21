/**
 * PublishingProcessor
 * BullMQ Worker Host executing publication jobs with idempotency, two-stage preflight,
 * and partial publication resumption.
 * Authoritative reference: AGENTS.md § 20, § 21, § 22, § 23, § 48, § 49, § 50
 */

import { Injectable, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { PublicationJobStatus, PostStatus, Post } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostWorkflowService } from '../posts/post-workflow.service';
import { PublishingPreflightService } from './publishing-preflight.service';
import {
  ITelegramPublisher,
  TELEGRAM_PUBLISHER,
  TelegramErrorCategory,
} from '../../infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import { TelegramErrorClassifier } from '../../infrastructure/telegram-api/errors/telegram-error.classifier';
import { TelegramRenderer } from '../rendering/telegram-renderer.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { DomainEventBus } from '../notifications/domain-event.bus';
import { AuditService } from '../audit/audit.service';
import { PostPublishedEvent, PostPublicationFailedEvent } from '../notifications/events/domain-events';
import { PUBLICATION_QUEUE_NAME } from '../../common/constants/queue-names';
import { PostAction, AuditAction } from '../../common/enums';
import { PublishJobData } from './interfaces/publish-job-data.interface';

@Processor(PUBLICATION_QUEUE_NAME, {
  concurrency: 5,
})
@Injectable()
export class PublishingProcessor extends WorkerHost implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postWorkflow: PostWorkflowService,
    private readonly preflight: PublishingPreflightService,
    @Inject(TELEGRAM_PUBLISHER)
    private readonly publisher: ITelegramPublisher,
    private readonly renderer: TelegramRenderer,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {
    super();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger?.log({
      event: 'publishing_worker_closing',
      module: 'publishing',
    });
    if (this.worker) {
      await this.worker.close();
    }
  }

  async process(job: Job<PublishJobData>, token?: string): Promise<void> {
    const { postId, postVersion, actorId, publicationJobId } = job.data;
    const idempotencyKey = `publish:${postId}:${postVersion}`;

    this.logger?.log({
      event: 'publishing_job_started',
      jobId: job.id,
      postId,
      postVersion,
      attemptsMade: job.attemptsMade,
    });

    // 1. Locate PublicationJob record in PostgreSQL
    let pubJob = await this.prisma.publicationJob.findFirst({
      where: {
        OR: [
          ...(publicationJobId ? [{ id: publicationJobId }] : []),
          { idempotencyKey },
        ],
      },
    });

    if (pubJob && pubJob.status === PublicationJobStatus.COMPLETED) {
      this.logger?.log({
        event: 'publication_already_completed_skip',
        jobId: job.id,
        postId,
      });
      return;
    }

    if (pubJob && pubJob.status === PublicationJobStatus.CANCELLED) {
      this.logger?.log({
        event: 'publication_job_cancelled_skip',
        jobId: job.id,
        postId,
      });
      return;
    }

    try {
      // 2. Stage 2 Preflight Validation (Fresh DB inspection)
      const preflightResult = await this.preflight.validateStage2(postId);
      let currentPost: Post = preflightResult.post;
      const targetChannel = preflightResult.channel;
      const payload = preflightResult.payload;

      // 3. State Machine Transition: APPROVED / SCHEDULED / PUBLISH_FAILED -> PUBLISHING
      // GUARD: If post is already PUBLISHING (e.g. BullMQ retry attempt 2 or 3), do NOT re-transition!
      if (currentPost.status !== PostStatus.PUBLISHING) {
        currentPost = await this.postWorkflow.transition({
          postId: currentPost.id,
          expectedVersion: currentPost.version,
          targetStatus: PostStatus.PUBLISHING,
          action: PostAction.START_PUBLISHING,
          actorId,
        });
      }

      // 4. Multi-message Dispatch Loop with Partial Publication Resume
      const sentMessageIds: number[] = Array.isArray(pubJob?.telegramMessageIds)
        ? [...(pubJob.telegramMessageIds as number[])]
        : [];

      // Update PublicationJob to RUNNING & increment attempts in DB
      if (pubJob) {
        pubJob = await this.prisma.publicationJob.update({
          where: { id: pubJob.id },
          data: {
            status: PublicationJobStatus.RUNNING,
            attempts: { increment: 1 },
            updatedAt: new Date(),
          },
        });
      }

      let accumulatedExpectedIds = 0;

      for (const message of payload.messages) {
        const expectedCount =
          message.type === 'media_group' ? (message.items?.length || 2) : 1;

        // Partial Resume Check: If this part was already sent in a previous attempt, skip it!
        if (sentMessageIds.length >= accumulatedExpectedIds + expectedCount) {
          this.logger?.log({
            event: 'publication_part_skipped_already_sent',
            postId: currentPost.id,
            partIndex: message.partIndex,
            type: message.type,
          });
          accumulatedExpectedIds += expectedCount;
          continue;
        }

        // Dispatch unsent part via Telegram API abstraction
        const newIds = await this.publisher.publishOutgoingMessage(
          targetChannel.telegramChatId,
          message,
        );
        if (Array.isArray(newIds)) {
          sentMessageIds.push(...newIds);
        } else if (typeof newIds === 'number') {
          sentMessageIds.push(newIds);
        }

        // Immediately persist progress to PostgreSQL
        if (pubJob) {
          await this.prisma.publicationJob.update({
            where: { id: pubJob.id },
            data: {
              telegramMessageIds: sentMessageIds,
              updatedAt: new Date(),
            },
          });
        }

        accumulatedExpectedIds += expectedCount;
      }

      // 6. Transition Post to PUBLISHED
      const finalPost = await this.postWorkflow.transition({
        postId: currentPost.id,
        expectedVersion: currentPost.version,
        targetStatus: PostStatus.PUBLISHED,
        action: PostAction.MARK_PUBLISHED,
        actorId,
      });

      // 7. Mark PublicationJob as COMPLETED
      if (pubJob) {
        await this.prisma.publicationJob.update({
          where: { id: pubJob.id },
          data: {
            status: PublicationJobStatus.COMPLETED,
            updatedAt: new Date(),
          },
        });
      }

      const postTitle =
        ((finalPost.contentJson as Record<string, unknown>)?.title as string) ||
        'Без названия';

      // Dispatch PostPublishedEvent with actual sent message IDs
      this.eventBus.publish(
        new PostPublishedEvent(
          finalPost.id,
          finalPost.channelId,
          finalPost.authorId,
          postTitle,
          sentMessageIds,
        ),
      );

      this.logger?.log({
        event: 'publication_job_succeeded',
        postId: finalPost.id,
        publishedAt: finalPost.publishedAt,
        telegramMessageIds: sentMessageIds,
      });
    } catch (err: unknown) {
      const classification = TelegramErrorClassifier.classify(err);
      const attemptsMade = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts || 3;
      const isExhausted = attemptsMade >= maxAttempts;

      this.logger?.warn({
        event: 'publication_job_attempt_failed',
        jobId: job.id,
        postId,
        attempt: attemptsMade,
        maxAttempts,
        category: classification.category,
        error: classification.sanitizedMessage,
      });

      // Record attempt failure in DB job
      if (pubJob) {
        await this.prisma.publicationJob.update({
          where: { id: pubJob.id },
          data: {
            errorMessage: classification.sanitizedMessage,
            attempts: attemptsMade,
            updatedAt: new Date(),
          },
        });
      }

      // Record Audit Log for failed attempt
      await this.auditService.record({
        action: AuditAction.PUBLICATION_ATTEMPT_FAILED,
        entityType: 'post',
        entityId: postId,
        actorId,
        payload: {
          attempt: attemptsMade,
          maxAttempts,
          category: classification.category,
          error: classification.sanitizedMessage,
        },
      });

      // Handle Rate Limiting (429)
      if (classification.category === TelegramErrorCategory.RATE_LIMITED) {
        const delayMs = (classification.retryAfterSeconds ?? 5) * 1000;
        this.logger?.warn({
          event: 'publication_rate_limited_delaying',
          postId,
          delayMs,
        });

        if (token && typeof job.moveToDelayed === 'function') {
          try {
            await job.moveToDelayed(Date.now() + delayMs, token);
            return;
          } catch {
            // Fallback to standard error rethrow if moveToDelayed fails
          }
        }
      }

      // Handle Permanent Failure OR Exhaustion of Retries
      if (classification.isPermanent || isExhausted) {
        const freshPost = await this.prisma.post.findUnique({
          where: { id: postId },
        });

        if (freshPost && freshPost.status === PostStatus.PUBLISHING) {
          await this.postWorkflow.transition({
            postId: freshPost.id,
            expectedVersion: freshPost.version,
            targetStatus: PostStatus.PUBLISH_FAILED,
            action: PostAction.MARK_PUBLISH_FAILED,
            actorId,
          });

          const postTitle =
            ((freshPost.contentJson as Record<string, unknown>)?.title as string) ||
            'Без названия';

          this.eventBus.publish(
            new PostPublicationFailedEvent(
              freshPost.id,
              freshPost.channelId,
              freshPost.authorId,
              postTitle,
              attemptsMade,
              classification.sanitizedMessage,
            ),
          );
        }

        if (pubJob) {
          await this.prisma.publicationJob.update({
            where: { id: pubJob.id },
            data: {
              status: PublicationJobStatus.FAILED,
              errorMessage: classification.sanitizedMessage,
              updatedAt: new Date(),
            },
          });
        }

        throw new UnrecoverableError(
          `Publication failed permanently: ${classification.sanitizedMessage}`,
        );
      }

      // Transient retryable error: re-throw for BullMQ exponential backoff
      throw err;
    }
  }
}
