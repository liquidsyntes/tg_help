/**
 * PublishingService
 * Manages post publication enqueueing, idempotency key generation, and BullMQ queue interaction.
 * Authoritative reference: AGENTS.md § 20, § 21, § 22; tasks.md § 20, § 21, § 22
 */

import { Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PublicationJob, PublicationJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PublishingPreflightService } from './publishing-preflight.service';
import { AuditService } from '../audit/audit.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { PUBLICATION_QUEUE_NAME, JOB_NAMES } from '../../common/constants/queue-names';
import { AuditAction } from '../../common/enums';
import { PublishJobData } from './interfaces/publish-job-data.interface';

@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preflightService: PublishingPreflightService,
    private readonly auditService: AuditService,
    @InjectQueue(PUBLICATION_QUEUE_NAME)
    private readonly publicationQueue: Queue<PublishJobData>,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  /**
   * Enqueues an approved or publish_failed post for publication.
   * Performs Stage 1 preflight, generates durable idempotency key,
   * creates PublicationJob record in DB, and adds job to BullMQ.
   */
  async enqueuePublish(postId: string, actorId: string): Promise<PublicationJob> {
    // 1. Stage 1 Preflight Validation
    const { post } = await this.preflightService.validateStage1(postId, actorId);

    // 2. Canonical Idempotency Key: publish:{postId}:{postVersion}
    const idempotencyKey = `publish:${post.id}:${post.version}`;

    // 3. Check for existing PublicationJob in PostgreSQL
    const existingJob = await this.prisma.publicationJob.findUnique({
      where: { idempotencyKey },
    });
    if (existingJob) {
      this.logger?.log({
        event: 'publication_job_duplicate_ignored',
        postId: post.id,
        idempotencyKey,
        jobId: existingJob.id,
      });
      return existingJob;
    }

    // 4. Provision durable PublicationJob in DB (handles race condition via unique constraint)
    let publicationJob: PublicationJob;
    try {
      publicationJob = await this.prisma.publicationJob.create({
        data: {
          postId: post.id,
          postVersion: post.version,
          idempotencyKey,
          channelId: post.channelId,
          status: PublicationJobStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
          telegramMessageIds: [],
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // P2002: Unique constraint violation on idempotencyKey -> return existing
        return this.prisma.publicationJob.findUniqueOrThrow({
          where: { idempotencyKey },
        });
      }
      throw err;
    }

    // 5. Add Job to BullMQ Queue
    await this.publicationQueue.add(
      JOB_NAMES.PUBLISH_POST,
      {
        publicationJobId: publicationJob.id,
        postId: post.id,
        postVersion: post.version,
        channelId: post.channelId,
        actorId,
        enqueuedAt: new Date().toISOString(),
      },
      {
        jobId: idempotencyKey, // Queue-level deduplication
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    // 6. Record Audit Log
    await this.auditService.record({
      action: AuditAction.PUBLICATION_JOB_CREATED,
      entityType: 'publication_job',
      entityId: publicationJob.id,
      actorId,
      payload: {
        postId: post.id,
        postVersion: post.version,
        idempotencyKey,
      },
    });

    this.logger?.log({
      event: 'publication_job_enqueued',
      postId: post.id,
      jobId: publicationJob.id,
      idempotencyKey,
    });

    return publicationJob;
  }

  async getJobById(id: string): Promise<PublicationJob | null> {
    return this.prisma.publicationJob.findUnique({
      where: { id },
    });
  }

  async getJobByIdempotencyKey(idempotencyKey: string): Promise<PublicationJob | null> {
    return this.prisma.publicationJob.findUnique({
      where: { idempotencyKey },
    });
  }
}
