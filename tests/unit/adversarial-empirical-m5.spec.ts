import 'reflect-metadata';
import { TelegramAuthMiddleware } from '../../src/modules/telegram/middlewares/telegram-auth.middleware';
import { AuthService } from '../../src/modules/auth/auth.service';
import {
  UserDeactivatedException,
  PostConflictException,
  UnauthorizedUserException,
  PermissionDeniedException,
} from '../../src/common/exceptions/domain.exceptions';
import { SystemRole, ChannelRole, ChannelPermission, PostStatus, PostAction } from '../../src/common/enums';
import { BotContext } from '../../src/modules/telegram/interfaces/bot-context.interface';
import {
  CallbackCodec,
  PostCallbackAction,
} from '../../src/modules/telegram/utils/callback-data.codec';
import {
  PostControlsKeyboardBuilder,
  UserContextPermissions,
} from '../../src/modules/telegram/keyboards/post-controls.keyboard';
import { PostWizardService } from '../../src/modules/telegram/services/post-wizard.service';
import { DraftManagerService } from '../../src/modules/telegram/services/draft-manager.service';
import { TelegramExceptionFilter } from '../../src/modules/telegram/filters/telegram-exception.filter';
import { PostActionsHandler } from '../../src/modules/telegram/handlers/post-actions.handler';
import { ReviewQueueHandler } from '../../src/modules/telegram/handlers/review-queue.handler';
import { DraftManagerHandler } from '../../src/modules/telegram/handlers/draft-manager.handler';
import { Post, PostTemplate, Channel } from '@prisma/client';

describe('Milestone 5 Empirical Adversarial Stress Suite (m5_challenger_1)', () => {
  // =========================================================================
  // Dimension 1: Auth Middleware Stress & Boundary Testing
  // =========================================================================
  describe('1. Auth Middleware Stress & Boundary Testing', () => {
    let authService: jest.Mocked<Partial<AuthService>>;
    let middleware: TelegramAuthMiddleware;

    beforeEach(() => {
      authService = {
        resolveUser: jest.fn(),
      };
      middleware = new TelegramAuthMiddleware(authService as unknown as AuthService);
    });

    it('1.1 should reject unregistered user on message with tasks.md §7 Russian prompt containing Telegram ID and NOT call next()', async () => {
      const telegramId = 9876543210123n;
      const ctx = {
        from: { id: Number(telegramId), username: 'stranger_user' },
        requestId: 'req-unreg-msg',
        reply: jest.fn().mockResolvedValue(undefined),
      } as unknown as BotContext;
      const next = jest.fn();

      authService.resolveUser = jest.fn().mockResolvedValue(null);

      await middleware.create()(ctx, next);

      expect(authService.resolveUser).toHaveBeenCalledWith(BigInt(Number(telegramId)));
      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledTimes(1);

      const [replyText, replyOptions] = (ctx.reply as jest.Mock).mock.calls[0];
      // Must contain exact prompt from tasks.md §7:
      // "У вас пока нет доступа к редакции.\nОбратитесь к администратору."
      expect(replyText).toContain('У вас пока нет доступа к редакции.');
      expect(replyText).toContain('Обратитесь к администратору');
      expect(replyText).toContain(telegramId.toString());
      expect(replyOptions).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    });

    it('1.2 should reject unregistered user on callback query with alert popup and NOT call next()', async () => {
      const telegramId = 444333222111n;
      const ctx = {
        from: { id: Number(telegramId), username: 'callback_stranger' },
        requestId: 'req-unreg-cb',
        callbackQuery: { id: 'cb-unreg-99' },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
      } as unknown as BotContext;
      const next = jest.fn();

      authService.resolveUser = jest.fn().mockResolvedValue(null);

      await middleware.create()(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'У вас пока нет доступа к редакции. Обратитесь к администратору.',
        show_alert: true,
      });
    });

    it('1.3 should immediately block deactivated user on message with Russian prompt and NOT call next()', async () => {
      const telegramId = 888777666555n;
      const ctx = {
        from: { id: Number(telegramId), username: 'deactivated_user' },
        requestId: 'req-deact-msg',
        reply: jest.fn().mockResolvedValue(undefined),
      } as unknown as BotContext;
      const next = jest.fn();

      authService.resolveUser = jest.fn().mockRejectedValue(new UserDeactivatedException(telegramId));

      await middleware.create()(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledTimes(1);

      const [replyText, replyOptions] = (ctx.reply as jest.Mock).mock.calls[0];
      expect(replyText).toContain('Ваш аккаунт деактивирован');
      expect(replyText).toContain('Обратитесь к администратору');
      expect(replyText).toContain(telegramId.toString());
      expect(replyOptions).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    });

    it('1.4 should immediately block deactivated user on callback query with alert popup and NOT call next()', async () => {
      const telegramId = 777666555444n;
      const ctx = {
        from: { id: Number(telegramId), username: 'deactivated_cb' },
        requestId: 'req-deact-cb',
        callbackQuery: { id: 'cb-deact-1' },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
      } as unknown as BotContext;
      const next = jest.fn();

      authService.resolveUser = jest.fn().mockRejectedValue(new UserDeactivatedException(telegramId));

      await middleware.create()(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Ваш аккаунт деактивирован. Обратитесь к администратору.',
        show_alert: true,
      });
    });

    it('1.5 should handle updates without "from" (channel post / anonymous) without crashing or calling resolveUser', async () => {
      const ctx = {
        from: undefined,
        channelPost: { id: 123 },
        requestId: 'req-channel-post',
      } as unknown as BotContext;
      const next = jest.fn();

      await middleware.create()(ctx, next);

      expect(authService.resolveUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('1.6 should re-throw unexpected errors other than UserDeactivatedException for exception filter', async () => {
      const telegramId = 123456789n;
      const ctx = {
        from: { id: Number(telegramId) },
        requestId: 'req-db-err',
      } as unknown as BotContext;
      const next = jest.fn();

      const dbError = new Error('Database connection timeout');
      authService.resolveUser = jest.fn().mockRejectedValue(dbError);

      await expect(middleware.create()(ctx, next)).rejects.toThrow('Database connection timeout');
      expect(next).not.toHaveBeenCalled();
    });

    it('1.7 should handle maximum 64-bit safe BigInt Telegram ID correctly', async () => {
      const largeId = 9007199254740991; // Number.MAX_SAFE_INTEGER
      const ctx = {
        from: { id: largeId },
        requestId: 'req-bigint',
        reply: jest.fn(),
      } as unknown as BotContext;
      const next = jest.fn();

      authService.resolveUser = jest.fn().mockResolvedValue(null);

      await middleware.create()(ctx, next);

      expect(authService.resolveUser).toHaveBeenCalledWith(BigInt(largeId));
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining(largeId.toString()),
        expect.anything(),
      );
    });

    it('1.8 should verify channel permissions cannot escalate beyond granted role', async () => {
      const ctx = {
        from: { id: 100 },
        requestId: 'req-rbac',
      } as unknown as BotContext;
      const next = jest.fn();

      const authorUser = {
        id: 'user-author-1',
        telegramId: 100n,
        systemRole: SystemRole.USER,
        channelMemberships: [
          {
            channelId: 'chan-1',
            role: ChannelRole.AUTHOR,
            canPublish: false,
            canApprove: false,
          },
        ],
      };

      authService.resolveUser = jest.fn().mockResolvedValue(authorUser);

      await middleware.create()(ctx, next);

      expect(ctx.authUser).toBe(authorUser);
      expect(ctx.isSuperAdmin).toBe(false);
      expect(ctx.canChannel(ChannelPermission.PUBLISH_POST, 'chan-1')).toBe(false);
      expect(ctx.canChannel(ChannelPermission.APPROVE_POST, 'chan-1')).toBe(false);
      expect(ctx.canChannel(ChannelPermission.CREATE_POST, 'chan-1')).toBe(true);
      expect(ctx.canChannel(ChannelPermission.PUBLISH_POST, 'unauthorized-channel')).toBe(false);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Dimension 2: Immediate PostgreSQL Autosave & Interruption Recovery
  // =========================================================================
  describe('2. Immediate PostgreSQL Autosave & Interruption Recovery (AGENTS.md §11, §12)', () => {
    let wizardService: PostWizardService;
    let draftManagerService: DraftManagerService;
    let mockPostsService: any;
    let mockPostsRepository: any;
    let mockTemplatesService: any;
    let mockValidator: any;
    let mockChannelsService: any;
    let mockMediaService: any;
    let mockRedis: any;
    let mockHtmlSanitizer: any;

    const testTemplate: PostTemplate = {
      id: 'tpl-uuid-1',
      key: 'article',
      name: 'Статья',
      description: 'Статья с заголовком и текстом',
      supportedMediaTypes: ['photo', 'video'],
      schemaJson: {
        fields: [
          { key: 'title', label: 'Заголовок', type: 'text', required: true, maxLength: 200 },
          { key: 'subtitle', label: 'Подзаголовок', type: 'text', required: false, maxLength: 200 },
          { key: 'body', label: 'Основной текст', type: 'rich_text', required: true, maxLength: 4000 },
        ],
      } as any,
      renderConfig: { layout: '{{title}}\n{{body}}' } as any,
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const initialDraftPost: Post = {
      id: 'post-autosave-uuid',
      channelId: 'chan-1',
      templateId: 'tpl-uuid-1',
      templateVersion: 1,
      authorId: 'author-uuid-1',
      status: PostStatus.DRAFT,
      version: 1,
      contentJson: {},
      metadataJson: { wizardStep: 'field', currentFieldIndex: 0 },
      scheduledAt: null,
      publishedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      const redisStore = new Map<string, string>();

      mockRedis = {
        get: jest.fn().mockImplementation(async (key: string) => redisStore.get(key) ?? null),
        set: jest.fn().mockImplementation(async (key: string, val: string) => {
          redisStore.set(key, val);
          return 'OK';
        }),
        del: jest.fn().mockImplementation(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
      };

      mockPostsService = {
        createDraft: jest.fn().mockResolvedValue(initialDraftPost),
        autosaveStep: jest.fn(),
        softDeletePost: jest.fn(),
      };

      mockPostsRepository = {
        findById: jest.fn().mockResolvedValue(initialDraftPost),
        findByAuthor: jest.fn(),
      };

      mockTemplatesService = {
        getById: jest.fn().mockResolvedValue(testTemplate),
        getActiveTemplates: jest.fn().mockResolvedValue([testTemplate]),
      };

      mockValidator = {
        validateField: jest.fn().mockReturnValue(null),
        coerceFieldValue: jest.fn().mockImplementation((_field, val) => ({ value: val })),
      };

      mockChannelsService = {
        autoSkipSingleChannel: jest.fn().mockResolvedValue({
          singleChannel: { id: 'chan-1', title: 'Main Channel' },
          channels: [{ id: 'chan-1', title: 'Main Channel' }],
          mustChoose: false,
        }),
      };

      mockMediaService = {};
      mockHtmlSanitizer = {
        sanitize: jest.fn().mockImplementation((val) => val),
      };

      wizardService = new PostWizardService(
        mockPostsService,
        mockPostsRepository,
        mockTemplatesService,
        mockValidator,
        mockChannelsService,
        mockMediaService,
        mockRedis,
        mockHtmlSanitizer,
      );

      draftManagerService = new DraftManagerService(
        mockPostsService,
        mockPostsRepository,
        mockTemplatesService,
        mockValidator,
        mockRedis,
        mockHtmlSanitizer,
      );
    });

    it('2.1 should IMMEDIATELY persist draft in PostgreSQL on template selection (Step 2)', async () => {
      const actorId = 'author-uuid-1';
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ channelId: 'chan-1', step: 'TEMPLATE_SELECT' }));

      const res = await wizardService.selectTemplate(actorId, testTemplate.id);

      expect(mockPostsService.createDraft).toHaveBeenCalledWith({
        authorId: actorId,
        channelId: 'chan-1',
        templateId: testTemplate.id,
        templateVersion: 1,
        contentJson: {},
        metadataJson: { wizardStep: 'field', currentFieldIndex: 0 },
      });

      expect(res.type).toBe('FIELD_PROMPT');
      expect(res.field?.key).toBe('title');
    });

    it('2.2 should IMMEDIATELY write title to PostgreSQL on Step 3 field input (version 1 -> 2)', async () => {
      const actorId = 'author-uuid-1';
      // Session in Redis currently at step 0 (title)
      await mockRedis.set(
        `wizard:session:${actorId}`,
        JSON.stringify({
          postId: initialDraftPost.id,
          channelId: 'chan-1',
          templateId: testTemplate.id,
          step: 'FIELD_INPUT',
          fieldIndex: 0,
          expectedVersion: 1,
        }),
      );

      const postV2 = {
        ...initialDraftPost,
        version: 2,
        contentJson: { title: 'Первый заголовок' },
      };
      mockPostsService.autosaveStep = jest.fn().mockResolvedValue(postV2);
      mockPostsRepository.findById = jest.fn().mockResolvedValue(initialDraftPost);

      const res = await wizardService.processFieldInput(actorId, 'Первый заголовок');

      // Invariant: PostsService.autosaveStep MUST be called immediately
      expect(mockPostsService.autosaveStep).toHaveBeenCalledWith(
        initialDraftPost.id,
        1, // expected version
        actorId,
        'title',
        'Первый заголовок',
      );

      // Next prompt is for subtitle (fieldIndex: 1)
      expect(res.type).toBe('FIELD_PROMPT');
      expect(res.field?.key).toBe('subtitle');

      // Redis session was updated with new version
      const sessionRaw = await mockRedis.get(`wizard:session:${actorId}`);
      const session = JSON.parse(sessionRaw!);
      expect(session.fieldIndex).toBe(1);
      expect(session.expectedVersion).toBe(2);
    });

    it('2.3 should IMMEDIATELY write body to PostgreSQL on Step 3 second field input (version 2 -> 3)', async () => {
      const actorId = 'author-uuid-1';
      const postV2 = {
        ...initialDraftPost,
        version: 2,
        contentJson: { title: 'Первый заголовок' },
      };

      await mockRedis.set(
        `wizard:session:${actorId}`,
        JSON.stringify({
          postId: postV2.id,
          channelId: 'chan-1',
          templateId: testTemplate.id,
          step: 'FIELD_INPUT',
          fieldIndex: 2, // entering body
          expectedVersion: 2,
        }),
      );

      const postV3 = {
        ...postV2,
        version: 3,
        contentJson: { title: 'Первый заголовок', body: 'Текст статьи' },
      };
      mockPostsService.autosaveStep = jest.fn().mockResolvedValue(postV3);
      mockPostsRepository.findById = jest.fn().mockResolvedValue(postV2);

      await wizardService.processFieldInput(actorId, 'Текст статьи');

      expect(mockPostsService.autosaveStep).toHaveBeenCalledWith(
        postV2.id,
        2,
        actorId,
        'body',
        'Текст статьи',
      );
    });

    it('2.4 should recover draft from PostgreSQL after complete Redis loss and resume at first missing required field', async () => {
      const actorId = 'author-uuid-1';

      // Simulation: Server crash / Redis flush. Redis is completely empty!
      await mockRedis.del(`wizard:session:${actorId}`);
      expect(await mockRedis.get(`wizard:session:${actorId}`)).toBeNull();

      // Post in PostgreSQL: title is saved, but 'body' (required) is NOT yet saved!
      const interruptedPostInDb = {
        ...initialDraftPost,
        version: 2,
        contentJson: {
          title: 'Автосохраненный заголовок',
          // subtitle is optional, body is missing
        },
      };
      mockPostsRepository.findById = jest.fn().mockResolvedValue(interruptedPostInDb);

      // Author resumes draft via DraftManagerService
      const resumeResult = await draftManagerService.resumeDraft(actorId, interruptedPostInDb.id);

      expect(resumeResult.action).toBe('FIELD_PROMPT');
      // The first missing required field is 'body' (index 2)
      expect(resumeResult.field?.key).toBe('body');
      expect(resumeResult.text).toContain('Основной текст');
      expect(resumeResult.text).toContain('Обязательное поле');

      // Redis session is restored so user can immediately type the body
      const restoredSessionRaw = await mockRedis.get(`wizard:session:${actorId}`);
      expect(restoredSessionRaw).not.toBeNull();
      const restoredSession = JSON.parse(restoredSessionRaw!);
      expect(restoredSession.postId).toBe(interruptedPostInDb.id);
      expect(restoredSession.fieldIndex).toBe(2); // index of 'body'
      expect(restoredSession.expectedVersion).toBe(2);
    });

    it('2.5 should show CONTROL_CARD on resume if all required fields are already populated in PostgreSQL', async () => {
      const actorId = 'author-uuid-1';

      // Post in PostgreSQL has both title and body filled
      const completedPostInDb = {
        ...initialDraftPost,
        version: 3,
        contentJson: {
          title: 'Полный заголовок',
          body: 'Полный текст статьи',
        },
      };
      mockPostsRepository.findById = jest.fn().mockResolvedValue(completedPostInDb);

      const resumeResult = await draftManagerService.resumeDraft(actorId, completedPostInDb.id);

      expect(resumeResult.action).toBe('CONTROL_CARD');
      expect(resumeResult.post?.id).toBe(completedPostInDb.id);
    });

    it('2.6 should refuse to resume soft-deleted draft (deletedAt !== null)', async () => {
      const actorId = 'author-uuid-1';
      const deletedPost = {
        ...initialDraftPost,
        deletedAt: new Date(),
      };
      mockPostsRepository.findById = jest.fn().mockResolvedValue(deletedPost);

      const resumeResult = await draftManagerService.resumeDraft(actorId, deletedPost.id);

      expect(resumeResult.action).toBe('ERROR');
      expect(resumeResult.text).toContain('не найден или был удален');
    });
  });

  // =========================================================================
  // Dimension 3: Callback Codec Boundary Stress (64-byte Telegram limit)
  // =========================================================================
  describe('3. Callback Codec Boundary Stress (64-byte limit)', () => {
    const rfc4122Uuids = [
      'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      '12345678-1234-4234-8234-123456789abc',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
    ];

    const versionNumbers = [
      1,
      2,
      9,
      10,
      99,
      100,
      9999,
      65535,
      100000,
      9999999,
      2147483647, // Max signed 32-bit integer in PostgreSQL
    ];

    const allActions = Object.values(PostCallbackAction);

    it('3.1 should guarantee NO callback data string exceeds 64 bytes under ALL permutations of action, UUID, and version', () => {
      let maxByteLength = 0;
      let worstCaseString = '';
      let testCount = 0;

      for (const action of allActions) {
        for (const uuid of rfc4122Uuids) {
          for (const version of versionNumbers) {
            testCount++;
            const encoded = CallbackCodec.encode(action, uuid, version);
            const byteLength = Buffer.byteLength(encoded, 'utf8');

            if (byteLength > maxByteLength) {
              maxByteLength = byteLength;
              worstCaseString = encoded;
            }

            expect(byteLength).toBeLessThanOrEqual(64);

            // Also test roundtrip decode
            const decoded = CallbackCodec.decode(encoded);
            expect(decoded).not.toBeNull();
            expect(decoded!.action).toBe(action);
            expect(decoded!.postId).toBe(uuid);
            expect(decoded!.expectedVersion).toBe(version);
          }
        }
      }

      // Verify that we executed a significant number of combinations
      expect(testCount).toBe(allActions.length * rfc4122Uuids.length * versionNumbers.length);
      // Empirical limit verification
      expect(maxByteLength).toBeLessThanOrEqual(64);
      // For reference: longest action is 'pub:sch_ok' (10 chars) + 36 UUID + 10 int + 2 colons = 58 chars
      expect(maxByteLength).toBe(58);
      expect(worstCaseString).toBe('pub:sch_ok:a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d:2147483647');
    });

    it('3.2 should encode and decode read-only post view action within 64 bytes', () => {
      for (const uuid of rfc4122Uuids) {
        const encoded = CallbackCodec.encodeView(uuid);
        const byteLength = Buffer.byteLength(encoded, 'utf8');
        expect(byteLength).toBeLessThanOrEqual(64);
        expect(encoded).toBe(`p:view:${uuid}`);
      }
    });

    it('3.3 should throw an Error if an encoded callback data string exceeds 64 bytes', () => {
      const ultraLongUuid = 'a'.repeat(60);
      expect(() => {
        CallbackCodec.encode(PostCallbackAction.APPROVE, ultraLongUuid, 1);
      }).toThrow(/Callback data exceeds 64-byte limit/);
    });

    it('3.4 should return null on malformed or malicious callback data during decode', () => {
      expect(CallbackCodec.decode('')).toBeNull();
      expect(CallbackCodec.decode(null as any)).toBeNull();
      expect(CallbackCodec.decode('not-enough-parts')).toBeNull();
      expect(CallbackCodec.decode('unknown_action:uuid:1')).toBeNull();
      expect(CallbackCodec.decode('p:sub:uuid:NaN')).toBeNull();
      expect(CallbackCodec.decode('p:sub:uuid:-5')).toBeNull();
      expect(CallbackCodec.decode('p:sub:uuid:0')).toBeNull();
    });

    it('3.5 should verify all keyboards generated by PostControlsKeyboardBuilder strictly adhere to <= 64 bytes', () => {
      const samplePost: Post = {
        id: '12345678-1234-4234-8234-123456789abc',
        channelId: 'chan-1234-4234-8234-123456789abc',
        templateId: 'tpl-1',
        templateVersion: 1,
        authorId: 'user-1',
        status: PostStatus.DRAFT,
        version: 99999,
        contentJson: {},
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const perms: UserContextPermissions = {
        isSuperAdmin: true,
        canApprove: true,
        canPublish: true,
        isAuthor: true,
      };

      const checkKeyboard = (kb: any, name: string) => {
        const inline = kb.inline_keyboard;
        for (const row of inline) {
          for (const btn of row) {
            if (btn.callback_data) {
              const len = Buffer.byteLength(btn.callback_data, 'utf8');
              expect(len).toBeLessThanOrEqual(64);
            }
          }
        }
      };

      // Test across all post statuses
      for (const status of Object.values(PostStatus)) {
        const post = { ...samplePost, status };
        checkKeyboard(PostControlsKeyboardBuilder.buildAuthorControls(post, perms), `AuthorControls-${status}`);
        checkKeyboard(PostControlsKeyboardBuilder.buildReviewControls(post, 1, 3), `ReviewControls-${status}`);
      }

      checkKeyboard(
        PostControlsKeyboardBuilder.buildConfirmationKeyboard(
          PostCallbackAction.DELETE_DRAFT_CONFIRM,
          samplePost.id,
          samplePost.version,
        ),
        'ConfirmationKeyboard',
      );

      checkKeyboard(
        PostControlsKeyboardBuilder.buildSchedulePresetsKeyboard(samplePost.id, samplePost.version),
        'SchedulePresetsKeyboard',
      );
    });
  });

  // =========================================================================
  // Dimension 4: Stale Button Rejection & Optimistic Concurrency Control
  // =========================================================================
  describe('4. Stale Button Rejection & Concurrency (AGENTS.md §7, §13)', () => {
    let mockPostsService: any;
    let mockReviewQueueService: any;
    let mockPostWorkflow: any;
    let mockPublishingService: any;
    let mockPreviewService: any;
    let mockRedis: any;
    let postActionsHandler: PostActionsHandler;
    let reviewQueueHandler: ReviewQueueHandler;

    const currentPostInDb = {
      id: 'post-occ-uuid',
      channelId: 'channel-1',
      templateId: 'tpl-1',
      authorId: 'author-user-uuid',
      status: PostStatus.DRAFT,
      version: 5, // CURRENT VERSION IN POSTGRES IS 5!
      contentJson: { title: 'Updated Title' },
      metadataJson: {},
      deletedAt: null,
      channel: { timezone: 'Europe/Kyiv', title: 'Test Channel' },
    };

    beforeEach(() => {
      mockPostsService = {
        getPostWithRelations: jest.fn().mockResolvedValue(currentPostInDb),
      };
      mockReviewQueueService = {
        getPost: jest.fn().mockResolvedValue(currentPostInDb),
      };
      mockPostWorkflow = {
        transition: jest.fn(),
      };
      mockPublishingService = {
        enqueuePublish: jest.fn(),
      };
      mockPreviewService = {
        updateControlCard: jest.fn().mockResolvedValue(undefined),
        sendPostPreview: jest.fn().mockResolvedValue(undefined),
      };
      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
      };

      postActionsHandler = new PostActionsHandler(
        mockPreviewService,
        mockPostWorkflow,
        mockPostsService,
        mockPublishingService,
        {} as any,
        mockRedis,
        {} as any,
        {} as any,
      );

      reviewQueueHandler = new ReviewQueueHandler(
        mockReviewQueueService,
        mockPreviewService,
        mockPostWorkflow,
        mockRedis,
      );
    });

    it('4.1 should reject Submit for Review when button version is stale (version 2 vs current 5)', async () => {
      const staleVersion = 2;
      const ctx = {
        authUser: { id: 'author-user-uuid', systemRole: SystemRole.USER, channelMemberships: [] },
        callbackQuery: { id: 'cb-stale-1', message: { message_id: 101 } },
        chat: { id: 123456 },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        canChannel: jest.fn().mockReturnValue(true),
        isSuperAdmin: false,
      } as unknown as BotContext;

      await postActionsHandler.handleSubmitForReview(ctx, currentPostInDb.id, staleVersion);

      // Invariant 1: Must show friendly Russian alert toast
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: '⚠️ Публикация была изменена другим пользователем. Интерфейс обновлен.',
        show_alert: true,
      });

      // Invariant 2: Must NOT execute transition or mutate post
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();

      // Invariant 3: Control card must be refreshed with latest version
      expect(mockPreviewService.updateControlCard).toHaveBeenCalledTimes(1);
    });

    it('4.2 should reject Publish Now when button version is stale (version 3 vs current 5)', async () => {
      const staleVersion = 3;
      const ctx = {
        authUser: { id: 'editor-user-uuid', systemRole: SystemRole.USER, channelMemberships: [] },
        callbackQuery: { id: 'cb-stale-2', message: { message_id: 102 } },
        chat: { id: 123456 },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        canChannel: jest.fn().mockReturnValue(true),
        isSuperAdmin: false,
      } as unknown as BotContext;

      await postActionsHandler.handlePublishNow(ctx, currentPostInDb.id, staleVersion);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: '⚠️ Публикация была изменена другим пользователем.',
        show_alert: true,
      });
      expect(mockPublishingService.enqueuePublish).not.toHaveBeenCalled();
      expect(mockPreviewService.updateControlCard).toHaveBeenCalledTimes(1);
    });

    it('4.3 should reject Approve when button version is stale (version 1 vs current 5)', async () => {
      const staleVersion = 1;
      const ctx = {
        authUser: { id: 'editor-user-uuid', systemRole: SystemRole.USER, channelMemberships: [] },
        callbackQuery: { id: 'cb-stale-3', message: { message_id: 103 } },
        chat: { id: 123456 },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        canChannel: jest.fn().mockReturnValue(true),
        isSuperAdmin: false,
      } as unknown as BotContext;

      await reviewQueueHandler.handleApprove(ctx, currentPostInDb.id, staleVersion);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: '⚠️ Публикация была изменена другим пользователем. Интерфейс обновлен.',
        show_alert: true,
      });
      expect(mockPostWorkflow.transition).not.toHaveBeenCalled();
      expect(mockPreviewService.updateControlCard).toHaveBeenCalledTimes(1);
    });

    it('4.4 should handle PostConflictException in TelegramExceptionFilter with show_alert and friendly Russian message', async () => {
      const filter = new TelegramExceptionFilter();
      const conflictError = new PostConflictException(
        'Post version conflict. Expected: 2, actual: 5',
      );

      const ctx = {
        callbackQuery: { id: 'cb-filter-occ' },
        chat: { id: 123456 },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        reply: jest.fn(),
      } as unknown as BotContext;

      await filter.handleError(conflictError, ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: '⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие.',
        show_alert: true,
      });
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dimension 5: Empirical Bug Confirmation — Draft Deletion Hardcoded Version 1
  // =========================================================================
  describe('5. Empirical Bug Confirmation: Draft Deletion from /drafts menu', () => {
    it('5.1 confirms that handleConfirmDeleteDraft fails OCC when post was autosaved beyond version 1', async () => {
      // Setup: Post in DB has been autosaved twice, so version is 3
      const postV3: Post = {
        id: 'post-draft-v3',
        channelId: 'chan-1',
        templateId: 'tpl-1',
        templateVersion: 1,
        authorId: 'author-uuid-1',
        status: PostStatus.DRAFT,
        version: 3,
        contentJson: { title: 'My Draft', body: 'My Body' },
        metadataJson: {},
        scheduledAt: null,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDraftManagerService = {
        deleteDraft: jest.fn().mockImplementation((actorId, postId, expectedVersion) => {
          if (expectedVersion !== postV3.version) {
            throw new PostConflictException(
              `Draft deletion failed: version conflict. Expected: ${expectedVersion}, Actual: ${postV3.version}`,
            );
          }
          return Promise.resolve({ ...postV3, deletedAt: new Date() });
        }),
      };

      const handler = new DraftManagerHandler(
        mockDraftManagerService as any,
        {} as any,
      );

      const ctx = {
        authUser: { id: 'author-uuid-1' },
        callbackQuery: { id: 'cb-del-draft' },
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
        reply: jest.fn(),
      } as unknown as BotContext;

      // When user clicks the button generated by draft-manager.handler.ts:108 (`draft:cdel:${postId}:1`),
      // the version string passed to handleConfirmDeleteDraft is '1':
      await expect(
        handler.handleConfirmDeleteDraft(ctx, postV3.id, '1'),
      ).rejects.toThrow(PostConflictException);

      expect(mockDraftManagerService.deleteDraft).toHaveBeenCalledWith(
        'author-uuid-1',
        postV3.id,
        1, // Received hardcoded 1 instead of actual 3!
      );
    });
  });
});
