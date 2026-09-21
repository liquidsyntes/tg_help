/**
 * Review Queue Transport Handler
 * Handles review cards, approve, request revision (with mandatory feedback comment), and reject.
 * Authoritative reference: tasks.md § 8, § 13; AGENTS.md § 10, § 13, § 51, § 52
 */

import { Injectable, Optional } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { PostStatus } from '@prisma/client';
import { ChannelPermission, PostAction } from '../../../common/enums';
import { BotContext } from '../interfaces/bot-context.interface';
import { ReviewQueueService } from '../services/review-queue.service';
import { TelegramPreviewService, PostWithRelations } from '../services/telegram-preview.service';
import { PostControlsKeyboardBuilder } from '../keyboards/post-controls.keyboard';
import { PostWorkflowService } from '../../posts/post-workflow.service';
import { PostsRepository } from '../../posts/posts.repository';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { ReviewSessionData } from '../interfaces/wizard-session.interface';

@Injectable()
export class ReviewQueueHandler {
  constructor(
    private readonly reviewQueueService: ReviewQueueService,
    private readonly previewService: TelegramPreviewService,
    private readonly postWorkflow: PostWorkflowService,
    private readonly postsRepository: PostsRepository,
    private readonly redis: RedisService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  private sessionKey(userId: string): string {
    return `user:session:${userId}`;
  }

  /**
   * Menu button '✅ На согласовании' or /reviews
   */
  async handleOpenReviewQueue(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const posts = await this.reviewQueueService.getPendingPostsForUser(user);

    if (posts.length === 0) {
      await ctx.reply('🎉 <b>Очередь согласования пуста!</b>\n\nНет публикаций, ожидающих проверки.', {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 В главное меню', 'nav:main'),
      });
      return;
    }

    await this.renderReviewCard(ctx, posts, 0);
  }

  /**
   * Navigate review card: q:card:<channelId>:<index>
   */
  async handleCardNavigation(ctx: BotContext, indexStr: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const index = parseInt(indexStr, 10) || 0;

    const posts = await this.reviewQueueService.getPendingPostsForUser(user);
    if (posts.length === 0) {
      await ctx.reply('🎉 Очередь согласования пуста!', {
        reply_markup: new InlineKeyboard().text('🔙 В главное меню', 'nav:main'),
      });
      return;
    }

    const safeIndex = Math.max(0, Math.min(index, posts.length - 1));
    await this.renderReviewCard(ctx, posts, safeIndex);
  }

  /**
   * Approve: r:app:<postId>:<expectedVersion>
   */
  async handleApprove(ctx: BotContext, postId: string, expectedVersion: number): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post || post.deletedAt !== null) {
      await ctx.answerCallbackQuery({
        text: '❌ Публикация не найдена или была удалена.',
        show_alert: true,
      });
      return;
    }

    // Stale Button Defense (AGENTS.md §51, §52)
    if (post.version !== expectedVersion) {
      await ctx.answerCallbackQuery({
        text: '⚠️ Публикация была изменена другим пользователем. Интерфейс обновлен.',
        show_alert: true,
      });
      if (ctx.callbackQuery?.message?.message_id && ctx.chat) {
        await this.previewService.updateControlCard(
          ctx.api,
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          post,
          {
            isSuperAdmin: ctx.isSuperAdmin,
            canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, post.channelId),
            canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, post.channelId),
            isAuthor: post.authorId === user.id,
          },
          '⚠️ <i>Версия публикации устарела. Загружены актуальные данные.</i>',
        );
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: '✅ Одобрено!' });

    const approved = await this.postWorkflow.transition({
      postId,
      expectedVersion,
      actorId: user.id,
      action: PostAction.APPROVE,
      targetStatus: PostStatus.APPROVED,
    });

    const fullApproved = (await this.postsRepository.findById(
      approved.id,
    )) as PostWithRelations;

    if (ctx.callbackQuery?.message?.message_id && ctx.chat) {
      await this.previewService.updateControlCard(
        ctx.api,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        fullApproved,
        {
          isSuperAdmin: ctx.isSuperAdmin,
          canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, approved.channelId),
          canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, approved.channelId),
          isAuthor: approved.authorId === user.id,
        },
        '✅ <b>Публикация успешно одобрена!</b>',
      );
    }
  }

  /**
   * Request Revision: r:rev:<postId>:<expectedVersion>
   */
  async handleRequestRevisionPrompt(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const post = await this.postsRepository.findById(postId);
    if (!post) {
      await ctx.answerCallbackQuery({ text: 'Публикация не найдена', show_alert: true });
      return;
    }

    if (post.version !== expectedVersion) {
      await ctx.answerCallbackQuery({
        text: '⚠️ Публикация была изменена другим пользователем.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    // Store conversational session in Redis (15-min TTL)
    await this.redis.set(
      this.sessionKey(user.id),
      JSON.stringify({
        state: 'AWAITING_REVISION_COMMENT',
        postId,
        expectedVersion,
      } as ReviewSessionData),
      900,
    );

    const kb = new InlineKeyboard().text('🔙 Отмена', `p:view:${postId}`);

    await ctx.reply(
      `↩️ <b>Возврат на доработку</b>\n\n` +
        `Пожалуйста, отправьте сообщение с комментарием для автора: укажите, что необходимо исправить или дополнить.\n\n` +
        `<i>Комментарий обязателен для возврата на доработку.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  }

  /**
   * Reject prompt: r:rej:<postId>:<expectedVersion>
   */
  async handleRejectPrompt(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
      .text('❌ Да, отклонить', `r:rej_ok:${postId}:${expectedVersion}`)
      .text('🔙 Назад', `p:view:${postId}`);

    await ctx.reply(
      `⚠️ <b>Отклонение публикации</b>\n\n` +
        `Вы действительно хотите отклонить эту публикацию? Автор получит уведомление об отказе.`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  }

  /**
   * Reject confirm: r:rej_ok:<postId>:<expectedVersion>
   */
  async handleConfirmReject(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery({ text: 'Публикация отклонена' });

    const rejected = await this.postWorkflow.transition({
      postId,
      expectedVersion,
      actorId: user.id,
      action: PostAction.REJECT,
      targetStatus: PostStatus.REJECTED,
    });

    const fullRejected = (await this.postsRepository.findById(
      rejected.id,
    )) as PostWithRelations;

    if (ctx.chat) {
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, fullRejected, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, rejected.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, rejected.channelId),
        isAuthor: rejected.authorId === user.id,
      });
    }
  }

  /**
   * Text message received while awaiting revision comment
   */
  async handleTextInput(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message?.text) return false;

    const rawSession = await this.redis.get(this.sessionKey(user.id));
    if (!rawSession) return false;

    let session: ReviewSessionData;
    try {
      session = JSON.parse(rawSession) as ReviewSessionData;
    } catch {
      return false;
    }

    if (session.state !== 'AWAITING_REVISION_COMMENT' || !session.postId) {
      return false;
    }

    const comment = ctx.message.text.trim();
    if (comment.length === 0) {
      await ctx.reply(
        '⚠️ Комментарий не может быть пустым. Пожалуйста, укажите замечания для автора:',
      );
      return true;
    }

    await this.postWorkflow.transition({
      postId: session.postId,
      expectedVersion: session.expectedVersion,
      actorId: user.id,
      action: PostAction.REQUEST_REVISION,
      targetStatus: PostStatus.NEEDS_REVISION,
      comment,
    });

    await this.redis.del(this.sessionKey(user.id));

    const kb = new InlineKeyboard()
      .text('📋 К очереди согласования', 'q:card:all:0')
      .text('🔙 В главное меню', 'nav:main');

    await ctx.reply(
      `↩️ <b>Публикация возвращена автору на доработку.</b>\n\n` +
        `Комментарий передан автору:\n«<i>${comment}</i>»`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );

    return true;
  }

  private async renderReviewCard(
    ctx: BotContext,
    posts: PostWithRelations[],
    index: number,
  ): Promise<void> {
    const post = posts[index]!;
    if (ctx.chat) {
      // 1. Send Canonical preview
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: true,
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, post.channelId),
        isAuthor: false,
      });

      // 2. Send Review Queue Card
      const cardHtml = this.reviewQueueService.formatReviewCard(post, index, posts.length);
      const kb = PostControlsKeyboardBuilder.buildReviewControls(post, index, posts.length);

      await ctx.reply(cardHtml, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }
}
