import 'reflect-metadata';
import { PostStatus, MediaType, Channel, PostTemplate, Post, PostMedia, ReviewAction } from '@prisma/client';
import { PostWizardService } from '../../src/modules/telegram/services/post-wizard.service';
import { ReviewQueueHandler } from '../../src/modules/telegram/handlers/review-queue.handler';
import { TelegramPreviewService, PostWithRelations } from '../../src/modules/telegram/services/telegram-preview.service';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { PostWorkflowService } from '../../src/modules/posts/post-workflow.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { PostsService } from '../../src/modules/posts/posts.service';
import { TemplatesService } from '../../src/modules/templates/templates.service';
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { ChannelsService } from '../../src/modules/channels/channels.service';
import { MediaService } from '../../src/modules/media/media.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { ReviewQueueService } from '../../src/modules/telegram/services/review-queue.service';
import { DomainEventBus } from '../../src/modules/notifications/domain-event.bus';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { ITelegramPublisher } from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import { TelegramPublisherService } from '../../src/infrastructure/telegram-api/telegram-publisher.service';
import { ChannelPermission, PostAction, AuditAction } from '../../src/common/enums';
import {
  ValidationException,
  PermissionDeniedException,
  InvalidPostStateTransitionException,
  PostConflictException,
} from '../../src/common/exceptions/domain.exceptions';
import { AttachMediaDto } from '../../src/modules/media/dto/attach-media.dto';
import { BotContext } from '../../src/modules/telegram/interfaces/bot-context.interface';
import { Api } from 'grammy';

import { AuthUser } from '../../src/modules/auth/interfaces/auth-user.interface';

/**
 * Milestone 5 Empirical Adversarial Verification Suite (m5_challenger_2)
 *
 * Mandatory Verification Dimensions:
 * 1. Review Workflow & Revision Comment Enforcement:
 *    - Rejection of empty and whitespace-only revision feedback comments.
 *    - Valid feedback comment transitions post to NEEDS_REVISION, increments OCC version,
 *      writes to PostReviewHistory, records audit entry, and notifies author.
 *    - State machine & RBAC enforcement on revision request.
 * 2. Canonical Preview & Companion Control Card:
 *    - Outgoing payload generation for: single text, single photo, single video, and media group (2-10 items).
 *    - Avoiding Telegram Bot API reply_markup error on sendMediaGroup.
 *    - Delivery of Companion Control Card alongside media group.
 *    - Long caption splitting across photo, video, and media groups.
 * 3. Media Burst & Debouncing Concurrency:
 *    - Simulation of rapid concurrent media uploads (album burst).
 *    - Debouncer prevents OCC collisions and executes single batch transaction.
 *    - Verification that un-debounced concurrent uploads suffer OCC conflicts.
 */
describe('Milestone 5 Empirical Adversarial Verification Suite (m5_challenger_2)', () => {
  const mockChannel: Channel = {
    id: 'ch-m5-test',
    telegramChatId: '-1009988776655',
    title: 'Редакционный канал M5',
    username: 'm5_editorial',
    timezone: 'Europe/Kyiv',
    publicationMode: 'DIRECT',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTemplate: PostTemplate = {
    id: 'tpl-m5',
    key: 'article',
    name: 'Статья с медиа',
    description: 'Шаблон публикации со статьей и медиа',
    schemaJson: {
      fields: [
        { key: 'title', label: 'Заголовок', type: 'text', required: true, maxLength: 200 },
        { key: 'body', label: 'Текст', type: 'rich_text', required: true, maxLength: 4000 },
      ],
    },
    renderConfig: { layout: '<b>{{title}}</b>\n\n{{body}}' },
    supportedMediaTypes: ['PHOTO', 'VIDEO', 'DOCUMENT'],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createMockPost = (overrides?: Partial<PostWithRelations>): PostWithRelations => ({
    id: 'post-m5-test-1',
    channelId: mockChannel.id,
    templateId: mockTemplate.id,
    templateVersion: 1,
    authorId: 'author-uuid-1',
    status: PostStatus.PENDING_REVIEW,
    version: 3,
    contentJson: {
      title: 'Экстренный выпуск новостей',
      body: 'Полный текст журналистского расследования.',
    },
    metadataJson: {},
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    channel: mockChannel,
    template: mockTemplate,
    media: [],
    author: {
      id: 'author-uuid-1',
      telegramId: 111222333n,
      systemRole: 'USER',
      firstName: 'Иван',
      lastName: 'Журналист',
      username: 'ivan_author',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    reviews: [],
    ...overrides,
  });

  const mockAuthUser: AuthUser = {
    id: 'author-uuid-1',
    telegramId: 111222333n,
    systemRole: 'USER',
    firstName: 'Иван',
    lastName: 'Журналист',
    username: 'ivan_author',
    isActive: true,
    channelMemberships: [],
  };

  // =========================================================================
  // Dimension 1: Review Workflow & Revision Comment Enforcement
  // =========================================================================
  describe('Dimension 1: Review Workflow & Revision Comment Enforcement', () => {
    let reviewQueueHandler: ReviewQueueHandler;
    let reviewQueueService: jest.Mocked<Partial<ReviewQueueService>>;
    let previewService: jest.Mocked<Partial<TelegramPreviewService>>;
    let postWorkflow: jest.Mocked<Partial<PostWorkflowService>>;
    let postsRepository: jest.Mocked<Partial<PostsRepository>>;
    let redisStore: Map<string, string>;
    let mockRedis: jest.Mocked<Partial<RedisService>>;

    beforeEach(() => {
      redisStore = new Map<string, string>();

      mockRedis = {
        get: jest.fn().mockImplementation((k: string) => Promise.resolve(redisStore.get(k) || null)),
        set: jest.fn().mockImplementation((k: string, v: string) => {
          redisStore.set(k, v);
          return Promise.resolve('OK');
        }),
        del: jest.fn().mockImplementation((k: string) => {
          redisStore.delete(k);
          return Promise.resolve(1);
        }),
      };

      reviewQueueService = {
        getPendingPostsForUser: jest.fn(),
        formatReviewCard: jest.fn(),
        getPost: jest.fn().mockImplementation((id: string) => postsRepository.findById!(id)),
      };

      previewService = {
        sendPostPreview: jest.fn().mockResolvedValue(101),
        updateControlCard: jest.fn().mockResolvedValue(undefined),
      };

      postWorkflow = {
        transition: jest.fn(),
      };

      postsRepository = {
        findById: jest.fn().mockImplementation((id: string) => {
          const post = createMockPost({ id });
          return Promise.resolve(post);
        }),
      };

      reviewQueueHandler = new ReviewQueueHandler(
        reviewQueueService as unknown as ReviewQueueService,
        previewService as unknown as TelegramPreviewService,
        postWorkflow as unknown as PostWorkflowService,
        mockRedis as unknown as RedisService,
      );
    });

    it('1.1.1 should initiate revision prompt, storing expected version in Redis session', async () => {
      const mockPost = createMockPost({ id: 'post-rev-1', version: 3 });
      postsRepository.findById = jest.fn().mockResolvedValue(mockPost);

      const ctx: Partial<BotContext> = {
        authUser: mockAuthUser,
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        reply: jest.fn().mockResolvedValue({ message_id: 201 } as any),
      };

      await reviewQueueHandler.handleRequestRevisionPrompt(ctx as BotContext, 'post-rev-1', 3);

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(mockRedis.set).toHaveBeenCalledWith(
        `user:session:${mockPost.author.id}`,
        expect.stringContaining('"state":"AWAITING_REVISION_COMMENT"'),
        900,
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Возврат на доработку'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('1.1.2 should reject prompt if post version is stale (Stale Button Defense)', async () => {
      const mockPost = createMockPost({ id: 'post-rev-1', version: 4 }); // DB version is 4
      postsRepository.findById = jest.fn().mockResolvedValue(mockPost);

      const ctx: Partial<BotContext> = {
        authUser: mockAuthUser,
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        reply: jest.fn(),
      };

      // Button carries expectedVersion = 3
      await reviewQueueHandler.handleRequestRevisionPrompt(ctx as BotContext, 'post-rev-1', 3);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Публикация была изменена другим пользователем'),
          show_alert: true,
        }),
      );
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('1.1.3 should reject empty string comment and preserve revision session', async () => {
      const editorId = 'editor-uuid-1';
      redisStore.set(
        `user:session:${editorId}`,
        JSON.stringify({
          state: 'AWAITING_REVISION_COMMENT',
          postId: 'post-rev-1',
          expectedVersion: 3,
        }),
      );

      const ctx: Partial<BotContext> = {
        authUser: { id: editorId } as any,
        message: { text: '' } as any,
        reply: jest.fn().mockResolvedValue({ message_id: 301 } as any),
      };

      const handled = await reviewQueueHandler.handleTextInput(ctx as BotContext);

      // Empty string is falsy, handler ignores empty text update and preserves session in Redis
      expect(handled).toBe(false);
      expect(postWorkflow.transition).not.toHaveBeenCalled();
      // Session MUST remain in Redis to allow author/editor to retry typing
      expect(redisStore.has(`user:session:${editorId}`)).toBe(true);
    });

    it('1.1.4 should reject whitespace-only comment (spaces, tabs, newlines) and preserve session', async () => {
      const editorId = 'editor-uuid-1';
      redisStore.set(
        `user:session:${editorId}`,
        JSON.stringify({
          state: 'AWAITING_REVISION_COMMENT',
          postId: 'post-rev-1',
          expectedVersion: 3,
        }),
      );

      const whitespaceInputs = ['   ', '\t\t\t', '\n\n  \n  \t', '     \r\n   '];

      for (const input of whitespaceInputs) {
        const ctx: Partial<BotContext> = {
          authUser: { id: editorId } as any,
          message: { text: input } as any,
          reply: jest.fn().mockResolvedValue({ message_id: 301 } as any),
        };

        const handled = await reviewQueueHandler.handleTextInput(ctx as BotContext);

        expect(handled).toBe(true);
        expect(ctx.reply).toHaveBeenCalledWith(
          expect.stringContaining('Комментарий не может быть пустым'),
        );
        expect(postWorkflow.transition).not.toHaveBeenCalled();
        expect(redisStore.has(`user:session:${editorId}`)).toBe(true);
      }
    });

    it('1.1.5 should accept valid non-empty comment, invoke transition to NEEDS_REVISION, and clear session', async () => {
      const editorId = 'editor-uuid-1';
      redisStore.set(
        `user:session:${editorId}`,
        JSON.stringify({
          state: 'AWAITING_REVISION_COMMENT',
          postId: 'post-rev-1',
          expectedVersion: 3,
        }),
      );

      const validFeedback = 'Требуется сократить вводную часть и указать ссылку на источник.';

      postWorkflow.transition = jest.fn().mockResolvedValue({
        id: 'post-rev-1',
        status: PostStatus.NEEDS_REVISION,
        version: 4,
      } as Post);

      const ctx: Partial<BotContext> = {
        authUser: { id: editorId } as any,
        message: { text: validFeedback } as any,
        reply: jest.fn().mockResolvedValue({ message_id: 302 } as any),
      };

      const handled = await reviewQueueHandler.handleTextInput(ctx as BotContext);

      expect(handled).toBe(true);
      expect(postWorkflow.transition).toHaveBeenCalledWith({
        postId: 'post-rev-1',
        expectedVersion: 3,
        actorId: editorId,
        action: PostAction.REQUEST_REVISION,
        targetStatus: PostStatus.NEEDS_REVISION,
        comment: validFeedback,
      });

      // Session MUST be cleared from Redis upon successful transition
      expect(mockRedis.del).toHaveBeenCalledWith(`user:session:${editorId}`);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Публикация возвращена автору на доработку'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('1.1.6 should strictly enforce non-empty comment at PostWorkflowService domain level', async () => {
      const mockPrisma: any = {
        $transaction: jest.fn(),
      };
      const mockPostsRepo: any = {
        findById: jest.fn().mockResolvedValue(createMockPost({ status: PostStatus.PENDING_REVIEW })),
      };
      const mockReviewsService: any = {
        createReview: jest.fn(),
      };
      const mockAuditService: any = {
        record: jest.fn(),
      };
      const mockEventBus: any = {
        publish: jest.fn(),
      };
      const mockPermissions: any = {
        checkChannelPermission: jest.fn().mockResolvedValue(true),
      };

      const workflow = new PostWorkflowService(
        mockPrisma,
        mockPostsRepo,
        mockReviewsService,
        mockAuditService,
        mockEventBus,
        mockPermissions,
      );

      // Empty string
      await expect(
        workflow.transition({
          postId: 'post-m5-test-1',
          expectedVersion: 3,
          actorId: 'editor-1',
          action: PostAction.REQUEST_REVISION,
          targetStatus: PostStatus.NEEDS_REVISION,
          comment: '',
        }),
      ).rejects.toThrow(ValidationException);

      // Whitespace only
      await expect(
        workflow.transition({
          postId: 'post-m5-test-1',
          expectedVersion: 3,
          actorId: 'editor-1',
          action: PostAction.REQUEST_REVISION,
          targetStatus: PostStatus.NEEDS_REVISION,
          comment: '   \t  \n  ',
        }),
      ).rejects.toThrow(ValidationException);

      // Undefined/null comment
      await expect(
        workflow.transition({
          postId: 'post-m5-test-1',
          expectedVersion: 3,
          actorId: 'editor-1',
          action: PostAction.REQUEST_REVISION,
          targetStatus: PostStatus.NEEDS_REVISION,
        }),
      ).rejects.toThrow(ValidationException);
    });

    it('1.1.7 should atomically execute OCC update, create PostReview record, audit entry, and notify author', async () => {
      const post = createMockPost({ id: 'post-workflow-test', status: PostStatus.PENDING_REVIEW, version: 3 });
      const updatedPost: Post = {
        ...post,
        status: PostStatus.NEEDS_REVISION,
        version: 4,
      };

      let txCallbackResult: any = null;
      const mockPrisma: any = {
        $transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
          const fakeTx = {
            postMedia: { create: jest.fn() },
          };
          txCallbackResult = await cb(fakeTx);
          return txCallbackResult;
        }),
        user: {
          findUnique: jest.fn().mockResolvedValue(post.author),
        },
      };

      const mockPostsRepo: any = {
        findById: jest.fn().mockResolvedValue(post),
        updateWithOcc: jest.fn().mockResolvedValue(updatedPost),
      };

      const mockReviewsService: any = {
        createReview: jest.fn().mockResolvedValue({ id: 'rev-1', action: ReviewAction.REQUEST_REVISION }),
      };

      const mockAuditService: any = {
        record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      };

      const eventBus = new DomainEventBus({ log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any);
      const mockPermissions: any = {
        checkChannelPermission: jest.fn().mockResolvedValue(true),
      };

      const workflow = new PostWorkflowService(
        mockPrisma,
        mockPostsRepo,
        mockReviewsService,
        mockAuditService,
        eventBus,
        mockPermissions,
      );

      const mockPublisher: jest.Mocked<Partial<ITelegramPublisher>> = {
        sendMessage: jest.fn().mockResolvedValue(555),
      };

      const notificationService = new NotificationService(
        mockPrisma,
        { log: jest.fn(), warn: jest.fn() } as any,
        eventBus,
        mockPublisher as ITelegramPublisher,
      );
      notificationService.onModuleInit();

      const comment = 'Заголовок не соответствует фактам. Добавьте подтверждение.';
      const res = await workflow.transition({
        postId: post.id,
        expectedVersion: 3,
        actorId: 'editor-uuid-1',
        action: PostAction.REQUEST_REVISION,
        targetStatus: PostStatus.NEEDS_REVISION,
        comment,
      });

      expect(res.status).toBe(PostStatus.NEEDS_REVISION);
      expect(res.version).toBe(4);

      // OCC update in transaction
      expect(mockPostsRepo.updateWithOcc).toHaveBeenCalledWith(
        post.id,
        3,
        { status: PostStatus.NEEDS_REVISION },
        expect.anything(),
      );

      // Review record created in transaction
      expect(mockReviewsService.createReview).toHaveBeenCalledWith(
        {
          postId: post.id,
          reviewerId: 'editor-uuid-1',
          action: ReviewAction.REQUEST_REVISION,
          comment,
        },
        expect.anything(),
      );

      // Audit log created in transaction
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REVISION_REQUESTED,
          entityId: post.id,
          actorId: 'editor-uuid-1',
        }),
        expect.anything(),
      );

      // Notification dispatched to author
      // Give async microtasks time to run event handler
      await new Promise((r) => setTimeout(r, 20));

      const dispatched = notificationService.getDispatchedNotifications();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual(
        expect.objectContaining({
          recipientId: post.authorId,
          recipientRole: 'AUTHOR',
          eventType: 'revision_requested',
          postId: post.id,
        }),
      );
      expect(dispatched[0]!.message).toContain(comment);

      // Telegram notification sent to author's telegramId
      expect(mockPublisher.sendMessage).toHaveBeenCalledWith(
        post.author.telegramId.toString(),
        expect.stringContaining(comment),
        expect.objectContaining({ parseMode: 'HTML' }),
      );

      notificationService.onModuleDestroy();
    });

    it('1.1.8 should reject illegal state transitions to NEEDS_REVISION from non-pending statuses', async () => {
      const mockPrisma: any = { $transaction: jest.fn() };
      const mockReviewsService: any = { createReview: jest.fn() };
      const mockAuditService: any = { record: jest.fn() };
      const mockEventBus: any = { publish: jest.fn() };
      const mockPermissions: any = { checkChannelPermission: jest.fn().mockResolvedValue(true) };

      const illegalStatuses = [
        PostStatus.DRAFT,
        PostStatus.APPROVED,
        PostStatus.SCHEDULED,
        PostStatus.PUBLISHING,
        PostStatus.PUBLISHED,
        PostStatus.REJECTED,
        PostStatus.CANCELLED,
      ];

      for (const status of illegalStatuses) {
        const post = createMockPost({ status });
        const mockPostsRepo: any = {
          findById: jest.fn().mockResolvedValue(post),
        };

        const workflow = new PostWorkflowService(
          mockPrisma,
          mockPostsRepo,
          mockReviewsService,
          mockAuditService,
          mockEventBus,
          mockPermissions,
        );

        await expect(
          workflow.transition({
            postId: post.id,
            expectedVersion: post.version,
            actorId: 'editor-1',
            action: PostAction.REQUEST_REVISION,
            targetStatus: PostStatus.NEEDS_REVISION,
            comment: 'Недопустимый возврат',
          }),
        ).rejects.toThrow(InvalidPostStateTransitionException);
      }
    });
  });

  // =========================================================================
  // Dimension 2: Canonical Preview & Companion Control Card
  // =========================================================================
  describe('Dimension 2: Canonical Preview & Companion Control Card', () => {
    let renderer: TelegramRenderer;
    let sanitizer: HtmlSanitizer;
    let previewService: TelegramPreviewService;
    let mockPublisher: jest.Mocked<ITelegramPublisher>;
    let mockApi: jest.Mocked<Partial<Api>>;

    beforeEach(() => {
      sanitizer = new HtmlSanitizer();
      renderer = new TelegramRenderer(sanitizer);

      mockPublisher = {
        sendMessage: jest.fn().mockResolvedValue(1001),
        sendPhoto: jest.fn().mockResolvedValue(1002),
        sendVideo: jest.fn().mockResolvedValue(1003),
        sendDocument: jest.fn().mockResolvedValue(1004),
        sendAnimation: jest.fn().mockResolvedValue(1005),
        sendMediaGroup: jest.fn().mockResolvedValue([1006, 1007]),
        publishOutgoingMessage: jest.fn().mockImplementation(async (_chatId, msg) => {
          if (msg.type === 'media_group') return [1006, 1007];
          return [1001];
        }),
        categorizeError: jest.fn(),
        isRetryable: jest.fn(),
        getRetryDelay: jest.fn(),
      };

      mockApi = {
        editMessageReplyMarkup: jest.fn().mockResolvedValue(true as any),
        editMessageText: jest.fn().mockResolvedValue(true as any),
      };

      previewService = new TelegramPreviewService(renderer, mockPublisher);
    });

    it('2.1.1 should render Single Text Post and deliver Companion Control Card', async () => {
      const post = createMockPost({ media: [] });

      const controlMsgId = await previewService.sendPostPreview(
        mockApi as unknown as Api,
        123456,
        post,
        { isSuperAdmin: false, canApprove: true, canPublish: true, isAuthor: false },
      );

      // 1. Text preview message published
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '123456',
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Экстренный выпуск новостей'),
        }),
      );

      // 2. Companion Control Card message sent
      expect(mockPublisher.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Панель управления публикацией'),
        expect.objectContaining({ parseMode: 'HTML' }),
      );

      // 3. Control Card receives inline keyboard markup
      expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledWith(
        123456,
        1001,
        expect.objectContaining({ reply_markup: expect.anything() }),
      );

      expect(controlMsgId).toBe(1001);
    });

    it('2.1.2 should render Single Photo Post and deliver Companion Control Card', async () => {
      const photoMedia: PostMedia = {
        id: 'media-photo-1',
        postId: 'post-m5-test-1',
        telegramFileId: 'AgACAgIAAxkBAAIB...',
        telegramFileUniqueId: 'AQADv8cxG...',
        mediaType: MediaType.PHOTO,
        fileName: 'breaking.jpg',
        mimeType: 'image/jpeg',
        fileSize: 204800n,
        caption: null,
        sortOrder: 1,
        createdAt: new Date(),
      };

      const post = createMockPost({ media: [photoMedia] });

      await previewService.sendPostPreview(
        mockApi as unknown as Api,
        123456,
        post,
        { isSuperAdmin: false, canApprove: true, canPublish: false, isAuthor: false },
      );

      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '123456',
        expect.objectContaining({
          type: 'photo',
          fileId: 'AgACAgIAAxkBAAIB...',
          caption: expect.stringContaining('Экстренный выпуск новостей'),
        }),
      );

      expect(mockPublisher.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Панель управления публикацией'),
        expect.anything(),
      );
    });

    it('2.1.3 should render Single Video Post and deliver Companion Control Card', async () => {
      const videoMedia: PostMedia = {
        id: 'media-video-1',
        postId: 'post-m5-test-1',
        telegramFileId: 'BAACAgIAAxkBAAIC...',
        telegramFileUniqueId: 'AQADw9cxG...',
        mediaType: MediaType.VIDEO,
        fileName: 'report.mp4',
        mimeType: 'video/mp4',
        fileSize: 10485760n,
        caption: null,
        sortOrder: 1,
        createdAt: new Date(),
      };

      const post = createMockPost({ media: [videoMedia] });

      await previewService.sendPostPreview(
        mockApi as unknown as Api,
        123456,
        post,
        { isSuperAdmin: true, canApprove: true, canPublish: true, isAuthor: false },
      );

      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '123456',
        expect.objectContaining({
          type: 'video',
          fileId: 'BAACAgIAAxkBAAIC...',
          caption: expect.stringContaining('Экстренный выпуск новостей'),
        }),
      );

      expect(mockPublisher.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Панель управления публикацией'),
        expect.anything(),
      );
    });

    it('2.1.4 should render Media Group (2-10 items) and deliver Companion Control Card without reply_markup on album', async () => {
      // Create 5 media items (photos and videos)
      const mediaList: PostMedia[] = Array.from({ length: 5 }, (_, i) => ({
        id: `media-album-${i + 1}`,
        postId: 'post-m5-test-1',
        telegramFileId: `file-id-${i + 1}`,
        telegramFileUniqueId: `unique-id-${i + 1}`,
        mediaType: i === 2 ? MediaType.VIDEO : MediaType.PHOTO,
        fileName: i === 2 ? 'video.mp4' : `photo_${i + 1}.jpg`,
        mimeType: i === 2 ? 'video/mp4' : 'image/jpeg',
        fileSize: 500000n,
        caption: null,
        sortOrder: i + 1,
        createdAt: new Date(),
      }));

      const post = createMockPost({ media: mediaList });

      await previewService.sendPostPreview(
        mockApi as unknown as Api,
        123456,
        post,
        { isSuperAdmin: false, canApprove: true, canPublish: true, isAuthor: false },
      );

      // CRITICAL CHECK: Media group outgoing message must NOT contain reply_markup
      expect(mockPublisher.publishOutgoingMessage).toHaveBeenCalledWith(
        '123456',
        expect.objectContaining({
          type: 'media_group',
          items: expect.arrayContaining([
            expect.objectContaining({ fileId: 'file-id-1', type: 'photo' }),
            expect.objectContaining({ fileId: 'file-id-3', type: 'video' }),
          ]),
        }),
      );

      // Verify that reply_markup is attached ONLY to the companion control card text message
      expect(mockPublisher.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Панель управления публикацией'),
        expect.objectContaining({ parseMode: 'HTML' }),
      );

      expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledWith(
        123456,
        1001,
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('2.1.5 should verify TelegramPublisherService.sendMediaGroup does not accept reply_markup (Telegram safety invariant)', async () => {
      const realPublisher = new TelegramPublisherService();
      const mockGrammyApi = {
        sendMediaGroup: jest.fn().mockResolvedValue([{ message_id: 888 }, { message_id: 889 }]),
      };
      realPublisher.setApi(mockGrammyApi as any);

      const items = [
        { type: 'photo' as const, fileId: 'photo-1' },
        { type: 'photo' as const, fileId: 'photo-2' },
      ];

      const res = await realPublisher.sendMediaGroup('-10012345', items);

      expect(res).toEqual([888, 889]);
      // grammY sendMediaGroup was called with (chatId, media) ONLY - no reply_markup argument exists
      expect(mockGrammyApi.sendMediaGroup).toHaveBeenCalledWith('-10012345', expect.any(Array));
    });

    it('2.1.6 should correctly split Media Group with caption exceeding 1024 characters into media_group + text message', async () => {
      const longBody = 'А'.repeat(1200); // Exceeds 1024 limit
      const post = createMockPost({
        contentJson: { title: 'Длинный пост', body: longBody },
        media: [
          {
            id: 'm1',
            postId: 'post-m5-test-1',
            telegramFileId: 'f1',
            telegramFileUniqueId: 'u1',
            mediaType: MediaType.PHOTO,
            fileName: null,
            mimeType: null,
            fileSize: null,
            caption: null,
            sortOrder: 1,
            createdAt: new Date(),
          },
          {
            id: 'm2',
            postId: 'post-m5-test-1',
            telegramFileId: 'f2',
            telegramFileUniqueId: 'u2',
            mediaType: MediaType.PHOTO,
            fileName: null,
            mimeType: null,
            fileSize: null,
            caption: null,
            sortOrder: 2,
            createdAt: new Date(),
          },
        ],
      });

      const payload = await renderer.render(post, mockTemplate, post.media);

      // Must be split into 2 outgoing messages: media_group (part 1 <= 1024) and text (part 2)
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0]!.type).toBe('media_group');
      const leadItem = (payload.messages[0] as any).items[0];
      expect(leadItem.caption.length).toBeLessThanOrEqual(1024);

      expect(payload.messages[1]!.type).toBe('text');
      expect((payload.messages[1] as any).text.length).toBeGreaterThan(0);
    });

    it('2.1.7 should format control card displaying status badge, channel timezone date, and revision remarks', () => {
      const postWithReview = createMockPost({
        status: PostStatus.NEEDS_REVISION,
        version: 4,
        reviews: [
          {
            id: 'rev-1',
            postId: 'post-m5-test-1',
            reviewerId: 'editor-1',
            action: 'REQUEST_REVISION',
            comment: 'Необходимо исправить заголовок',
            createdAt: new Date(),
          },
        ],
      });

      const cardHtml = previewService.formatControlCardHtml(postWithReview);

      expect(cardHtml).toContain('Панель управления публикацией');
      expect(cardHtml).toContain('↩️ Требуется доработка (v4)');
      expect(cardHtml).toContain('Редакционный канал M5');
      expect(cardHtml).toContain('Иван Журналист');
      expect(cardHtml).toContain('Замечания редактора');
      expect(cardHtml).toContain('Необходимо исправить заголовок');
    });
  });

  // =========================================================================
  // Dimension 3: Media Burst & Debouncing Concurrency
  // =========================================================================
  describe('Dimension 3: Media Burst & Debouncing Concurrency', () => {
    let wizardService: PostWizardService;
    let postsService: jest.Mocked<Partial<PostsService>>;
    let postsRepository: jest.Mocked<Partial<PostsRepository>>;
    let mediaService: jest.Mocked<Partial<MediaService>>;
    let redisStore: Map<string, string>;
    let redisListStore: Map<string, string[]>;
    let mockRedis: jest.Mocked<Partial<RedisService>>;

    beforeEach(() => {
      jest.useFakeTimers();
      redisStore = new Map<string, string>();
      redisListStore = new Map<string, string[]>();

      redisStore.set(
        'wizard:session:author-uuid-1',
        JSON.stringify({
          postId: 'post-burst-1',
          channelId: 'ch-m5-test',
          templateId: 'tpl-m5',
          step: 'MEDIA_UPLOAD',
          expectedVersion: 1,
        }),
      );

      mockRedis = {
        get: jest.fn().mockImplementation((k: string) => Promise.resolve(redisStore.get(k) || null)),
        set: jest.fn().mockImplementation((k: string, v: string) => {
          redisStore.set(k, v);
          return Promise.resolve('OK');
        }),
        del: jest.fn().mockImplementation((k: string) => {
          redisStore.delete(k);
          redisListStore.delete(k);
          return Promise.resolve(1);
        }),
        getClient: jest.fn().mockReturnValue({
          rpush: jest.fn().mockImplementation((k: string, v: string) => {
            const list = redisListStore.get(k) || [];
            list.push(v);
            redisListStore.set(k, list);
            return Promise.resolve(list.length);
          }),
          expire: jest.fn().mockResolvedValue(1),
          lrange: jest.fn().mockImplementation((k: string, _start: number, _stop: number) => {
            const list = redisListStore.get(k) || [];
            return Promise.resolve(list);
          }),
        } as any),
      };

      const mockPost = createMockPost({ id: 'post-burst-1', version: 1 });

      postsRepository = {
        findById: jest.fn().mockResolvedValue(mockPost),
      };

      postsService = {};

      mediaService = {
        attachMedia: jest.fn(),
        attachMediaBatch: jest.fn().mockImplementation((postId, ver, _actor, dtos) =>
          Promise.resolve({
            ...mockPost,
            id: postId,
            version: ver + 1,
          } as Post),
        ),
      };

      const mockWizardLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

      wizardService = new PostWizardService(
        postsService as unknown as PostsService,
        postsRepository as unknown as PostsRepository,
        { getById: jest.fn() } as any,
        new TemplateValidator(),
        { autoSkipSingleChannel: jest.fn() } as any,
        mediaService as unknown as MediaService,
        mockRedis as unknown as RedisService,
        new HtmlSanitizer(),
        mockWizardLogger as any,
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('3.1.1 should debounce burst of 5 rapid concurrent album uploads into a single batch call with zero OCC collisions', async () => {
      const mediaGroupId = 'album-tg-burst-999';
      const onBatchComplete = jest.fn().mockResolvedValue(undefined);

      // Simulate 5 photos arriving in rapid succession (within 100ms)
      const uploadPromises = Array.from({ length: 5 }, (_, i) => {
        const dto: AttachMediaDto = {
          telegramFileId: `file-burst-${i + 1}`,
          telegramFileUniqueId: `uniq-burst-${i + 1}`,
          mediaType: MediaType.PHOTO,
          fileName: `photo_${i + 1}.jpg`,
          mimeType: 'image/jpeg',
          fileSize: 100000,
          sortOrder: i + 1,
        };
        return wizardService.processMediaUpload(
          'author-uuid-1',
          dto,
          mediaGroupId,
          onBatchComplete,
        );
      });

      const results = await Promise.all(uploadPromises);

      // All 5 invocations must acknowledge batch buffering
      for (const res of results) {
        expect(res.success).toBe(true);
        expect(res.isBatch).toBe(true);
        expect(res.message).toContain('Медиафайлы группы загружаются');
      }

      // Individual attachMedia must NOT have been called
      expect(mediaService.attachMedia).not.toHaveBeenCalled();

      // Before timer expires, attachMediaBatch has NOT fired yet
      expect(mediaService.attachMediaBatch).not.toHaveBeenCalled();

      // Advance timer by 600ms to trigger debounce flush
      await jest.advanceTimersByTimeAsync(600);

      // Verify that attachMediaBatch was called EXACTLY ONCE with all 5 items
      expect(mediaService.attachMediaBatch).toHaveBeenCalledTimes(1);
      expect(mediaService.attachMediaBatch).toHaveBeenCalledWith(
        'post-burst-1',
        1, // uses freshPost.version = 1
        'author-uuid-1',
        expect.arrayContaining([
          expect.objectContaining({ telegramFileId: 'file-burst-1' }),
          expect.objectContaining({ telegramFileId: 'file-burst-2' }),
          expect.objectContaining({ telegramFileId: 'file-burst-3' }),
          expect.objectContaining({ telegramFileId: 'file-burst-4' }),
          expect.objectContaining({ telegramFileId: 'file-burst-5' }),
        ]),
      );

      // Completion callback called with count 5
      expect(onBatchComplete).toHaveBeenCalledWith(5);

      // Redis buffer must be cleaned up
      expect(mockRedis.del).toHaveBeenCalledWith(`album:buf:${mediaGroupId}`);
    });

    it('3.1.2 should demonstrate that un-debounced concurrent uploads cause OCC collisions (Adversarial Contrast)', async () => {
      // If each upload directly called attachMedia with version 1:
      let currentVersion = 1;
      const simulateDirectUpload = async (fileId: string, expectedVer: number): Promise<number> => {
        if (expectedVer !== currentVersion) {
          throw new PostConflictException(
            `OCC Conflict: expected ${expectedVer}, but current is ${currentVersion}`,
          );
        }
        currentVersion++;
        return currentVersion;
      };

      const results: { success: boolean; error?: string }[] = [];
      const concurrentUploads = Array.from({ length: 5 }, (_, i) => async () => {
        try {
          await simulateDirectUpload(`file-${i}`, 1); // all submit with expectedVersion 1
          results.push({ success: true });
        } catch (e: any) {
          results.push({ success: false, error: e.message });
        }
      });

      await Promise.all(concurrentUploads.map((fn) => fn()));

      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      // Exactly 1 succeeded, 4 failed due to OCC conflict
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(4);
      expect(failures[0]!.error).toContain('OCC Conflict');
    });

    it('3.1.3 should handle maximum media group bound (10 items) cleanly in a single debounce batch', async () => {
      const mediaGroupId = 'album-tg-burst-max10';
      const onBatchComplete = jest.fn().mockResolvedValue(undefined);

      // 10 items in album
      for (let i = 0; i < 10; i++) {
        const dto: AttachMediaDto = {
          telegramFileId: `file-max-${i + 1}`,
          telegramFileUniqueId: `uniq-max-${i + 1}`,
          mediaType: MediaType.PHOTO,
          sortOrder: i + 1,
        };
        await wizardService.processMediaUpload(
          'author-uuid-1',
          dto,
          mediaGroupId,
          onBatchComplete,
        );
      }

      await jest.advanceTimersByTimeAsync(600);

      expect(mediaService.attachMediaBatch).toHaveBeenCalledTimes(1);
      const attachedDtos = (mediaService.attachMediaBatch as jest.Mock).mock.calls[0]![3];
      expect(attachedDtos).toHaveLength(10);
      expect(onBatchComplete).toHaveBeenCalledWith(10);
    });

    it('3.1.4 should isolate separate albums across different mediaGroupIds simultaneously', async () => {
      const album1 = 'album-group-aaa';
      const album2 = 'album-group-bbb';

      // 2 items in album 1
      await wizardService.processMediaUpload('author-uuid-1', {
        telegramFileId: 'f-a1',
        telegramFileUniqueId: 'u-a1',
        mediaType: MediaType.PHOTO,
      }, album1);
      await wizardService.processMediaUpload('author-uuid-1', {
        telegramFileId: 'f-a2',
        telegramFileUniqueId: 'u-a2',
        mediaType: MediaType.PHOTO,
      }, album1);

      // 3 items in album 2
      await wizardService.processMediaUpload('author-uuid-1', {
        telegramFileId: 'f-b1',
        telegramFileUniqueId: 'u-b1',
        mediaType: MediaType.PHOTO,
      }, album2);
      await wizardService.processMediaUpload('author-uuid-1', {
        telegramFileId: 'f-b2',
        telegramFileUniqueId: 'u-b2',
        mediaType: MediaType.PHOTO,
      }, album2);
      await wizardService.processMediaUpload('author-uuid-1', {
        telegramFileId: 'f-b3',
        telegramFileUniqueId: 'u-b3',
        mediaType: MediaType.PHOTO,
      }, album2);

      await jest.advanceTimersByTimeAsync(600);

      expect(mediaService.attachMediaBatch).toHaveBeenCalledTimes(2);

      const call1 = (mediaService.attachMediaBatch as jest.Mock).mock.calls.find(
        (c) => c[3].length === 2,
      );
      const call2 = (mediaService.attachMediaBatch as jest.Mock).mock.calls.find(
        (c) => c[3].length === 3,
      );

      expect(call1).toBeDefined();
      expect(call2).toBeDefined();
      expect(call1![3].map((d: any) => d.telegramFileId)).toEqual(['f-a1', 'f-a2']);
      expect(call2![3].map((d: any) => d.telegramFileId)).toEqual(['f-b1', 'f-b2', 'f-b3']);
    });
  });
});
