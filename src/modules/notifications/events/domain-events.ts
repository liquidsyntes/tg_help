export enum DomainEventType {
  POST_SUBMITTED = 'post.submitted_for_review',
  POST_APPROVED = 'post.approved',
  POST_REVISION_REQUESTED = 'post.revision_requested',
  POST_REJECTED = 'post.rejected',
  POST_SCHEDULED = 'post.scheduled',
  POST_PUBLISHED = 'post.published',
  POST_PUBLICATION_FAILED = 'post.publication_failed',
}

export interface BaseDomainEvent {
  readonly eventType: DomainEventType;
  readonly timestamp: Date;
  readonly postId: string;
  readonly channelId: string;
}

export class PostSubmittedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_SUBMITTED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly templateName?: string,
  ) {}
}

export class PostApprovedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_APPROVED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment?: string,
  ) {}
}

export class PostRevisionRequestedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_REVISION_REQUESTED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment: string,
  ) {}
}

export class PostRejectedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_REJECTED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly reviewerId: string,
    public readonly postTitle: string,
    public readonly comment?: string,
  ) {}
}

export class PostScheduledEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_SCHEDULED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly scheduledAt: Date,
  ) {}
}

export class PostPublishedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_PUBLISHED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly telegramMessageIds: number[],
  ) {}
}

export class PostPublicationFailedEvent implements BaseDomainEvent {
  readonly eventType = DomainEventType.POST_PUBLICATION_FAILED;
  readonly timestamp = new Date();

  constructor(
    public readonly postId: string,
    public readonly channelId: string,
    public readonly authorId: string,
    public readonly postTitle: string,
    public readonly attempts: number,
    public readonly errorMessage: string,
  ) {}
}
