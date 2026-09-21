import { ReviewQueueService } from '../../src/modules/telegram/services/review-queue.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { PostsRepository } from '../../src/modules/posts/posts.repository';
import { SystemRole, ChannelRole } from '../../src/common/enums';
import { PostStatus, Channel, PostTemplate, Post } from '@prisma/client';

describe('ReviewQueueService', () => {
  let service: ReviewQueueService;
  let prisma: jest.Mocked<any>;
  let postsRepository: jest.Mocked<any>;

  const mockChannel: Channel = {
    id: 'ch-1',
    telegramChatId: '-1001234567890',
    title: 'Канал 1',
    username: 'ch1',
    timezone: 'Europe/Kyiv',
    publicationMode: 'DIRECT',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTemplate: PostTemplate = {
    id: 'tpl-1',
    key: 'news',
    name: 'Анонс',
    description: 'Анонс',
    schemaJson: { fields: [] },
    renderConfig: { layout: 'standard' },
    supportedMediaTypes: [],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPost: any = {
    id: 'post-1',
    channelId: 'ch-1',
    templateId: 'tpl-1',
    templateVersion: 1,
    authorId: 'author-1',
    status: PostStatus.PENDING_REVIEW,
    version: 1,
    contentJson: { title: 'Пост на проверку' },
    metadataJson: { commentToEditor: 'Прошу проверить до 18:00' },
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    channel: mockChannel,
    template: mockTemplate,
    media: [],
    author: {
      id: 'author-1',
      firstName: 'Олег',
      username: 'oleg_writer',
      telegramId: 444555n,
    },
    reviews: [],
  };

  beforeEach(() => {
    prisma = {
      channel: {
        findMany: jest.fn().mockResolvedValue([mockChannel]),
      },
      post: {
        findMany: jest.fn().mockResolvedValue([mockPost]),
      },
    };

    postsRepository = {};

    service = new ReviewQueueService(prisma, postsRepository);
  });

  it('should query pending posts for Editor with canApprove', async () => {
    const editorUser: any = {
      id: 'editor-1',
      telegramId: 111n,
      systemRole: SystemRole.USER,
      channelMemberships: [
        {
          channelId: 'ch-1',
          role: ChannelRole.EDITOR,
          canApprove: true,
          canPublish: true,
        },
      ],
    };

    const posts = await service.getPendingPostsForUser(editorUser);

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channelId: { in: ['ch-1'] },
          status: PostStatus.PENDING_REVIEW,
        }),
      }),
    );
    expect(posts).toHaveLength(1);
  });

  it('should query all active channels for Super Admin', async () => {
    const adminUser: any = {
      id: 'admin-1',
      telegramId: 999n,
      systemRole: SystemRole.SUPER_ADMIN,
      channelMemberships: [],
    };

    const posts = await service.getPendingPostsForUser(adminUser);

    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
    expect(posts).toHaveLength(1);
  });

  it('should format review card in card-deck mode with author comments', () => {
    const html = service.formatReviewCard(mockPost, 0, 3);

    expect(html).toContain('<b>Карточка согласования</b> [1 из 3]');
    expect(html).toContain('Канал 1');
    expect(html).toContain('Олег');
    expect(html).toContain('Анонс');
    expect(html).toContain('Прошу проверить до 18:00');
  });
});
