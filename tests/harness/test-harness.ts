/**
 * TestHarness & Domain Simulator for Telegram Content Publisher Bot MVP.
 * Implements authoritative domain rules from AGENTS.md, tasks.md, and PROJECT.md.
 * Provides hermetic end-to-end execution without requiring external network services.
 */

import {
  TEST_USERS,
  TEST_CHANNELS,
  TEST_TEMPLATES,
  type TestUser,
  type TestChannel,
  type TestTemplate,
} from '../fixtures/test-data.ts';
import { MockTelegramPublisher, type OutgoingMedia } from '../mocks/mock-telegram-publisher.ts';
import { MockNotificationService } from '../mocks/mock-notification-service.ts';

// Domain Enums
export type PostStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'NEEDS_REVISION'
  | 'REJECTED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'PUBLISH_FAILED'
  | 'CANCELLED';

export type PostAction =
  | 'SUBMIT_FOR_REVIEW'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'REJECT'
  | 'SCHEDULE'
  | 'START_PUBLISHING'
  | 'MARK_PUBLISHED'
  | 'MARK_PUBLISH_FAILED'
  | 'CANCEL';

// Domain Entities
export interface PostEntity {
  id: string;
  channelId: string;
  authorId: string;
  templateId: string;
  title: string | null;
  contentJson: Record<string, unknown>;
  status: PostStatus;
  version: number;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostMediaEntity {
  id: string;
  postId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
  mediaType: 'photo' | 'video' | 'document' | 'animation';
  caption?: string;
  sortOrder: number;
}

export interface ReviewEntity {
  id: string;
  postId: string;
  reviewerId: string;
  action: 'APPROVE' | 'REQUEST_REVISION' | 'REJECT';
  comment: string | null;
  createdAt: Date;
}

export interface PublicationJobEntity {
  id: string;
  postId: string;
  postVersion: number;
  idempotencyKey: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  attemptCount: number;
  maxRetries: number;
  telegramMessageIdsJson: number[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLogEntity {
  id: string;
  actorId: string;
  eventType: string;
  entityType: 'post' | 'user' | 'channel' | 'publication_job';
  entityId: string;
  payloadJson: Record<string, unknown>;
  createdAt: Date;
}

// Domain Exceptions
export class DomainException extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UnauthorizedUserException extends DomainException {}
export class UserDeactivatedException extends DomainException {}
export class PermissionDeniedException extends DomainException {}
export class PostConflictException extends DomainException {}
export class InvalidStateTransitionException extends DomainException {}
export class ValidationError extends DomainException {}
export class ChannelNotFoundException extends DomainException {}

/**
 * Valid allowed state transitions per AGENTS.md § 10 and tasks.md § 6.
 */
const ALLOWED_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  DRAFT: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['APPROVED', 'NEEDS_REVISION', 'REJECTED'],
  NEEDS_REVISION: ['PENDING_REVIEW'],
  APPROVED: ['SCHEDULED', 'PUBLISHING'],
  SCHEDULED: ['PUBLISHING', 'CANCELLED'],
  PUBLISHING: ['PUBLISHED', 'PUBLISH_FAILED'],
  PUBLISH_FAILED: ['PUBLISHING', 'CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
  PUBLISHED: [],
};

/**
 * Telegram HTML Sanitizer per AGENTS.md § 17.
 * Supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>.
 * Strips dangerous tags: <script>, <iframe>, <img onerror>, etc.
 */
export function sanitizeTelegramHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  // 1. Strip script, style, iframe, and embedded event handlers
  let clean = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');

  // 2. Strip unsupported tags while keeping inner content
  const allowedTags = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote'];
  
  clean = clean.replace(/<\/?([a-z0-9]+)(?:\s+[^>]*?)?>/gi, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (!allowedTags.includes(lower)) {
      return ''; // Strip tag, leave inner text
    }
    const isClosing = match.startsWith('</');
    if (isClosing) {
      return `</${lower}>`;
    }
    if (lower === 'a') {
      // Validate href in <a> tag
      const hrefMatch = match.match(/href=["']([^"']*)["']/i);
      if (hrefMatch && (hrefMatch[1].startsWith('http://') || hrefMatch[1].startsWith('https://') || hrefMatch[1].startsWith('tg://'))) {
        return `<a href="${hrefMatch[1]}">`;
      }
      return ''; // Strip invalid <a> tag
    }
    return `<${lower}>`;
  });

  return clean;
}

/**
 * Unified TestHarness coordinating database simulation, worker execution,
 * and external test doubles.
 */
export class TestHarness {
  // Database Tables
  public users: Map<string, TestUser> = new Map();
  public channels: Map<string, TestChannel> = new Map();
  public templates: Map<string, TestTemplate> = new Map();
  public posts: Map<string, PostEntity> = new Map();
  public postMedia: Map<string, PostMediaEntity[]> = new Map();
  public postReviews: ReviewEntity[] = [];
  public publicationJobs: Map<string, PublicationJobEntity> = new Map();
  public auditLogs: AuditLogEntity[] = [];

  // Mocks
  public publisher: MockTelegramPublisher;
  public notifications: MockNotificationService;

  private idCounter = 1;

  constructor() {
    this.publisher = new MockTelegramPublisher();
    this.notifications = new MockNotificationService();
    this.reset();
  }

  /**
   * Resets database to initial seeded fixture state.
   */
  reset(): void {
    this.users.clear();
    this.channels.clear();
    this.templates.clear();
    this.posts.clear();
    this.postMedia.clear();
    this.postReviews = [];
    this.publicationJobs.clear();
    this.auditLogs = [];

    this.publisher.clear();
    this.notifications.clear();
    this.idCounter = 1;

    // Seed fixtures
    Object.values(TEST_USERS).forEach((u) => this.users.set(u.id, { ...u }));
    Object.values(TEST_CHANNELS).forEach((c) => this.channels.set(c.id, { ...c }));
    Object.values(TEST_TEMPLATES).forEach((t) => this.templates.set(t.id, { ...t }));
  }

  // --- Auth & RBAC Domain Service ---

  async resolveUser(telegramUserId: bigint): Promise<TestUser | null> {
    for (const user of this.users.values()) {
      if (user.telegramUserId === telegramUserId) {
        if (!user.isActive) {
          throw new UserDeactivatedException(`User ${telegramUserId} is deactivated.`);
        }
        return user;
      }
    }
    return null;
  }

  async authenticate(telegramUserId: bigint): Promise<TestUser> {
    const user = await this.resolveUser(telegramUserId);
    if (!user) {
      throw new UnauthorizedUserException(`Access denied. User ${telegramUserId} is not registered.`);
    }
    return user;
  }

  async checkPermission(
    actorId: string,
    channelId: string,
    permission: 'CREATE_POST' | 'EDIT_POST' | 'SUBMIT_REVIEW' | 'APPROVE_POST' | 'REJECT_POST' | 'PUBLISH_POST',
  ): Promise<boolean> {
    const user = this.users.get(actorId);
    if (!user || !user.isActive) return false;
    if (user.systemRole === 'SUPER_ADMIN') return true;

    const channel = this.channels.get(channelId);
    if (!channel || !channel.isActive) return false;

    if (permission === 'APPROVE_POST' || permission === 'REJECT_POST') {
      return user.channelRole === 'EDITOR' && user.canApprove;
    }
    if (permission === 'PUBLISH_POST') {
      return (user.channelRole === 'EDITOR' || user.channelRole === 'AUTHOR') && user.canPublish;
    }
    if (permission === 'CREATE_POST' || permission === 'EDIT_POST' || permission === 'SUBMIT_REVIEW') {
      return user.channelRole === 'EDITOR' || user.channelRole === 'AUTHOR';
    }

    return false;
  }

  // --- Post Domain Service with Optimistic Concurrency Control (OCC) ---

  async createDraft(actorId: string, channelId: string, templateId: string): Promise<PostEntity> {
    const canCreate = await this.checkPermission(actorId, channelId, 'CREATE_POST');
    if (!canCreate) {
      throw new PermissionDeniedException(`User ${actorId} is not permitted to create posts in channel ${channelId}`);
    }

    const template = this.templates.get(templateId);
    if (!template) {
      throw new ValidationError(`Template ${templateId} not found.`);
    }

    const postId = `post-${this.idCounter++}`;
    const now = new Date();

    const post: PostEntity = {
      id: postId,
      channelId,
      authorId: actorId,
      templateId,
      title: null,
      contentJson: {},
      status: 'DRAFT',
      version: 1,
      scheduledAt: null,
      publishedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.posts.set(postId, post);
    this.postMedia.set(postId, []);

    this.recordAuditLog(actorId, 'post_created', 'post', postId, { channelId, templateId });
    return post;
  }

  /**
   * Autosaves draft step to database with Optimistic Concurrency Control.
   * Authoritative Source: AGENTS.md § 11, 12, 13; tasks.md § 10, 12.
   */
  async autosaveStep(
    postId: string,
    expectedVersion: number,
    actorId: string,
    fieldKey: string,
    fieldValue: unknown,
  ): Promise<PostEntity> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found or deleted.`);
    }

    // Permission check
    if (post.authorId !== actorId && !(await this.checkPermission(actorId, post.channelId, 'EDIT_POST'))) {
      throw new PermissionDeniedException(`User ${actorId} cannot edit post ${postId}.`);
    }

    // OCC Check: WHERE id = :postId AND version = :expectedVersion
    if (post.version !== expectedVersion) {
      throw new PostConflictException(
        `Публикация была изменена другим пользователем. Expected version ${expectedVersion}, but found ${post.version}.`,
      );
    }

    // Template schema validation
    const template = this.templates.get(post.templateId);
    if (template) {
      const fieldDef = template.schemaJson.fields.find((f) => f.key === fieldKey);
      if (fieldDef && fieldDef.maxLength && typeof fieldValue === 'string' && fieldValue.length > fieldDef.maxLength) {
        throw new ValidationError(`Field ${fieldKey} exceeds max length ${fieldDef.maxLength}`);
      }
    }

    // Update state
    const newContent = { ...post.contentJson, [fieldKey]: fieldValue };
    const newTitle = fieldKey === 'title' && typeof fieldValue === 'string' ? fieldValue : post.title;

    post.contentJson = newContent;
    if (newTitle) post.title = newTitle;
    post.version += 1;
    post.updatedAt = new Date();

    this.recordAuditLog(actorId, 'post_updated', 'post', postId, { fieldKey, newVersion: post.version });
    return { ...post };
  }

  async attachMedia(
    postId: string,
    expectedVersion: number,
    actorId: string,
    media: {
      telegramFileId: string;
      telegramFileUniqueId: string;
      mediaType: 'photo' | 'video' | 'document' | 'animation';
      caption?: string;
    },
  ): Promise<PostMediaEntity> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found.`);
    }

    if (post.version !== expectedVersion) {
      throw new PostConflictException(`OCC mismatch: version ${post.version} != expected ${expectedVersion}`);
    }

    const mediaList = this.postMedia.get(postId) || [];
    const newMedia: PostMediaEntity = {
      id: `media-${this.idCounter++}`,
      postId,
      telegramFileId: media.telegramFileId,
      telegramFileUniqueId: media.telegramFileUniqueId,
      mediaType: media.mediaType,
      caption: media.caption,
      sortOrder: mediaList.length + 1,
    };

    mediaList.push(newMedia);
    this.postMedia.set(postId, mediaList);

    post.version += 1;
    post.updatedAt = new Date();

    this.recordAuditLog(actorId, 'media_added', 'post', postId, {
      mediaType: media.mediaType,
      fileId: media.telegramFileId,
    });

    return newMedia;
  }

  async softDeletePost(postId: string, expectedVersion: number, actorId: string): Promise<void> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found.`);
    }

    if (post.version !== expectedVersion) {
      throw new PostConflictException(`OCC mismatch: version ${post.version} != expected ${expectedVersion}`);
    }

    post.deletedAt = new Date();
    post.version += 1;
    post.updatedAt = new Date();

    this.recordAuditLog(actorId, 'post_deleted', 'post', postId, {});
  }

  // --- State Machine Transitions & Review Workflow ---

  async transitionState(
    postId: string,
    expectedVersion: number,
    targetStatus: PostStatus,
    actorId: string,
    comment?: string,
  ): Promise<PostEntity> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found or deleted.`);
    }

    if (post.version !== expectedVersion) {
      throw new PostConflictException(
        `OCC conflict: current post version is ${post.version}, expected ${expectedVersion}.`,
      );
    }

    const currentStatus = post.status;
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new InvalidStateTransitionException(
        `Invalid status transition from ${currentStatus} to ${targetStatus}.`,
      );
    }

    // Permission and Rule Enforcements
    if (targetStatus === 'PENDING_REVIEW') {
      // Author submits or resubmits
      this.recordAuditLog(actorId, 'submitted_for_review', 'post', postId, {});
      await this.notifications.sendNotification({
        recipientId: 'usr-editor-001',
        recipientRole: 'EDITOR',
        eventType: 'submitted_for_review',
        postId,
        title: post.title || 'Untitled Post',
      });
    } else if (targetStatus === 'APPROVED') {
      const canApprove = await this.checkPermission(actorId, post.channelId, 'APPROVE_POST');
      if (!canApprove) {
        throw new PermissionDeniedException(`User ${actorId} does not have approve permission.`);
      }
      this.recordAuditLog(actorId, 'approved', 'post', postId, { comment });
      this.postReviews.push({
        id: `rev-${this.idCounter++}`,
        postId,
        reviewerId: actorId,
        action: 'APPROVE',
        comment: comment || null,
        createdAt: new Date(),
      });
      await this.notifications.sendNotification({
        recipientId: post.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'approved',
        postId,
        title: post.title || 'Untitled Post',
      });
    } else if (targetStatus === 'NEEDS_REVISION') {
      const canReview = await this.checkPermission(actorId, post.channelId, 'APPROVE_POST');
      if (!canReview) {
        throw new PermissionDeniedException(`User ${actorId} does not have review permission.`);
      }
      // Mandatory comment rule per tasks.md § 13
      if (!comment || comment.trim() === '') {
        throw new ValidationError('Для возврата на доработку обязателен комментарий.');
      }
      this.recordAuditLog(actorId, 'revision_requested', 'post', postId, { comment });
      this.postReviews.push({
        id: `rev-${this.idCounter++}`,
        postId,
        reviewerId: actorId,
        action: 'REQUEST_REVISION',
        comment,
        createdAt: new Date(),
      });
      await this.notifications.sendNotification({
        recipientId: post.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'revision_requested',
        postId,
        title: post.title || 'Untitled Post',
        details: { comment },
      });
    } else if (targetStatus === 'REJECTED') {
      const canReject = await this.checkPermission(actorId, post.channelId, 'REJECT_POST');
      if (!canReject) {
        throw new PermissionDeniedException(`User ${actorId} does not have reject permission.`);
      }
      this.recordAuditLog(actorId, 'rejected', 'post', postId, { comment });
      this.postReviews.push({
        id: `rev-${this.idCounter++}`,
        postId,
        reviewerId: actorId,
        action: 'REJECT',
        comment: comment || null,
        createdAt: new Date(),
      });
      await this.notifications.sendNotification({
        recipientId: post.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'rejected',
        postId,
        title: post.title || 'Untitled Post',
      });
    } else if (targetStatus === 'CANCELLED') {
      this.recordAuditLog(actorId, 'schedule_cancelled', 'post', postId, {});
    }

    post.status = targetStatus;
    post.version += 1;
    post.updatedAt = new Date();

    return { ...post };
  }

  // --- Scheduling Domain Service ---

  async schedulePost(postId: string, expectedVersion: number, actorId: string, scheduledAt: Date): Promise<PostEntity> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found.`);
    }

    if (post.status !== 'APPROVED') {
      throw new InvalidStateTransitionException(`Only APPROVED posts can be scheduled. Got: ${post.status}`);
    }

    // Preflight check: scheduledAt cannot be in the past
    if (scheduledAt.getTime() <= Date.now()) {
      throw new ValidationError('Нельзя планировать публикацию в прошлом.');
    }

    // Transition APPROVED -> SCHEDULED
    const updated = await this.transitionState(postId, expectedVersion, 'SCHEDULED', actorId);
    updated.scheduledAt = scheduledAt;
    this.posts.get(postId)!.scheduledAt = scheduledAt;

    this.recordAuditLog(actorId, 'scheduled', 'post', postId, { scheduledAt: scheduledAt.toISOString() });
    await this.notifications.sendNotification({
      recipientId: post.authorId,
      recipientRole: 'AUTHOR',
      eventType: 'scheduled',
      postId,
      title: post.title || 'Untitled Post',
      details: { scheduledAt: scheduledAt.toISOString() },
    });

    return updated;
  }

  async cancelSchedule(postId: string, expectedVersion: number, actorId: string): Promise<PostEntity> {
    const post = this.posts.get(postId);
    if (!post || post.status !== 'SCHEDULED') {
      throw new InvalidStateTransitionException(`Cannot cancel schedule for post with status ${post?.status}`);
    }
    return this.transitionState(postId, expectedVersion, 'CANCELLED', actorId);
  }

  // --- Publishing Engine & BullMQ Worker Simulation ---

  /**
   * Enqueues a publication job with durable unique idempotency key:
   * publish:{postId}:{postVersion}
   */
  async enqueuePublishJob(postId: string, actorId: string): Promise<PublicationJobEntity> {
    const post = this.posts.get(postId);
    if (!post || post.deletedAt !== null) {
      throw new ValidationError(`Post ${postId} not found or deleted.`);
    }

    if (post.status !== 'APPROVED' && post.status !== 'SCHEDULED' && post.status !== 'PUBLISH_FAILED') {
      throw new InvalidStateTransitionException(
        `Cannot publish post in status ${post.status}. Must be APPROVED, SCHEDULED, or PUBLISH_FAILED.`,
      );
    }

    const canPublish = await this.checkPermission(actorId, post.channelId, 'PUBLISH_POST');
    if (!canPublish) {
      throw new PermissionDeniedException(`User ${actorId} is not authorized to publish to channel ${post.channelId}`);
    }

    const idempotencyKey = `publish:${post.id}:${post.version}`;

    // Database unique constraint check on idempotencyKey
    for (const job of this.publicationJobs.values()) {
      if (job.idempotencyKey === idempotencyKey) {
        // Idempotent duplicate: return existing job without re-enqueueing
        return job;
      }
    }

    const jobId = `job-${this.idCounter++}`;
    const job: PublicationJobEntity = {
      id: jobId,
      postId: post.id,
      postVersion: post.version,
      idempotencyKey,
      status: 'PENDING',
      attemptCount: 0,
      maxRetries: 3,
      telegramMessageIdsJson: [],
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.publicationJobs.set(jobId, job);
    this.recordAuditLog(actorId, 'publication_job_created', 'publication_job', jobId, {
      postId: post.id,
      idempotencyKey,
    });

    return job;
  }

  /**
   * Simulates worker execution of a publication job.
   * Handles:
   * 1. Preflight validation (channel active, post status).
   * 2. Canonical rendering & HTML sanitization.
   * 3. Partial publication resume without duplicating sent messages.
   * 4. Retry with backoff or transition to PUBLISH_FAILED upon retry exhaustion.
   */
  async executePublicationWorker(jobId: string): Promise<void> {
    const job = this.publicationJobs.get(jobId);
    if (!job) throw new ValidationError(`Publication job ${jobId} not found.`);

    const post = this.posts.get(job.postId);
    if (!post || post.deletedAt !== null) {
      job.status = 'FAILED';
      job.lastError = 'Preflight failed: Post deleted or not found';
      return;
    }

    const channel = this.channels.get(post.channelId);
    if (!channel || !channel.isActive) {
      job.status = 'FAILED';
      job.lastError = 'Preflight failed: Target channel is inactive or missing';
      return;
    }

    // Set post to PUBLISHING if not already
    if (post.status !== 'PUBLISHING') {
      post.status = 'PUBLISHING';
      post.version += 1;
      this.recordAuditLog('system-worker', 'publication_started', 'post', post.id, { jobId });
    }

    job.status = 'PROCESSING';
    job.attemptCount += 1;

    try {
      // 1. Determine outgoing parts
      const mediaList = this.postMedia.get(post.id) || [];
      const hasMediaGroup = mediaList.length >= 2;
      let textContent = '';
      if (post.title && post.contentJson.body) {
        textContent = `<b>${post.title}</b>\n\n${post.contentJson.body}`;
      } else {
        textContent = (post.contentJson.body as string) || (post.contentJson.lead as string) || post.title || '';
      }
      const sanitizedText = sanitizeTelegramHtml(textContent);

      // Partial publication tracking: already sent message IDs
      const sentIds = [...job.telegramMessageIdsJson];

      // Step A: Send Media Group if present and not already sent
      if (hasMediaGroup && sentIds.length === 0) {
        const outgoingMedia: OutgoingMedia[] = mediaList.map((m) => ({
          type: m.mediaType,
          fileId: m.telegramFileId,
          caption: m.caption ? sanitizeTelegramHtml(m.caption) : undefined,
        }));
        const mgIds = await this.publisher.sendMediaGroup(channel.telegramChatId, outgoingMedia);
        sentIds.push(...mgIds);
        job.telegramMessageIdsJson = sentIds; // Durably record immediately
      }

      // Step B: Send Text Message if present and not already sent as separate part
      const hasTextPart = sanitizedText.trim().length > 0;
      // If we already sent media group, text is sent separately if longer than 1024 or standalone
      const textAlreadySent = sentIds.length > (hasMediaGroup ? mediaList.length : 0);

      if (hasTextPart && !textAlreadySent) {
        const textMsgId = await this.publisher.sendMessage(channel.telegramChatId, sanitizedText, {
          parseMode: 'HTML',
        });
        sentIds.push(textMsgId);
        job.telegramMessageIdsJson = sentIds; // Durably record immediately
      }

      // Mark Job Completed
      job.status = 'COMPLETED';
      job.updatedAt = new Date();

      // Update Post to PUBLISHED
      post.status = 'PUBLISHED';
      post.publishedAt = new Date();
      post.version += 1;
      post.updatedAt = new Date();

      this.recordAuditLog('system-worker', 'published', 'post', post.id, {
        jobId,
        telegramMessageIds: sentIds,
      });

      await this.notifications.sendNotification({
        recipientId: post.authorId,
        recipientRole: 'AUTHOR',
        eventType: 'published',
        postId: post.id,
        title: post.title || 'Published Post',
        details: { messageIds: sentIds },
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      job.lastError = error.message;

      const isRetryable = this.publisher.isRetryable(error);

      if (isRetryable && job.attemptCount < job.maxRetries) {
        // Will retry in next attempt (exponential backoff)
        job.status = 'PENDING';
        this.recordAuditLog('system-worker', 'publication_attempt_failed', 'publication_job', jobId, {
          attempt: job.attemptCount,
          error: error.message,
          retryable: true,
        });
      } else {
        // Exhausted retries or permanent failure -> PUBLISH_FAILED
        job.status = 'FAILED';
        post.status = 'PUBLISH_FAILED';
        post.version += 1;
        post.updatedAt = new Date();

        this.recordAuditLog('system-worker', 'publication_failed', 'post', post.id, {
          jobId,
          attempts: job.attemptCount,
          error: error.message,
        });

        await this.notifications.sendNotification({
          recipientId: 'usr-editor-001',
          recipientRole: 'EDITOR',
          eventType: 'publication_failed',
          postId: post.id,
          title: post.title || 'Untitled Post',
          details: { error: error.message, attempts: job.attemptCount },
        });
      }
    }
  }

  // --- Audit Logging ---

  private recordAuditLog(
    actorId: string,
    eventType: string,
    entityType: 'post' | 'user' | 'channel' | 'publication_job',
    entityId: string,
    payload: Record<string, unknown>,
  ): void {
    this.auditLogs.push({
      id: `audit-${this.idCounter++}`,
      actorId,
      eventType,
      entityType,
      entityId,
      payloadJson: payload,
      createdAt: new Date(),
    });
  }
}
