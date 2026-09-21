# Milestone 2 Architectural Investigation & Technical Design: Post Workflow State Machine, Optimistic Concurrency Control, Soft Deletion, and Reviews

**Author**: `m2_explorer_2` (teamwork_preview_explorer)  
**Date**: 2026-09-21  
**Status**: Ready for Implementation  
**Target Files**:
- `src/common/exceptions/domain.exceptions.ts`
- `src/modules/posts/posts.repository.ts`
- `src/modules/posts/post-workflow.service.ts`
- `src/modules/posts/posts.service.ts`
- `src/modules/posts/dto/` (command & transition DTOs)
- `src/modules/reviews/reviews.service.ts`
- `src/modules/reviews/dto/create-review.dto.ts`

---

## 1. Executive Summary & Architectural Invariants

Milestone 2 establishes the core editorial domain logic of the Telegram Content Publisher Bot. In strict compliance with `AGENTS.md` (§3, §10, §13, §28, §31) and `tasks.md` (§6, §10, §12, §13):

1. **State Machine as Domain Authority**: Post statuses represent discrete editorial business stages, never updated casually. All transitions occur through `PostWorkflowService.transition()`, which enforces state guards, actor authorization, transactional consistency, and append-only audit logging.
2. **Optimistic Concurrency Control (OCC)**: Every post entity tracks an integer `version`. All mutating updates atomically enforce `WHERE id = :id AND version = :expectedVersion AND deleted_at IS NULL` and increment `version = version + 1`. Version mismatches throw `PostConflictException`.
3. **Soft Deletion (`deleted_at = NOW()`)**: Drafts and posts are soft-deleted to preserve referential integrity and audit records. Standard repository queries strictly filter `deleted_at IS NULL`. Any mutating or publishing attempt against a soft-deleted post fails explicitly.
4. **Editorial Reviews & Mandatory Feedback**: Review operations (`APPROVE`, `REQUEST_REVISION`, `REJECT`) create durable `PostReview` records. In particular, `REQUEST_REVISION` strictly mandates a non-empty feedback comment per `tasks.md` §13.
5. **Atomic Transactions**: Per `AGENTS.md` §28, post state transitions, review creation, and audit logging execute within a single short `prisma.$transaction`. Secondary side effects (notifications) execute post-commit to ensure notification failures cannot corrupt database state.

---

## 2. Post Workflow State Machine (`PostWorkflowService`)

### 2.1 The 10 Post Statuses

The post lifecycle is defined by 10 distinct states (`PostStatus` enum in Prisma and `src/common/enums/index.ts`):

| Status | Category | Description |
|---|---|---|
| `DRAFT` | Authoring | Initial post creation or in-progress autosaved draft. |
| `PENDING_REVIEW` | Editorial | Post submitted by author or editor for editorial review. |
| `APPROVED` | Editorial | Post reviewed and approved by an editor/admin. Ready for scheduling or immediate publishing. |
| `NEEDS_REVISION` | Editorial | Post returned to author with mandatory editorial feedback comment. |
| `REJECTED` | Editorial | Post rejected by editor/admin. Terminal review state for current submission. |
| `SCHEDULED` | Scheduling | Approved post configured for delayed publication at a future timestamp (`scheduled_at > NOW()`). |
| `PUBLISHING` | Publishing | Active, in-flight publication job handled by background BullMQ worker. |
| `PUBLISHED` | Terminal | Post successfully broadcast to the Telegram channel. |
| `PUBLISH_FAILED` | Recovery | Publication failed (e.g. fatal API error or retry exhaustion). Awaiting manual retry or cancellation. |
| `CANCELLED` | Terminal | Publication cancelled by editor/admin (from `SCHEDULED` or `PUBLISH_FAILED`). |

---

### 2.2 Allowed Transitions Matrix

Per `tasks.md` §6 and `AGENTS.md` §10, any transition not explicitly listed in this matrix is illegal and **MUST** throw `InvalidPostStateTransitionException`.

```text
               ┌──────────┐
               │  DRAFT   │
               └────┬─────┘
                    │ (SUBMIT)
                    ▼
          ┌──────────────────┐
          │  PENDING_REVIEW  │◄─────────────────┐
          └──┬──────┬──────┬─┘                  │
   (APPROVE) │      │      │ (REVISION)         │ (RESUBMIT)
             │      │      └──────────┐         │
             ▼      ▼                 ▼         │
        ┌────────┐ ┌────────┐ ┌────────────────┐│
        │APPROVED│ │REJECTED│ │ NEEDS_REVISION ├┘
        └───┬─┬──┘ └────────┘ └────────────────┘
(SCHEDULE)  │ │ (PUBLISH)
     ┌──────┘ └──────┐
     ▼               │
┌─────────┐          │
│SCHEDULED│          │
└───┬─┬───┘          │
    │ └───────┐      │
    │(CANCEL) │      │
    ▼         ▼      ▼
┌─────────┐ ┌──────────┐
│CANCELLED│ │PUBLISHING│
└────▲────┘ └──┬─────┬─┘
     │         │     │ (FAIL)
     │(CANCEL) ▼     ▼
     │      ┌─────────┐ ┌──────────────┐
     └──────┤PUBLISHED│ │PUBLISH_FAILED│
            └─────────┘ └──────┬───────┘
                               │ (RETRY)
                               └─────────► to PUBLISHING
```

#### Transition Specification Table

| Source Status | Target Status | PostAction | Allowed Actors | Invariants / Validation | Side Effects |
|---|---|---|---|---|---|
| `DRAFT` | `PENDING_REVIEW` | `SUBMIT_FOR_REVIEW` | Author (`post.authorId === actorId`), Editor, Super Admin | Post not deleted; required fields exist per template schema | Audit `submitted_for_review`; notify editors |
| `PENDING_REVIEW` | `APPROVED` | `APPROVE` | Editor with `can_approve`, Super Admin | Author cannot self-approve without `can_approve` | Create `PostReview` (APPROVE); audit `approved`; notify author |
| `PENDING_REVIEW` | `NEEDS_REVISION` | `REQUEST_REVISION` | Editor with `can_approve`, Super Admin | **Mandatory non-empty comment** (`comment.trim().length > 0`) | Create `PostReview` (REQUEST_REVISION); audit `revision_requested`; notify author with comment |
| `PENDING_REVIEW` | `REJECTED` | `REJECT` | Editor with `can_approve`, Super Admin | Optional feedback comment | Create `PostReview` (REJECT); audit `rejected`; notify author |
| `NEEDS_REVISION` | `PENDING_REVIEW` | `SUBMIT_FOR_REVIEW` | Author (`post.authorId === actorId`), Editor, Super Admin | Post updated; ready for re-evaluation | Audit `submitted_for_review`; notify editors |
| `APPROVED` | `SCHEDULED` | `SCHEDULE` | Channel Member with `can_publish`, Super Admin | `scheduled_at` strictly in future (`> NOW()`) | Persist `scheduledAt`; audit `scheduled`; notify author |
| `SCHEDULED` | `CANCELLED` | `CANCEL` | Editor/Admin with `can_publish`, Super Admin | Post currently `SCHEDULED` | Audit `schedule_cancelled`; remove BullMQ job |
| `APPROVED` | `PUBLISHING` | `START_PUBLISHING` | Publisher Worker or Channel Member with `can_publish`, Super Admin | Channel active; bot permissions verified | Audit `publication_started` |
| `SCHEDULED` | `PUBLISHING` | `START_PUBLISHING` | Background Worker when schedule triggered | Preflight checks pass | Audit `publication_started` |
| `PUBLISHING` | `PUBLISHED` | `MARK_PUBLISHED` | Background Worker | Telegram API calls succeeded | Set `publishedAt = NOW()`; audit `publication_completed`; notify author/channel |
| `PUBLISHING` | `PUBLISH_FAILED` | `MARK_PUBLISH_FAILED` | Background Worker | Retries exhausted or fatal unrecoverable API error | Persist `errorMessage`; audit `publication_failed`; notify editors |
| `PUBLISH_FAILED` | `PUBLISHING` | `START_PUBLISHING` | Channel Member with `can_publish`, Super Admin (manual retry), or Worker | Post in `PUBLISH_FAILED` | Audit `publication_started` |
| `PUBLISH_FAILED` | `CANCELLED` | `CANCEL` | Editor with `can_publish`, Super Admin | Post in `PUBLISH_FAILED` | Audit `publication_cancelled` |

---

### 2.3 Exception Hierarchy & Compatibility

To satisfy the exact requirement from the dispatch prompt while maintaining 100% backward compatibility with existing tests (`tests/e2e/tier1-feature-coverage.spec.ts`, `tier3`, `tier4`):

```ts
// src/common/exceptions/domain.exceptions.ts

export class InvalidPostStateTransitionException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_STATE_TRANSITION';

  constructor(currentStatus: string, attemptedActionOrTarget: string) {
    super(`Invalid status transition from ${currentStatus} to ${attemptedActionOrTarget}.`);
  }
}

// Alias to guarantee full compatibility with existing tests and imports
export const InvalidStateTransitionException = InvalidPostStateTransitionException;
export type InvalidStateTransitionException = InvalidPostStateTransitionException;
```

---

## 3. Optimistic Concurrency Control (OCC) Design

### 3.1 The Race Condition & Business Requirement

In a multi-user editorial system:
- Two editors may open the same post simultaneously to edit tags or rubric.
- An author might submit a draft while an editor is reviewing an earlier version.
- A background worker might transition an approved post to `PUBLISHING` right as an editor attempts to `CANCEL` the post.

Without OCC, the second writer silently overwrites the first writer's changes (lost updates).

Per `tasks.md` §12 and `AGENTS.md` §13:
- The `posts` table has `version INTEGER DEFAULT 1`.
- Every mutating update must check `WHERE id = :id AND version = :expectedVersion`.
- If another process incremented `version`, 0 rows match. The update fails immediately with `PostConflictException`.
- The user is notified with the exact message:
  `"Публикация была изменена другим пользователем. Откройте актуальную версию и повторите изменение."`

### 3.2 Prisma OCC Implementation: `updateMany` Pattern

Prisma's `update` method enforces uniqueness only on predefined unique fields. Because `[id, version]` is not a composite unique constraint in `schema.prisma`, the idiomatic and atomic Prisma pattern is `updateMany`:

```ts
// src/modules/posts/posts.repository.ts

async updateWithOcc(
  postId: string,
  expectedVersion: number,
  data: Prisma.PostUpdateInput,
  tx?: Prisma.TransactionClient,
): Promise<Post> {
  const prismaClient = tx || this.prisma;

  const result = await prismaClient.post.updateMany({
    where: {
      id: postId,
      version: expectedVersion,
      deletedAt: null, // soft-deleted posts can never be modified
    },
    data: {
      ...data,
      version: { increment: 1 },
      updatedAt: new Date(),
    },
  });

  if (result.count === 0) {
    // Investigate whether post is missing/deleted or version conflict occurred
    const existing = await prismaClient.post.findUnique({
      where: { id: postId },
      select: { id: true, version: true, deletedAt: true },
    });

    if (!existing || existing.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found or deleted.`);
    }

    throw new PostConflictException(
      `Публикация была изменена другим пользователем. Expected version ${expectedVersion}, but found ${existing.version}.`,
    );
  }

  return prismaClient.post.findUniqueOrThrow({
    where: { id: postId },
    include: {
      media: { orderBy: { sortOrder: 'asc' } },
      reviews: { orderBy: { createdAt: 'desc' } },
    },
  });
}
```

#### Why this satisfies all architectural requirements:
1. **Atomic Execution**: In PostgreSQL, `UPDATE ... WHERE id = $1 AND version = $2 AND deleted_at IS NULL` executes as a single atomic row lock.
2. **Zero In-Memory State**: The database is the single source of truth (`AGENTS.md` §11).
3. **Exact Error Feedback**: When `result.count === 0`, we query the post to provide precise diagnostics: `PostConflictException` with the Russian message expected by `tier2-boundary-cases.spec.ts` line 145!

---

## 4. Soft Deletion Design (`deleted_at = NOW()`)

### 4.1 Invariants & Requirements (`AGENTS.md` §31, `tasks.md` §9)

1. **Non-Destructive Deletion**: Records in `posts` are NEVER deleted via SQL `DELETE`. Soft delete executes `UPDATE posts SET deleted_at = NOW(), version = version + 1 WHERE id = :id`.
2. **Transparent Query Exclusion**: All standard application queries (channel feed, draft recovery, review queue, scheduling queries) must include `deletedAt: null`.
3. **Workflow Rejection**: Any attempt to perform `autosaveStep`, `transitionState`, `schedulePost`, or `enqueuePublishJob` on a post where `deletedAt !== null` immediately rejects with `ValidationError('Post not found or deleted.')`.
4. **Audit Trail Preservation**: Audit logs and review records referencing the post are preserved forever.
5. **No Silent Resurfacing**: A soft-deleted post can never return to active status without an explicit administrative restore mechanism.

### 4.2 Repository Query Helpers

```ts
// PostsRepository query filters

private get activeFilter(): Prisma.PostWhereInput {
  return { deletedAt: null };
}

async findById(id: string, includeDeleted = false): Promise<Post | null> {
  return this.prisma.post.findFirst({
    where: {
      id,
      ...(includeDeleted ? {} : this.activeFilter),
    },
    include: { media: true, reviews: true, template: true },
  });
}

async findPendingReview(channelId: string): Promise<Post[]> {
  return this.prisma.post.findMany({
    where: {
      channelId,
      status: PostStatus.PENDING_REVIEW,
      deletedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
}
```

---

## 5. Editorial Reviews Service (`ReviewsService`)

### 5.1 Service Responsibilities (`src/modules/reviews/`)

The `ReviewsService` manages the editorial review lifecycle (`tasks.md` §13, `AGENTS.md` §10):
1. **Review Actions**:
   - `APPROVE`: Editor marks post ready for publication. Comment is optional.
   - `REQUEST_REVISION`: Editor returns post to author for changes. **Comment is strictly mandatory and non-empty**.
   - `REJECT`: Editor rejects publication. Comment is optional.
2. **Mandatory Feedback Invariant**:
   ```ts
   if (action === ReviewAction.REQUEST_REVISION) {
     if (!comment || comment.trim() === '') {
       throw new ValidationError('Для возврата на доработку обязателен комментарий.');
     }
   }
   ```
   Whitespace-only strings (`'   \n\t  '`) are rejected per `tier2-boundary-cases.spec.ts` line 70.
3. **Review Card Context**:
   The service provides `getLatestReview(postId)` so that when an author opens a post in `NEEDS_REVISION`, the bot displays the editor's constructive feedback.

### 5.2 Transactional Atomicity (`AGENTS.md` §28)

Per `AGENTS.md` §28:
> "Use database transactions when multiple related writes form one logical state transition:
> post status change + review history entry + audit record"

```ts
// Atomic execution inside PostWorkflowService:

await this.prisma.$transaction(async (tx) => {
  // 1. OCC State transition
  const updatedPost = await this.postsRepository.updateWithOcc(
    postId,
    expectedVersion,
    { status: targetStatus },
    tx,
  );

  // 2. Insert Review record if action is editorial
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

  // 3. Append-only Audit Log
  await this.auditLogService.record(
    {
      actorId,
      action: auditAction,
      entityType: 'post',
      entityId: postId,
      payload: { comment, scheduledAt, targetStatus },
    },
    tx,
  );

  return updatedPost;
});
// 4. Post-commit notification (outside transaction so failure doesn't rollback DB)
await this.notificationService.notify(...);
```

---

## 6. Concrete Implementation Interfaces & Code Specifications

### 6.1 `src/common/exceptions/domain.exceptions.ts` Enhancements

```ts
export class InvalidPostStateTransitionException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_STATE_TRANSITION';

  constructor(currentStatus: string, attemptedActionOrTarget: string) {
    super(`Invalid status transition from ${currentStatus} to ${attemptedActionOrTarget}.`);
  }
}

// Ensure both aliases are exported for backward compatibility
export const InvalidStateTransitionException = InvalidPostStateTransitionException;
export type InvalidStateTransitionException = InvalidPostStateTransitionException;

export class PostConflictException extends DomainException {
  readonly statusCode = 409;
  readonly errorCode = 'POST_CONFLICT';

  constructor(postIdOrMessage: string, expectedVersion?: number, actualVersion?: number) {
    const message = expectedVersion !== undefined
      ? `Публикация была изменена другим пользователем. Optimistic concurrency conflict on post "${postIdOrMessage}". Expected version ${expectedVersion}, but found ${actualVersion ?? 'different'}.`
      : postIdOrMessage;
    super(message);
  }
}

export class ValidationException extends DomainException {
  readonly statusCode = 400;
  readonly errorCode = 'VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
  }
}

export const ValidationError = ValidationException;
export type ValidationError = ValidationException;
```

---

### 6.2 `src/modules/posts/post-workflow.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostsRepository } from './posts.repository';
import { ReviewsService } from '../reviews/reviews.service';
import { AuditLogService } from '../audit/audit-log.service';
import { NotificationService } from '../notifications/notification.service';
import { PermissionService } from '../auth/permission.service';
import {
  PostStatus,
  PostAction,
  ReviewAction,
} from '../../common/enums';
import {
  InvalidPostStateTransitionException,
  PermissionDeniedException,
  ValidationError,
  PostNotFoundException,
} from '../../common/exceptions/domain.exceptions';
import { Post, Prisma } from '@prisma/client';

export interface TransitionPostCommand {
  postId: string;
  expectedVersion: number;
  targetStatus: PostStatus;
  actorId: string;
  comment?: string;
  scheduledAt?: Date;
}

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

@Injectable()
export class PostWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRepository: PostsRepository,
    private readonly reviewsService: ReviewsService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
    private readonly permissionService: PermissionService,
  ) {}

  async transition(command: TransitionPostCommand): Promise<Post> {
    const { postId, expectedVersion, targetStatus, actorId, comment, scheduledAt } = command;

    const post = await this.postsRepository.findById(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found or deleted.`);
    }

    // 1. Verify Allowed State Transitions
    const allowed = ALLOWED_TRANSITIONS[post.status] || [];
    if (!allowed.includes(targetStatus)) {
      throw new InvalidPostStateTransitionException(post.status, targetStatus);
    }

    // 2. Verify Actor Authorization & Business Invariants
    let reviewAction: ReviewAction | null = null;
    let auditAction = '';

    switch (targetStatus) {
      case PostStatus.PENDING_REVIEW: {
        const canSubmit = post.authorId === actorId ||
          (await this.permissionService.checkPermission(actorId, post.channelId, 'SUBMIT_REVIEW'));
        if (!canSubmit) {
          throw new PermissionDeniedException('SUBMIT_REVIEW', post.channelId);
        }
        auditAction = 'submitted_for_review';
        break;
      }

      case PostStatus.APPROVED: {
        const canApprove = await this.permissionService.checkPermission(actorId, post.channelId, 'APPROVE_POST');
        if (!canApprove) {
          throw new PermissionDeniedException('APPROVE_POST', post.channelId);
        }
        reviewAction = ReviewAction.APPROVE;
        auditAction = 'approved';
        break;
      }

      case PostStatus.NEEDS_REVISION: {
        const canApprove = await this.permissionService.checkPermission(actorId, post.channelId, 'APPROVE_POST');
        if (!canApprove) {
          throw new PermissionDeniedException('APPROVE_POST', post.channelId);
        }
        if (!comment || comment.trim() === '') {
          throw new ValidationError('Для возврата на доработку обязателен комментарий.');
        }
        reviewAction = ReviewAction.REQUEST_REVISION;
        auditAction = 'revision_requested';
        break;
      }

      case PostStatus.REJECTED: {
        const canReject = await this.permissionService.checkPermission(actorId, post.channelId, 'REJECT_POST');
        if (!canReject) {
          throw new PermissionDeniedException('REJECT_POST', post.channelId);
        }
        reviewAction = ReviewAction.REJECT;
        auditAction = 'rejected';
        break;
      }

      case PostStatus.SCHEDULED: {
        const canPublish = await this.permissionService.checkPermission(actorId, post.channelId, 'PUBLISH_POST');
        if (!canPublish) {
          throw new PermissionDeniedException('PUBLISH_POST', post.channelId);
        }
        if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
          throw new ValidationError('Нельзя планировать публикацию в прошлом.');
        }
        auditAction = 'scheduled';
        break;
      }

      case PostStatus.CANCELLED: {
        const canCancel = await this.permissionService.checkPermission(actorId, post.channelId, 'PUBLISH_POST');
        if (!canCancel) {
          throw new PermissionDeniedException('CANCEL_SCHEDULE', post.channelId);
        }
        auditAction = post.status === PostStatus.SCHEDULED ? 'schedule_cancelled' : 'publication_cancelled';
        break;
      }

      case PostStatus.PUBLISHING: {
        auditAction = 'publication_started';
        break;
      }

      case PostStatus.PUBLISHED: {
        auditAction = 'publication_completed';
        break;
      }

      case PostStatus.PUBLISH_FAILED: {
        auditAction = 'publication_failed';
        break;
      }
    }

    // 3. Atomic Database Transaction: OCC Update + Review + Audit
    const updateData: Prisma.PostUpdateInput = {
      status: targetStatus,
    };
    if (scheduledAt) {
      updateData.scheduledAt = scheduledAt;
    }
    if (targetStatus === PostStatus.PUBLISHED) {
      updateData.publishedAt = new Date();
    }

    const updatedPost = await this.prisma.$transaction(async (tx) => {
      const postUpdated = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        updateData,
        tx,
      );

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

      await this.auditLogService.record(
        {
          actorId,
          action: auditAction,
          entityType: 'post',
          entityId: postId,
          payload: { comment, scheduledAt: scheduledAt?.toISOString(), targetStatus },
        },
        tx,
      );

      return postUpdated;
    });

    // 4. Decoupled Notifications Post-Commit
    this.dispatchNotifications(updatedPost, targetStatus, actorId, comment, scheduledAt).catch(() => {});

    return updatedPost;
  }

  private async dispatchNotifications(
    post: Post,
    targetStatus: PostStatus,
    actorId: string,
    comment?: string,
    scheduledAt?: Date,
  ): Promise<void> {
    switch (targetStatus) {
      case PostStatus.PENDING_REVIEW:
        await this.notificationService.notifyEditorsOnSubmission(post);
        break;
      case PostStatus.APPROVED:
        await this.notificationService.notifyAuthor(post.authorId, 'approved', post.id);
        break;
      case PostStatus.NEEDS_REVISION:
        await this.notificationService.notifyAuthor(post.authorId, 'revision_requested', post.id, { comment });
        break;
      case PostStatus.REJECTED:
        await this.notificationService.notifyAuthor(post.authorId, 'rejected', post.id);
        break;
      case PostStatus.SCHEDULED:
        await this.notificationService.notifyAuthor(post.authorId, 'scheduled', post.id, { scheduledAt });
        break;
    }
  }
}
```

---

### 6.3 `src/modules/reviews/reviews.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ReviewAction, PostReview, Prisma } from '@prisma/client';
import { ValidationError } from '../../common/exceptions/domain.exceptions';

export interface CreateReviewDto {
  postId: string;
  reviewerId: string;
  action: ReviewAction;
  comment?: string | null;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async createReview(dto: CreateReviewDto, tx?: Prisma.TransactionClient): Promise<PostReview> {
    const client = tx || this.prisma;

    if (dto.action === ReviewAction.REQUEST_REVISION) {
      if (!dto.comment || dto.comment.trim() === '') {
        throw new ValidationError('Для возврата на доработку обязателен комментарий.');
      }
    }

    return client.postReview.create({
      data: {
        postId: dto.postId,
        reviewerId: dto.reviewerId,
        action: dto.action,
        comment: dto.comment ? dto.comment.trim() : null,
      },
    });
  }

  async getReviewsForPost(postId: string): Promise<PostReview[]> {
    return this.prisma.postReview.findMany({
      where: { postId },
      orderBy: { createdAt: 'asc' },
      include: {
        reviewer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        },
      },
    });
  }

  async getLatestReview(postId: string): Promise<PostReview | null> {
    return this.prisma.postReview.findFirst({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      include: {
        reviewer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        },
      },
    });
  }
}
```

---

## 7. Concrete Implementation Steps for the Worker

To implement Milestone 2 smoothly and pass all test suites, the Worker should execute the following steps in sequence:

### Step 1: Update Domain Exceptions (`src/common/exceptions/domain.exceptions.ts`)
1. Add `InvalidPostStateTransitionException` (with alias `InvalidStateTransitionException`).
2. Update `PostConflictException` to accept optional Russian message or prepend `Публикация была изменена другим пользователем.` so tests matching `/Публикация была изменена другим пользователем/i` pass unconditionally.
3. Export `export const ValidationError = ValidationException;`.

### Step 2: Implement `PostsRepository` (`src/modules/posts/posts.repository.ts`)
1. Implement `findById(id, includeDeleted = false)`.
2. Implement `createDraft(authorId, channelId, templateId)`.
3. Implement `updateWithOcc(postId, expectedVersion, data, tx?)` using `prismaClient.post.updateMany` checking `WHERE id = :id AND version = :expectedVersion AND deletedAt IS NULL`.
4. Implement `softDelete(postId, expectedVersion, actorId)` with OCC update setting `deletedAt = new Date()`.

### Step 3: Implement `ReviewsService` (`src/modules/reviews/`)
1. Create `reviews.service.ts` with `createReview`, `getReviewsForPost`, `getLatestReview`.
2. Strictly enforce non-empty comment on `REQUEST_REVISION` throwing `ValidationError('Для возврата на доработку обязателен комментарий.')`.
3. Create `reviews.module.ts` exporting `ReviewsService`.

### Step 4: Implement `PostWorkflowService` (`src/modules/posts/post-workflow.service.ts`)
1. Implement `transition(command: TransitionPostCommand)`.
2. Enforce `ALLOWED_TRANSITIONS` matrix (throwing `InvalidPostStateTransitionException` on mismatch).
3. Validate actor permissions via `PermissionService`.
4. Run OCC update + `ReviewsService.createReview` + `AuditLogService.record` inside `prisma.$transaction`.
5. Dispatch post-commit notifications.

### Step 5: Implement `PostsService` (`src/modules/posts/posts.service.ts`)
1. Implement `autosaveStep(postId, expectedVersion, actorId, fieldKey, fieldValue)`:
   - Verifies permissions (author or editor).
   - Validates template schema constraints (maxLength).
   - Updates `contentJson` via `PostsRepository.updateWithOcc`.
   - Silent autosave: emits zero notifications per Rule F-40.
2. Implement `softDeletePost(postId, expectedVersion, actorId)`:
   - Verifies author or editor permission.
   - Executes soft delete and logs audit `post_deleted`.

### Step 6: Register Modules in NestJS
1. Provide `PostsRepository`, `PostsService`, `PostWorkflowService` in `PostsModule`.
2. Import `PostsModule` and `ReviewsModule` into `AppModule`.

### Step 7: Verification Commands
1. Run E2E suites:
   ```bash
   npm run test:e2e
   ```
2. Run Jest unit test suite:
   ```bash
   npm test
   ```
3. Run TypeScript check:
   ```bash
   npx tsc --noEmit
   ```
