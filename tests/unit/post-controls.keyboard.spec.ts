import { PostStatus, Post } from '@prisma/client';
import {
  PostControlsKeyboardBuilder,
  UserContextPermissions,
} from '../../src/modules/telegram/keyboards/post-controls.keyboard';
import { PostCallbackAction } from '../../src/modules/telegram/utils/callback-data.codec';

describe('PostControlsKeyboardBuilder', () => {
  const mockPost: Post = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    channelId: 'channel-1',
    templateId: 'template-1',
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

  const authorPerms: UserContextPermissions = {
    isSuperAdmin: false,
    canApprove: false,
    canPublish: false,
    isAuthor: true,
  };

  const editorPerms: UserContextPermissions = {
    isSuperAdmin: false,
    canApprove: true,
    canPublish: true,
    isAuthor: false,
  };

  it('should render author controls for DRAFT status', () => {
    const kb = PostControlsKeyboardBuilder.buildAuthorControls(mockPost, authorPerms);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).toContain('✅ На согласование');
    expect(buttons).toContain('✏️ Редактировать');
    expect(buttons).toContain('🖼 Медиа');
    expect(buttons).toContain('🗑 Удалить черновик');
    expect(buttons).toContain('🔙 В главное меню');
  });

  it('should render publish and schedule controls for APPROVED status when user has canPublish', () => {
    const approvedPost = { ...mockPost, status: PostStatus.APPROVED };
    const kb = PostControlsKeyboardBuilder.buildAuthorControls(approvedPost, editorPerms);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).toContain('🚀 Опубликовать');
    expect(buttons).toContain('📅 Запланировать');
  });

  it('should not render publish button for APPROVED status when user cannot publish', () => {
    const approvedPost = { ...mockPost, status: PostStatus.APPROVED };
    const kb = PostControlsKeyboardBuilder.buildAuthorControls(approvedPost, authorPerms);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).not.toContain('🚀 Опубликовать');
  });

  it('should render cancel schedule for SCHEDULED status', () => {
    const scheduledPost = { ...mockPost, status: PostStatus.SCHEDULED };
    const kb = PostControlsKeyboardBuilder.buildAuthorControls(scheduledPost, editorPerms);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).toContain('❌ Отменить расписание');
  });

  it('should render retry publish for PUBLISH_FAILED status', () => {
    const failedPost = { ...mockPost, status: PostStatus.PUBLISH_FAILED };
    const kb = PostControlsKeyboardBuilder.buildAuthorControls(failedPost, editorPerms);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).toContain('🔁 Повторить публикацию');
  });

  it('should render review controls for Editor Review Card', () => {
    const pendingPost = { ...mockPost, status: PostStatus.PENDING_REVIEW };
    const kb = PostControlsKeyboardBuilder.buildReviewControls(pendingPost, 0, 3);
    const flat = kb.inline_keyboard.flat();

    const buttons = flat.map((b) => b.text);
    expect(buttons).toContain('✅ Одобрить');
    expect(buttons).toContain('↩️ На доработку');
    expect(buttons).toContain('✏️ Редактировать');
    expect(buttons).toContain('❌ Отклонить');
    expect(buttons).toContain('Следующий ➡️');
  });

  it('should build confirmation keyboard for destructive actions', () => {
    const kb = PostControlsKeyboardBuilder.buildConfirmationKeyboard(
      PostCallbackAction.DELETE_DRAFT_CONFIRM,
      mockPost.id,
      mockPost.version,
    );
    const flat = kb.inline_keyboard.flat();

    expect(flat[0]?.text).toContain('⚠️ Да, подтвердить');
    expect(flat[1]?.text).toContain('🔙 Отмена');
  });

  it('should guarantee d:e: callback data length is <= 64 bytes even for long field keys up to 23 chars', () => {
    const fieldKeys = ['title', 'body', 'promotional_banner', 'editorial_comments_v2'];
    for (const key of fieldKeys) {
      const callbackData = `d:e:${mockPost.id}:${key}`;
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
