/**
 * Post Controls Keyboard Builder
 * Builds contextual inline action keyboards for Companion Control Cards and Review Cards.
 * Authoritative reference: AGENTS.md § 15, § 51, § 52, § 54; tasks.md § 9, § 13
 */

import { InlineKeyboard } from 'grammy';
import { Post, PostStatus } from '@prisma/client';
import { CallbackCodec, PostCallbackAction } from '../utils/callback-data.codec';

export interface UserContextPermissions {
  isSuperAdmin: boolean;
  canApprove: boolean;
  canPublish: boolean;
  isAuthor: boolean;
}

export class PostControlsKeyboardBuilder {
  /**
   * Constructs the action keyboard for the Post Companion Control Card.
   */
  static buildAuthorControls(post: Post, perms: UserContextPermissions): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Editable statuses: DRAFT or NEEDS_REVISION
    if (post.status === PostStatus.DRAFT || post.status === PostStatus.NEEDS_REVISION) {
      kb.text(
        '✅ На согласование',
        CallbackCodec.encode(PostCallbackAction.SUBMIT_FOR_REVIEW, post.id, post.version),
      ).row();

      kb.text(
        '✏️ Редактировать',
        CallbackCodec.encode(PostCallbackAction.EDIT_POST, post.id, post.version),
      );
      kb.text(
        '🖼 Медиа',
        CallbackCodec.encode(PostCallbackAction.MANAGE_MEDIA, post.id, post.version),
      ).row();

      kb.text(
        '🗑 Удалить черновик',
        CallbackCodec.encode(PostCallbackAction.DELETE_DRAFT_PROMPT, post.id, post.version),
      ).row();
    }

    // Status: APPROVED
    if (post.status === PostStatus.APPROVED) {
      if (perms.canPublish || perms.isSuperAdmin) {
        kb.text(
          '🚀 Опубликовать',
          CallbackCodec.encode(PostCallbackAction.PUBLISH_NOW, post.id, post.version),
        );
        kb.text(
          '📅 Запланировать',
          CallbackCodec.encode(PostCallbackAction.SCHEDULE_PROMPT, post.id, post.version),
        ).row();
      }
    }

    // Status: SCHEDULED
    if (post.status === PostStatus.SCHEDULED) {
      if (perms.canPublish || perms.canApprove || perms.isSuperAdmin) {
        kb.text(
          '❌ Отменить расписание',
          CallbackCodec.encode(PostCallbackAction.CANCEL_SCHEDULE_PROMPT, post.id, post.version),
        ).row();
      }
    }

    // Status: PUBLISH_FAILED
    if (post.status === PostStatus.PUBLISH_FAILED) {
      if (perms.canPublish || perms.isSuperAdmin) {
        kb.text(
          '🔁 Повторить публикацию',
          CallbackCodec.encode(PostCallbackAction.RETRY_PUBLISH, post.id, post.version),
        ).row();
      }
    }

    kb.text('🔙 В главное меню', 'nav:main');
    return kb;
  }

  /**
   * Constructs the action keyboard for the Editor Review Card.
   */
  static buildReviewControls(post: Post, currentIndex: number, totalCount: number): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Row 1: Decision actions
    kb.text(
      '✅ Одобрить',
      CallbackCodec.encode(PostCallbackAction.APPROVE, post.id, post.version),
    );
    kb.text(
      '↩️ На доработку',
      CallbackCodec.encode(PostCallbackAction.REQUEST_REVISION, post.id, post.version),
    ).row();

    // Row 2: Secondary actions
    kb.text(
      '✏️ Редактировать',
      CallbackCodec.encode(PostCallbackAction.EDIT_POST, post.id, post.version),
    );
    kb.text(
      '❌ Отклонить',
      CallbackCodec.encode(PostCallbackAction.REJECT_PROMPT, post.id, post.version),
    ).row();

    // Row 3: Pagination if multiple pending
    if (totalCount > 1) {
      if (currentIndex > 0) {
        kb.text('⬅️ Предыдущий', `q:card:${post.channelId}:${currentIndex - 1}`);
      }
      if (currentIndex < totalCount - 1) {
        kb.text('Следующий ➡️', `q:card:${post.channelId}:${currentIndex + 1}`);
      }
      kb.row();
    }

    kb.text('🔙 В главное меню', 'nav:main');
    return kb;
  }

  /**
   * Confirmation keyboard for destructive actions.
   */
  static buildConfirmationKeyboard(
    confirmAction: PostCallbackAction,
    postId: string,
    version: number,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text('⚠️ Да, подтвердить', CallbackCodec.encode(confirmAction, postId, version))
      .text('🔙 Отмена', CallbackCodec.encodeView(postId));
  }

  /**
   * Scheduling Presets Keyboard
   */
  static buildSchedulePresetsKeyboard(postId: string, version: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('Через 1 час', CallbackCodec.encode(PostCallbackAction.PRESET_1H, postId, version))
      .text('Через 3 часа', CallbackCodec.encode(PostCallbackAction.PRESET_3H, postId, version))
      .row()
      .text(
        'Завтра в 10:00',
        CallbackCodec.encode(PostCallbackAction.PRESET_TOMORROW_10, postId, version),
      )
      .text(
        'Завтра в 18:00',
        CallbackCodec.encode(PostCallbackAction.PRESET_TOMORROW_18, postId, version),
      )
      .row()
      .text('🔙 Отмена', CallbackCodec.encodeView(postId));
  }
}
