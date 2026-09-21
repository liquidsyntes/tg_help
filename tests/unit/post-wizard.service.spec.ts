import { PostWizardService } from '../../src/modules/telegram/services/post-wizard.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { TemplatesService } from '../../src/modules/templates/templates.service';
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { ChannelsService } from '../../src/modules/channels/channels.service';
import { MediaService } from '../../src/modules/media/media.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { PostStatus, Channel, PostTemplate, Post } from '@prisma/client';

describe('PostWizardService', () => {
  let service: PostWizardService;
  let postsService: jest.Mocked<Partial<PostsService>>;
  let postsRepository: jest.Mocked<Partial<PostsRepository>>;
  let templatesService: jest.Mocked<Partial<TemplatesService>>;
  let channelsService: jest.Mocked<Partial<ChannelsService>>;
  let mediaService: jest.Mocked<Partial<MediaService>>;
  let redis: jest.Mocked<Partial<RedisService>>;
  let validator: TemplateValidator;
  let htmlSanitizer: HtmlSanitizer;

  const mockChannel: Channel = {
    id: 'ch-1',
    telegramChatId: '-1001234567890',
    title: 'Основной канал',
    username: 'main_channel',
    timezone: 'Europe/Kyiv',
    publicationMode: 'DIRECT',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTemplate: PostTemplate = {
    id: 'tpl-1',
    key: 'news',
    name: 'Новость',
    description: 'Новостной пост',
    schemaJson: {
      fields: [
        { key: 'title', label: 'Заголовок', type: 'text', required: true, maxLength: 100 },
        { key: 'body', label: 'Основной текст', type: 'rich_text', required: true },
        { key: 'source', label: 'Источник', type: 'url', required: false },
      ],
    },
    renderConfig: { layout: 'standard' },
    supportedMediaTypes: ['PHOTO'],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPost: Post = {
    id: 'post-1',
    channelId: 'ch-1',
    templateId: 'tpl-1',
    templateVersion: 1,
    authorId: 'author-1',
    status: PostStatus.DRAFT,
    version: 1,
    contentJson: {},
    metadataJson: {},
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const sessionStore = new Map<string, string>();

  beforeEach(() => {
    sessionStore.clear();

    postsService = {
      createDraft: jest.fn().mockResolvedValue(mockPost),
      autosaveStep: jest.fn().mockImplementation((id, v, a, key, val) =>
        Promise.resolve({
          ...mockPost,
          version: v + 1,
          contentJson: { [key]: val },
        }),
      ),
    };

    postsRepository = {
      findById: jest.fn().mockResolvedValue({
        ...mockPost,
        template: mockTemplate,
        channel: mockChannel,
        media: [],
        author: { id: 'author-1', firstName: 'Ivan', telegramId: 123n },
      }),
    };

    templatesService = {
      getActiveTemplates: jest.fn().mockResolvedValue([mockTemplate]),
      getById: jest.fn().mockResolvedValue(mockTemplate),
    };

    channelsService = {
      autoSkipSingleChannel: jest.fn(),
    };

    mediaService = {
      attachMedia: jest.fn(),
      attachMediaBatch: jest.fn(),
    };

    redis = {
      get: jest.fn().mockImplementation((k) => Promise.resolve(sessionStore.get(k) || null)),
      set: jest.fn().mockImplementation((k, v) => {
        sessionStore.set(k, v);
        return Promise.resolve('OK');
      }),
      del: jest.fn().mockImplementation((k) => {
        sessionStore.delete(k);
        return Promise.resolve(1);
      }),
      getClient: jest.fn().mockReturnValue({
        rpush: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
        lrange: jest.fn().mockResolvedValue([]),
      } as any),
    };

    validator = new TemplateValidator();
    htmlSanitizer = new HtmlSanitizer();

    service = new PostWizardService(
      postsService as unknown as PostsService,
      postsRepository as unknown as PostsRepository,
      templatesService as unknown as TemplatesService,
      validator,
      channelsService as unknown as ChannelsService,
      mediaService as unknown as MediaService,
      redis as unknown as RedisService,
      htmlSanitizer,
    );
  });

  it('should auto-skip channel selection when user has exactly 1 authorized channel (F-05)', async () => {
    channelsService.autoSkipSingleChannel = jest.fn().mockResolvedValue({
      singleChannel: mockChannel,
      channels: [mockChannel],
      mustChoose: false,
    });

    const res = await service.startWizard('author-1');

    expect(res.type).toBe('TEMPLATE_SELECT');
    expect(res.text).toContain(mockChannel.title);
    expect(res.templates).toHaveLength(1);

    const session = await service.getSession('author-1');
    expect(session?.channelId).toBe(mockChannel.id);
    expect(session?.step).toBe('TEMPLATE_SELECT');
  });

  it('should prompt channel selection when user has multiple authorized channels', async () => {
    const mockChannel2 = { ...mockChannel, id: 'ch-2', title: 'Второй канал' };
    channelsService.autoSkipSingleChannel = jest.fn().mockResolvedValue({
      singleChannel: null,
      channels: [mockChannel, mockChannel2],
      mustChoose: true,
    });

    const res = await service.startWizard('author-1');

    expect(res.type).toBe('CHANNEL_SELECT');
    expect(res.channels).toHaveLength(2);

    const session = await service.getSession('author-1');
    expect(session?.step).toBe('CHANNEL_SELECT');
  });

  it('should return error when user has zero authorized channels', async () => {
    channelsService.autoSkipSingleChannel = jest.fn().mockResolvedValue({
      singleChannel: null,
      channels: [],
      mustChoose: false,
    });

    const res = await service.startWizard('author-1');

    expect(res.type).toBe('ERROR');
    expect(res.text).toContain('У вас нет доступа ни к одному каналу');
  });

  it('should create draft in PostgreSQL upon template selection and prompt first field', async () => {
    await service.saveSession('author-1', {
      channelId: 'ch-1',
      step: 'TEMPLATE_SELECT',
    });

    const res = await service.selectTemplate('author-1', 'tpl-1');

    expect(postsService.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'author-1',
        channelId: 'ch-1',
        templateId: 'tpl-1',
      }),
    );

    expect(res.type).toBe('FIELD_PROMPT');
    expect(res.text).toContain('Заголовок');

    const session = await service.getSession('author-1');
    expect(session?.postId).toBe(mockPost.id);
    expect(session?.step).toBe('FIELD_INPUT');
    expect(session?.fieldIndex).toBe(0);
  });

  it('should validate field input and prompt error without advancing on invalid input', async () => {
    await service.saveSession('author-1', {
      postId: 'post-1',
      channelId: 'ch-1',
      templateId: 'tpl-1',
      step: 'FIELD_INPUT',
      fieldIndex: 0,
      expectedVersion: 1,
    });

    // Empty title for required field
    const res = await service.processFieldInput('author-1', '');

    expect(res.type).toBe('FIELD_PROMPT');
    expect(res.text).toContain('Ошибка проверки');
    expect(postsService.autosaveStep).not.toHaveBeenCalled();

    const session = await service.getSession('author-1');
    expect(session?.fieldIndex).toBe(0); // Not advanced
  });

  it('should immediately autosave valid input to PostgreSQL and advance to next field', async () => {
    await service.saveSession('author-1', {
      postId: 'post-1',
      channelId: 'ch-1',
      templateId: 'tpl-1',
      step: 'FIELD_INPUT',
      fieldIndex: 0,
      expectedVersion: 1,
    });

    const res = await service.processFieldInput('author-1', 'Важная новость дня');

    expect(postsService.autosaveStep).toHaveBeenCalledWith(
      'post-1',
      1,
      'author-1',
      'title',
      'Важная новость дня',
    );

    expect(res.type).toBe('FIELD_PROMPT');
    expect(res.text).toContain('Основной текст');

    const session = await service.getSession('author-1');
    expect(session?.fieldIndex).toBe(1);
    expect(session?.expectedVersion).toBe(2);
  });

  it('should reject skipping a required field', async () => {
    await service.saveSession('author-1', {
      postId: 'post-1',
      channelId: 'ch-1',
      templateId: 'tpl-1',
      step: 'FIELD_INPUT',
      fieldIndex: 0,
      expectedVersion: 1,
    });

    const res = await service.skipField('author-1', 'title');

    expect(res.type).toBe('FIELD_PROMPT');
    expect(res.text).toContain('обязательно для заполнения и не может быть пропущено');
    expect(postsService.autosaveStep).not.toHaveBeenCalled();
  });

  it('should allow skipping an optional field and autosave null', async () => {
    await service.saveSession('author-1', {
      postId: 'post-1',
      channelId: 'ch-1',
      templateId: 'tpl-1',
      step: 'FIELD_INPUT',
      fieldIndex: 2, // 'source' is optional
      expectedVersion: 3,
    });

    const res = await service.skipField('author-1', 'source');

    expect(postsService.autosaveStep).toHaveBeenCalledWith(
      'post-1',
      1,
      'author-1',
      'source',
      null,
    );

    // After all 3 fields, since template supports PHOTO, transitions to MEDIA_PROMPT
    expect(res.type).toBe('MEDIA_PROMPT');
  });

  it('should cancel wizard and clear session from Redis', async () => {
    await service.saveSession('author-1', {
      postId: 'post-1',
      step: 'FIELD_INPUT',
    });

    await service.cancelWizard('author-1');

    const session = await service.getSession('author-1');
    expect(session).toBeNull();
  });
});
