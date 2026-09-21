import { TelegramPreviewService } from '../../src/modules/telegram/services/telegram-preview.service';
import { TelegramRenderer } from '../../src/modules/rendering/telegram-renderer.service';
import { ITelegramPublisher } from '../../src/infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import { PostStatus, Channel, PostTemplate, Post } from '@prisma/client';
import { Api } from 'grammy';

describe('TelegramPreviewService', () => {
  let service: TelegramPreviewService;
  let renderer: jest.Mocked<Partial<TelegramRenderer>>;
  let publisher: jest.Mocked<Partial<ITelegramPublisher>>;
  let mockApi: jest.Mocked<Partial<Api>>;

  const mockChannel: Channel = {
    id: 'ch-1',
    telegramChatId: '-1001234567890',
    title: 'Тестовый канал',
    username: 'test_ch',
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
    schemaJson: { fields: [] },
    renderConfig: { layout: 'standard' },
    supportedMediaTypes: ['PHOTO'],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPostWithRelations: any = {
    id: 'post-1',
    channelId: 'ch-1',
    templateId: 'tpl-1',
    templateVersion: 1,
    authorId: 'author-1',
    status: PostStatus.DRAFT,
    version: 1,
    contentJson: { title: 'Заголовок' },
    metadataJson: {},
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    template: mockTemplate,
    channel: mockChannel,
    media: [],
    author: {
      id: 'author-1',
      firstName: 'Алексей',
      telegramId: 12345n,
    },
    reviews: [],
  };

  beforeEach(() => {
    renderer = {
      render: jest.fn().mockResolvedValue({
        messages: [{ type: 'text', text: '<b>Заголовок</b>' }],
      }),
    };

    publisher = {
      publishOutgoingMessage: jest.fn().mockResolvedValue([101]),
      sendMessage: jest.fn().mockResolvedValue(102),
    };

    mockApi = {
      editMessageReplyMarkup: jest.fn().mockResolvedValue(true as any),
      editMessageText: jest.fn().mockResolvedValue(true as any),
    };

    service = new TelegramPreviewService(
      renderer as unknown as TelegramRenderer,
      publisher as unknown as ITelegramPublisher,
    );
  });

  it('should render canonical preview using TelegramRenderer and send companion control card', async () => {
    const controlMessageId = await service.sendPostPreview(
      mockApi as unknown as Api,
      12345,
      mockPostWithRelations,
      {
        isSuperAdmin: false,
        canApprove: false,
        canPublish: false,
        isAuthor: true,
      },
    );

    expect(renderer.render).toHaveBeenCalledWith(
      mockPostWithRelations,
      mockTemplate,
      [],
    );
    expect(publisher.publishOutgoingMessage).toHaveBeenCalledWith(
      '12345',
      expect.objectContaining({ type: 'text', text: '<b>Заголовок</b>' }),
    );
    expect(publisher.sendMessage).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('Панель управления публикацией'),
      expect.objectContaining({ parseMode: 'HTML' }),
    );
    expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledWith(
      12345,
      102,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(controlMessageId).toBe(102);
  });

  it('should update existing control card in-place with override notice', async () => {
    await service.updateControlCard(
      mockApi as unknown as Api,
      12345,
      102,
      mockPostWithRelations,
      {
        isSuperAdmin: false,
        canApprove: false,
        canPublish: false,
        isAuthor: true,
      },
      '✅ <b>Публикация успешно одобрена!</b>',
    );

    expect(mockApi.editMessageText).toHaveBeenCalledWith(
      12345,
      102,
      expect.stringContaining('Публикация успешно одобрена'),
      expect.objectContaining({
        parse_mode: 'HTML',
        reply_markup: expect.anything(),
      }),
    );
  });
});
