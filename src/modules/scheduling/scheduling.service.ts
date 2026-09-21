/**
 * SchedulingService
 * Manages post publication scheduling with timezone parsing, optimistic concurrency control,
 * preflight validation, and delayed BullMQ job enqueueing.
 * Authoritative reference: AGENTS.md § 10, § 13, § 20, § 24, § 47; tasks.md § 6, § 19
 */

import { Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Post, PostStatus, PublicationJobStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostWorkflowService } from '../posts/post-workflow.service';
import { PublishingPreflightService } from '../publishing/publishing-preflight.service';
import { PermissionService } from '../auth/permission.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import {
  parseAndValidateScheduledDate,
  DEFAULT_CHANNEL_TIMEZONE,
} from '../channels/utils/timezone.util';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
} from '../../common/exceptions/domain.exceptions';
import { PUBLICATION_QUEUE_NAME, JOB_NAMES } from '../../common/constants/queue-names';
import { ChannelPermission, PostAction } from '../../common/enums';
import { PublishJobData } from '../publishing/interfaces/publish-job-data.interface';

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postWorkflow: PostWorkflowService,
    private readonly preflightService: PublishingPreflightService,
    private readonly permissionService: PermissionService,
    @InjectQueue(PUBLICATION_QUEUE_NAME)
    private readonly publicationQueue: Queue<PublishJobData>,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  /**
   * Schedules an approved post for future publication.
   * Parses and validates datetime in channel timezone (Europe/Kyiv default).
   * Performs Stage 1 preflight, transitions state APPROVED -> SCHEDULED with OCC,
   * creates PublicationJob record in DB, and enqueues delayed BullMQ job.
   */
  async schedulePost(
    postId: string,
    scheduledAt: string | Date,
    actorId: string,
    expectedVersion?: number,
  ): Promise<Post> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { channel: true },
    });

    if (!post || post.deletedAt !== null) {
      throw new ValidationException(`Post "${postId}" not found or deleted.`);
    }

    if (post.status !== PostStatus.APPROVED) {
      throw new InvalidPostStateTransitionException(post.status, PostStatus.SCHEDULED);
    }

    // 1. Timezone Parsing & Validation (Channel Timezone, default Europe/Kyiv)
    const channelTimezone = post.channel?.timezone || DEFAULT_CHANNEL_TIMEZONE;
    let scheduledDate: Date;

    if (typeof scheduledAt === 'string') {
      scheduledDate = parseAndValidateScheduledDate(scheduledAt, channelTimezone, Date.now());
    } else if (scheduledAt instanceof Date) {
      if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        throw new ValidationException('Нельзя планировать публикацию в прошлом.');
      }
      scheduledDate = scheduledAt;
    } else {
      throw new ValidationException('Дата публикации должна быть строкой или объектом Date.');
    }

    // 2. Stage 1 Preflight Validation
    await this.preflightService.validateStage1(postId, actorId);

    // 3. State Machine Transition: APPROVED -> SCHEDULED (OCC Increment + Audit Log)
    const updatedPost = await this.postWorkflow.transition({
      postId: post.id,
      expectedVersion: expectedVersion ?? post.version,
      targetStatus: PostStatus.SCHEDULED,
      action: PostAction.SCHEDULE,
      actorId,
      scheduledAt: scheduledDate,
    });

    // 4. Provision durable PublicationJob in PostgreSQL
    const idempotencyKey = `publish:${updatedPost.id}:${updatedPost.version}`;
    const publicationJob = await this.prisma.publicationJob.create({
      data: {
        postId: updatedPost.id,
        postVersion: updatedPost.version,
        idempotencyKey,
        channelId: updatedPost.channelId,
        status: PublicationJobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        scheduledFor: scheduledDate,
        telegramMessageIds: [],
      },
    });

    // 5. Enqueue delayed BullMQ job
    const delayMs = Math.max(0, scheduledDate.getTime() - Date.now());

    await this.publicationQueue.add(
      JOB_NAMES.PUBLISH_POST,
      {
        publicationJobId: publicationJob.id,
        postId: updatedPost.id,
        postVersion: updatedPost.version,
        channelId: updatedPost.channelId,
        actorId,
        isScheduled: true,
        enqueuedAt: new Date().toISOString(),
      },
      {
        jobId: publicationJob.id,
        delay: delayMs,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    this.logger?.log({
      event: 'post_scheduled',
      postId: updatedPost.id,
      jobId: publicationJob.id,
      scheduledAt: scheduledDate.toISOString(),
      delayMs,
    });

    return updatedPost;
  }

  /**
   * Cancels a scheduled post.
   * Verifies CANCEL_SCHEDULE permission, removes BullMQ delayed job,
   * updates DB job status to CANCELLED, and transitions post state SCHEDULED -> CANCELLED.
   */
  async cancelSchedule(
    postId: string,
    actorId: string,
    expectedVersion?: number,
  ): Promise<Post> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.deletedAt !== null) {
      throw new ValidationException(`Post "${postId}" not found or deleted.`);
    }

    if (post.status !== PostStatus.SCHEDULED) {
      throw new InvalidPostStateTransitionException(post.status, PostStatus.CANCELLED);
    }

    // 1. Permission Check
    const canCancel = await this.permissionService.checkChannelPermission(
      actorId,
      post.channelId,
      ChannelPermission.CANCEL_SCHEDULE,
    );
    if (!canCancel) {
      throw new PermissionDeniedException(ChannelPermission.CANCEL_SCHEDULE, post.channelId);
    }

    // 2. Remove delayed BullMQ job and update PublicationJob in PostgreSQL
    const pendingJob = await this.prisma.publicationJob.findFirst({
      where: {
        postId: post.id,
        status: PublicationJobStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (pendingJob) {
      const bullJob = await this.publicationQueue.getJob(pendingJob.id);
      if (bullJob) {
        await bullJob.remove();
      }
      await this.prisma.publicationJob.update({
        where: { id: pendingJob.id },
        data: { status: PublicationJobStatus.CANCELLED },
      });
    }

    // 3. State Machine Transition: SCHEDULED -> CANCELLED (OCC increment + Audit Log)
    const cancelledPost = await this.postWorkflow.transition({
      postId: post.id,
      expectedVersion: expectedVersion ?? post.version,
      targetStatus: PostStatus.CANCELLED,
      action: PostAction.CANCEL,
      actorId,
    });

    this.logger?.log({
      event: 'schedule_cancelled',
      postId: cancelledPost.id,
      actorId,
    });

    return cancelledPost;
  }
}
