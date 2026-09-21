import { Injectable } from '@nestjs/common';
import { Post, Prisma, PostStatus, ReviewAction } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostsRepository } from './posts.repository';
import { ReviewsService } from '../reviews/reviews.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../notifications/domain-event.bus';
import { PermissionService } from '../auth/permission.service';
import {
  PostAction,
  ChannelPermission,
  AuditAction,
} from '../../common/enums';
import {
  InvalidPostStateTransitionException,
  PermissionDeniedException,
  ValidationException,
} from '../../common/exceptions/domain.exceptions';
import {
  PostSubmittedEvent,
  PostApprovedEvent,
  PostRevisionRequestedEvent,
  PostRejectedEvent,
  PostScheduledEvent,
  PostPublishedEvent,
  PostPublicationFailedEvent,
} from '../notifications/events/domain-events';
import { TransitionPostDto } from './dto/transition-post.dto';

const ALLOWED_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  [PostStatus.DRAFT]: [PostStatus.PENDING_REVIEW],
  [PostStatus.PENDING_REVIEW]: [PostStatus.APPROVED, PostStatus.NEEDS_REVISION, PostStatus.REJECTED],
  [PostStatus.NEEDS_REVISION]: [PostStatus.PENDING_REVIEW],
  [PostStatus.APPROVED]: [PostStatus.SCHEDULED, PostStatus.PUBLISHING],
  [PostStatus.SCHEDULED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED],
  [PostStatus.PUBLISHING]: [PostStatus.PUBLISHED, PostStatus.PUBLISH_FAILED],
  [PostStatus.PUBLISH_FAILED]: [PostStatus.PUBLISHING, PostStatus.CANCELLED],
  [PostStatus.REJECTED]: [],
  [PostStatus.CANCELLED]: [],
  [PostStatus.PUBLISHED]: [],
};

const ACTION_TARGET_MAP: Record<PostAction, PostStatus> = {
  [PostAction.SUBMIT_FOR_REVIEW]: PostStatus.PENDING_REVIEW,
  [PostAction.APPROVE]: PostStatus.APPROVED,
  [PostAction.REQUEST_REVISION]: PostStatus.NEEDS_REVISION,
  [PostAction.REJECT]: PostStatus.REJECTED,
  [PostAction.SCHEDULE]: PostStatus.SCHEDULED,
  [PostAction.START_PUBLISHING]: PostStatus.PUBLISHING,
  [PostAction.MARK_PUBLISHED]: PostStatus.PUBLISHED,
  [PostAction.MARK_PUBLISH_FAILED]: PostStatus.PUBLISH_FAILED,
  [PostAction.CANCEL]: PostStatus.CANCELLED,
};

@Injectable()
export class PostWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRepository: PostsRepository,
    private readonly reviewsService: ReviewsService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Executes an atomic state transition:
   * 1. Validates state transition legality according to the 10-status state machine.
   * 2. Evaluates actor RBAC permissions.
   * 3. Executes atomic Prisma transaction: OCC update (version+1) + Review record + Audit log.
   * 4. Dispatches decoupled domain events post-commit.
   */
  async transition(command: TransitionPostDto): Promise<Post> {
    const { postId, expectedVersion, actorId, comment, scheduledAt } = command;

    const post = await this.postsRepository.findById(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationException(`Post "${postId}" not found or deleted.`);
    }

    // Resolve target status from DTO or action
    let targetStatus = command.targetStatus;
    if (!targetStatus && command.action) {
      targetStatus = ACTION_TARGET_MAP[command.action];
    }

    if (!targetStatus) {
      throw new ValidationException('Target status or valid PostAction must be specified.');
    }

    // 1. Validate State Transition Legality
    const allowedTargets = ALLOWED_TRANSITIONS[post.status] || [];
    if (!allowedTargets.includes(targetStatus)) {
      throw new InvalidPostStateTransitionException(post.status, targetStatus);
    }

    // 2. Validate Actor Permissions & Invariants
    let reviewAction: ReviewAction | null = null;
    let auditAction: AuditAction | string = AuditAction.POST_UPDATED;

    switch (targetStatus) {
      case PostStatus.PENDING_REVIEW: {
        const isAuthor = post.authorId === actorId;
        const canSubmit =
          isAuthor ||
          (await this.permissionService.checkChannelPermission(
            actorId,
            post.channelId,
            ChannelPermission.SUBMIT_REVIEW,
          ));
        if (!canSubmit) {
          throw new PermissionDeniedException(ChannelPermission.SUBMIT_REVIEW, post.channelId);
        }
        auditAction = AuditAction.SUBMITTED_FOR_REVIEW;
        break;
      }

      case PostStatus.APPROVED: {
        const canApprove = await this.permissionService.checkChannelPermission(
          actorId,
          post.channelId,
          ChannelPermission.APPROVE_POST,
        );
        if (!canApprove) {
          throw new PermissionDeniedException(ChannelPermission.APPROVE_POST, post.channelId);
        }
        reviewAction = ReviewAction.APPROVE;
        auditAction = AuditAction.APPROVED;
        break;
      }

      case PostStatus.NEEDS_REVISION: {
        const canApprove = await this.permissionService.checkChannelPermission(
          actorId,
          post.channelId,
          ChannelPermission.APPROVE_POST,
        );
        if (!canApprove) {
          throw new PermissionDeniedException(ChannelPermission.APPROVE_POST, post.channelId);
        }
        if (!comment || comment.trim().length === 0) {
          throw new ValidationException('Для возврата на доработку обязателен комментарий.');
        }
        reviewAction = ReviewAction.REQUEST_REVISION;
        auditAction = AuditAction.REVISION_REQUESTED;
        break;
      }

      case PostStatus.REJECTED: {
        const canReject = await this.permissionService.checkChannelPermission(
          actorId,
          post.channelId,
          ChannelPermission.REJECT_POST,
        );
        if (!canReject) {
          throw new PermissionDeniedException(ChannelPermission.REJECT_POST, post.channelId);
        }
        reviewAction = ReviewAction.REJECT;
        auditAction = AuditAction.REJECTED;
        break;
      }

      case PostStatus.SCHEDULED: {
        const canPublish = await this.permissionService.checkChannelPermission(
          actorId,
          post.channelId,
          ChannelPermission.PUBLISH_POST,
        );
        if (!canPublish) {
          throw new PermissionDeniedException(ChannelPermission.PUBLISH_POST, post.channelId);
        }
        if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
          throw new ValidationException('Нельзя планировать публикацию в прошлом.');
        }
        auditAction = AuditAction.SCHEDULED;
        break;
      }

      case PostStatus.CANCELLED: {
        const canCancel = await this.permissionService.checkChannelPermission(
          actorId,
          post.channelId,
          ChannelPermission.CANCEL_SCHEDULE,
        );
        if (!canCancel) {
          throw new PermissionDeniedException(ChannelPermission.CANCEL_SCHEDULE, post.channelId);
        }
        auditAction =
          post.status === PostStatus.SCHEDULED
            ? AuditAction.SCHEDULE_CANCELLED
            : AuditAction.PUBLICATION_CANCELLED;
        break;
      }

      case PostStatus.PUBLISHING: {
        auditAction = AuditAction.PUBLICATION_STARTED;
        break;
      }

      case PostStatus.PUBLISHED: {
        auditAction = AuditAction.PUBLISHED;
        break;
      }

      case PostStatus.PUBLISH_FAILED: {
        auditAction = AuditAction.PUBLISH_FAILED;
        break;
      }
    }

    // 3. Prepare Update Payload
    const updatePayload: Prisma.PostUpdateInput = {
      status: targetStatus,
    };
    if (scheduledAt) {
      updatePayload.scheduledAt = scheduledAt;
    }
    if (targetStatus === PostStatus.PUBLISHED) {
      updatePayload.publishedAt = new Date();
    }

    // 4. Atomic Database Transaction: OCC Update + Review Record + Audit Log
    const updatedPost = await this.prisma.$transaction(async (tx) => {
      // Step A: OCC atomic update
      const freshlyUpdated = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        updatePayload,
        tx,
      );

      // Step B: Record Review entry if editorial review action
      if (reviewAction) {
        await this.reviewsService.createReview(
          {
            postId,
            reviewerId: actorId,
            action: reviewAction,
            comment: comment?.trim() || null,
          },
          tx,
        );
      }

      // Step C: Append-only Audit Log
      await this.auditService.record(
        {
          action: auditAction,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            previousStatus: post.status,
            targetStatus,
            expectedVersion,
            newVersion: freshlyUpdated.version,
            comment: comment?.trim() || null,
            scheduledAt: scheduledAt?.toISOString() || null,
          },
        },
        tx,
      );

      return freshlyUpdated;
    });

    // 5. Post-Commit Decoupled Domain Event Dispatch
    this.dispatchDomainEvents(updatedPost, post, targetStatus, actorId, comment, scheduledAt);

    return updatedPost;
  }

  private dispatchDomainEvents(
    updatedPost: Post,
    previousPost: Post,
    targetStatus: PostStatus,
    actorId: string,
    comment?: string | null,
    scheduledAt?: Date | null,
  ): void {
    const postTitle =
      (updatedPost.contentJson as Record<string, unknown>)?.title as string ||
      'Без названия';

    switch (targetStatus) {
      case PostStatus.PENDING_REVIEW:
        this.eventBus.publish(
          new PostSubmittedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            postTitle,
          ),
        );
        break;

      case PostStatus.APPROVED:
        this.eventBus.publish(
          new PostApprovedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            actorId,
            postTitle,
            comment || undefined,
          ),
        );
        break;

      case PostStatus.NEEDS_REVISION:
        this.eventBus.publish(
          new PostRevisionRequestedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            actorId,
            postTitle,
            comment!,
          ),
        );
        break;

      case PostStatus.REJECTED:
        this.eventBus.publish(
          new PostRejectedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            actorId,
            postTitle,
            comment || undefined,
          ),
        );
        break;

      case PostStatus.SCHEDULED:
        if (scheduledAt) {
          this.eventBus.publish(
            new PostScheduledEvent(
              updatedPost.id,
              updatedPost.channelId,
              updatedPost.authorId,
              postTitle,
              scheduledAt,
            ),
          );
        }
        break;

      case PostStatus.PUBLISHED:
        this.eventBus.publish(
          new PostPublishedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            postTitle,
            [],
          ),
        );
        break;

      case PostStatus.PUBLISH_FAILED:
        this.eventBus.publish(
          new PostPublicationFailedEvent(
            updatedPost.id,
            updatedPost.channelId,
            updatedPost.authorId,
            postTitle,
            3,
            'Publication retry limit reached',
          ),
        );
        break;
    }
  }
}
