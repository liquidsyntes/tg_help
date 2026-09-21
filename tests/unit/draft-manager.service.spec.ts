import { DraftManagerService } from '../../src/modules/telegram/services/draft-manager.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { TemplatesService } from '../../src/modules/templates/templates.service';
import { TemplateValidator } from '../../src/modules/templates/template.validator';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { HtmlSanitizer } from '../../src/modules/rendering/html-sanitizer.service';
import { PostStatus, Channel, PostTemplate, Post } from '@prisma/client';

describe('DraftManagerService', () => {
  let service: DraftManagerService;
  let postsService: jest.Mocked<Partial<PostsService>>;
  let postsRepository: jest.Mocked<Partial<PostsRepository>>;
  let templatesService: jest.Mocked<Partial<TemplatesService>>;
  let redis: jest.Mocked<Partial<RedisService>>;
  let validator: TemplateValidator;
  let htmlSanitizer: HtmlSanitizer;

  const mockChannel: Channel = {
    id: 'ch-1',
    telegramChatId: '-1001234567890',
    title: 'Канал',
    username: 'channel',
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
        { key: 'title', label: 'Заголовок', type: 'text', required: true },
        { key: 'body', label: 'Основной текст', type: 'rich_text', required: true },
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
    contentJson: { title: 'Привет мир' },
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
      autosaveStep: jest.fn().mockResolvedValue({ ...mockPost, version: 2 }),
      softDeletePost: jest.fn().mockResolvedValue({ ...mockPost, deletedAt: new Date() }),
    };

    postsRepository = {
      findByAuthor: jest.fn().mockResolvedValue([mockPost]),
      findById: jest.fn().mockResolvedValue({
        ...mockPost,
        template: mockTemplate,
        channel: mockChannel,
        media: [],
        author: { id: 'author-1', firstName: 'Ivan', telegramId: 123n },
      }),
    };

    templatesService = {
      getById: jest.fn().mockResolvedValue(mockTemplate),
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
    };

    validator = new TemplateValidator();
    htmlSanitizer = new HtmlSanitizer();

    service = new DraftManagerService(
      postsService as unknown as PostsService,
      postsRepository as unknown as PostsRepository,
      templatesService as unknown as TemplatesService,
      validator,
      redis as unknown as RedisService,
      htmlSanitizer,
    );
  });

  it('should list drafts and posts needing revision for the author', async () => {
    const list = await service.listDrafts('author-1');
    expect(list).toHaveLength(2); // Mocked findByAuthor called twice (DRAFT & NEEDS_REVISION)
    expect(postsRepository.findByAuthor).toHaveBeenCalledWith('author-1', PostStatus.DRAFT);
    expect(postsRepository.findByAuthor).toHaveBeenCalledWith('author-1', PostStatus.NEEDS_REVISION);
  });

  it('should resume draft at first missing required field when incomplete', async () => {
    // Post has 'title' but missing required 'body'
    const res = await service.resumeDraft('author-1', 'post-1');

    expect(res.action).toBe('FIELD_PROMPT');
    expect(res.text).toContain('Основной текст');
    expect(res.field?.key).toBe('body');

    // Saved to Redis session
    const raw = sessionStore.get('wizard:session:author-1');
    expect(raw).toBeDefined();
    const session = JSON.parse(raw!);
    expect(session.step).toBe('FIELD_INPUT');
    expect(session.fieldIndex).toBe(1);
  });

  it('should show control card when resuming a draft where all required fields are filled', async () => {
    postsRepository.findById = jest.fn().mockResolvedValue({
      ...mockPost,
      contentJson: { title: 'Привет мир', body: 'Текст новости' },
      template: mockTemplate,
      channel: mockChannel,
      media: [],
      author: { id: 'author-1', firstName: 'Ivan', telegramId: 123n },
    });

    const res = await service.resumeDraft('author-1', 'post-1');

    expect(res.action).toBe('CONTROL_CARD');
    expect(res.post).toBeDefined();
  });

  it('should perform granular field editing under OCC', async () => {
    const prompt = await service.startEditField('author-1', 'post-1', 'title');
    expect(prompt.text).toContain('Редактирование поля «Заголовок»');

    const submitRes = await service.submitEditedField('author-1', 'Новый обновленный заголовок');
    expect(submitRes.success).toBe(true);
    expect(postsService.autosaveStep).toHaveBeenCalledWith(
      'post-1',
      1,
      'author-1',
      'title',
      'Новый обновленный заголовок',
    );
  });

  it('should soft-delete draft with expected version', async () => {
    await service.deleteDraft('author-1', 'post-1', 1);
    expect(postsService.softDeletePost).toHaveBeenCalledWith('post-1', 1, 'author-1');
  });
});
