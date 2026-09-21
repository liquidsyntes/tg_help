import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { DomainEventBus } from './domain-event.bus';
import {
  DomainEventType,
  PostSubmittedEvent,
  PostApprovedEvent,
  PostRevisionRequestedEvent,
  PostRejectedEvent,
  PostScheduledEvent,
  PostPublishedEvent,
  PostPublicationFailedEvent,
} from './events/domain-events';

export interface DispatchedNotification {
  recipientId: string;
  recipientTelegramId?: string;
  recipientRole: 'EDITOR' | 'AUTHOR' | 'ADMIN' | string;
  eventType: string;
  postId: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly subscriptions: Subscription[] = [];
  private readonly dispatched: DispatchedNotification[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
    private readonly eventBus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.eventBus
        .ofType<PostSubmittedEvent>(DomainEventType.POST_SUBMITTED)
        .subscribe((event) => void this.handlePostSubmitted(event)),
      this.eventBus
        .ofType<PostApprovedEvent>(DomainEventType.POST_APPROVED)
        .subscribe((event) => void this.handlePostApproved(event)),
      this.eventBus
        .ofType<PostRevisionRequestedEvent>(DomainEventType.POST_REVISION_REQUESTED)
        .subscribe((event) => void this.handlePostRevisionRequested(event)),
      this.eventBus
        .ofType<PostRejectedEvent>(DomainEventType.POST_REJECTED)
        .subscribe((event) => void this.handlePostRejected(event)),
      this.eventBus
        .ofType<PostScheduledEvent>(DomainEventType.POST_SCHEDULED)
        .subscribe((event) => void this.handlePostScheduled(event)),
      this.eventBus
        .ofType<PostPublishedEvent>(DomainEventType.POST_PUBLISHED)
        .subscribe((event) => void this.handlePostPublished(event)),
      this.eventBus
        .ofType<PostPublicationFailedEvent>(DomainEventType.POST_PUBLICATION_FAILED)
        .subscribe((event) => void this.handlePostPublicationFailed(event)),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions.length = 0;
  }

  /**
   * Returns list of recorded notifications for auditing and unit testing.
   */
  getDispatchedNotifications(): DispatchedNotification[] {
    return [...this.dispatched];
  }

  /**
   * Clears notification history.
   */
  clearNotifications(): void {
    this.dispatched.length = 0;
  }

  // --- Domain Event Handlers ---

  async handlePostSubmitted(event: PostSubmittedEvent): Promise<void> {
    try {
      const channel = await this.prisma.channel.findUnique({ where: { id: event.channelId } });
      const channelTitle = channel?.title || 'Канал';

      const editors = await this.prisma.channelMember.findMany({
        where: {
          channelId: event.channelId,
          role: 'EDITOR',
          user: { isActive: true },
        },
        include: { user: true },
      });

      const message =
        `📝 Новый пост на согласование!\n\n` +
        `Канал: ${channelTitle}\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}\n` +
        `Шаблон: ${event.templateName ?? 'Обычный'}`;

      for (const editor of editors) {
        this.recordAndDispatch({
          recipientId: editor.userId,
          recipientTelegramId: editor.user.telegramId.toString(),
          recipientRole: 'EDITOR',
          eventType: 'submitted_for_review',
          postId: event.postId,
          message,
        });
      }
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostSubmitted', err);
    }
  }

  async handlePostApproved(event: PostApprovedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message =
        `✅ Ваш пост одобрен!\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}` +
        (event.comment ? `\nКомментарий редактора: ${event.comment}` : '');

      this.recordAndDispatch({
        recipientId: author.id,
        recipientTelegramId: author.telegramId.toString(),
        recipientRole: 'AUTHOR',
        eventType: 'approved',
        postId: event.postId,
        message,
        details: { comment: event.comment },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostApproved', err);
    }
  }

  async handlePostRevisionRequested(event: PostRevisionRequestedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message =
        `⚠️ Требуется доработка публикации\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}\n\n` +
        `Комментарий редактора:\n${event.comment}`;

      this.recordAndDispatch({
        recipientId: author.id,
        recipientTelegramId: author.telegramId.toString(),
        recipientRole: 'AUTHOR',
        eventType: 'revision_requested',
        postId: event.postId,
        message,
        details: { comment: event.comment },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostRevisionRequested', err);
    }
  }

  async handlePostRejected(event: PostRejectedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message =
        `❌ Пост отклонен\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}` +
        (event.comment ? `\nПричина: ${event.comment}` : '');

      this.recordAndDispatch({
        recipientId: author.id,
        recipientTelegramId: author.telegramId.toString(),
        recipientRole: 'AUTHOR',
        eventType: 'rejected',
        postId: event.postId,
        message,
        details: { comment: event.comment },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostRejected', err);
    }
  }

  async handlePostScheduled(event: PostScheduledEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message =
        `🕒 Пост запланирован на публикацию\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}\n` +
        `Время: ${event.scheduledAt.toISOString()}`;

      this.recordAndDispatch({
        recipientId: author.id,
        recipientTelegramId: author.telegramId.toString(),
        recipientRole: 'AUTHOR',
        eventType: 'scheduled',
        postId: event.postId,
        message,
        details: { scheduledAt: event.scheduledAt },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostScheduled', err);
    }
  }

  async handlePostPublished(event: PostPublishedEvent): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({ where: { id: event.authorId } });
      if (!author || !author.isActive) return;

      const message =
        `🚀 Пост успешно опубликован в канале!\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}`;

      this.recordAndDispatch({
        recipientId: author.id,
        recipientTelegramId: author.telegramId.toString(),
        recipientRole: 'AUTHOR',
        eventType: 'published',
        postId: event.postId,
        message,
        details: { telegramMessageIds: event.telegramMessageIds },
      });
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostPublished', err);
    }
  }

  async handlePostPublicationFailed(event: PostPublicationFailedEvent): Promise<void> {
    try {
      const editors = await this.prisma.channelMember.findMany({
        where: { channelId: event.channelId, role: 'EDITOR', user: { isActive: true } },
        include: { user: true },
      });

      const message =
        `🚨 ОШИБКА ПУБЛИКАЦИИ ПОСТА!\n\n` +
        `Заголовок: ${event.postTitle || 'Без названия'}\n` +
        `Попыток: ${event.attempts}\n` +
        `Причина: ${event.errorMessage}\n\n` +
        `Используйте меню управления для повторной публикации.`;

      for (const editor of editors) {
        this.recordAndDispatch({
          recipientId: editor.userId,
          recipientTelegramId: editor.user.telegramId.toString(),
          recipientRole: 'EDITOR',
          eventType: 'publication_failed',
          postId: event.postId,
          message,
          details: { error: event.errorMessage, attempts: event.attempts },
        });
      }
    } catch (err: unknown) {
      this.logNotificationFailure('handlePostPublicationFailed', err);
    }
  }

  // --- Helper Dispatch ---

  private recordAndDispatch(notif: Omit<DispatchedNotification, 'timestamp'>): void {
    const entry: DispatchedNotification = {
      ...notif,
      timestamp: new Date(),
    };
    this.dispatched.push(entry);

    this.logger.log(
      {
        event: 'notification_dispatched',
        recipientId: entry.recipientId,
        recipientRole: entry.recipientRole,
        eventType: entry.eventType,
        postId: entry.postId,
      },
      'NotificationService',
    );
  }

  private logNotificationFailure(handlerName: string, error: unknown): void {
    this.logger.warn(
      {
        event: 'notification_dispatch_failure',
        handler: handlerName,
        error: error instanceof Error ? error.message : String(error),
      },
      'NotificationService',
    );
  }
}
