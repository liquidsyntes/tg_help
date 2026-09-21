/**
 * Post Actions Transport Handler
 * Handles Author actions (submit, delete, edit), Reviewer actions, and Publishing/Scheduling actions.
 * Authoritative reference: AGENTS.md § 10, § 13, § 20, § 21, § 24, § 47, § 51, § 52, § 54
 */

import { Injectable, Optional } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { PostStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { ChannelPermission, PostAction } from '../../../common/enums';
import { BotContext } from '../interfaces/bot-context.interface';
import { TelegramPreviewService, PostWithRelations } from '../services/telegram-preview.service';
import {
  PostControlsKeyboardBuilder,
  UserContextPermissions,
} from '../keyboards/post-controls.keyboard';
import { PostWorkflowService } from '../../posts/post-workflow.service';
import { PostsService } from '../../posts/posts.service';
import { PostsRepository } from '../../posts/posts.repository';
import { PublishingService } from '../../publishing/publishing.service';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { TemplatesService } from '../../templates/templates.service';
import { TemplateSchema } from '../../templates/interfaces/template.interface';
import {
  parseAndValidateScheduledDate,
  formatChannelDate,
  DEFAULT_CHANNEL_TIMEZONE,
} from '../../channels/utils/timezone.util';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { CallbackCodec, PostCallbackAction } from '../utils/callback-data.codec';
import { ScheduleSessionData, WizardSessionData } from '../interfaces/wizard-session.interface';
import { StartHandler } from './start.handler';

@Injectable()
export class PostActionsHandler {
  constructor(
    private readonly previewService: TelegramPreviewService,
    private readonly postWorkflow: PostWorkflowService,
    private readonly postsService: PostsService,
    private readonly postsRepository: PostsRepository,
    private readonly publishingService: PublishingService,
    private readonly schedulingService: SchedulingService,
    private readonly redis: RedisService,
    private readonly templatesService: TemplatesService,
    private readonly startHandler: StartHandler,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  private scheduleSessionKey(userId: string): string {
    return `user:schedule:${userId}`;
  }

  private getPermissions(ctx: BotContext, post: PostWithRelations): UserContextPermissions {
    const isSuperAdmin = ctx.isSuperAdmin;
    const isAuthor = post.authorId === ctx.authUser?.id;
    const canApprove = ctx.canChannel(ChannelPermission.APPROVE_POST, post.channelId);
    const canPublish = ctx.canChannel(ChannelPermission.PUBLISH_POST, post.channelId);

    return {
      isSuperAdmin,
      isAuthor,
      canApprove,
      canPublish,
    };
  }

  /**
   * Submit for Review: p:sub:<postId>:<version>
   */
  async handleSubmitForReview(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
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

    if (post.version !== expectedVersion) {
      await ctx.answerCallbackQuery({
        text: '⚠️ Публикация была изменена другим пользователем. Интерфейс обновлен.',
        show_alert: true,
      });
      await this.refreshControlCard(ctx, post);
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Отправлено на согласование!' });

    const submitted = await this.postWorkflow.transition({
      postId,
      expectedVersion,
      actorId: user.id,
      action: PostAction.SUBMIT_FOR_REVIEW,
      targetStatus: PostStatus.PENDING_REVIEW,
    });

    const full = (await this.postsRepository.findById(submitted.id)) as PostWithRelations;
    await this.refreshControlCard(
      ctx,
      full,
      '✅ <b>Материал успешно отправлен на согласование редактору!</b>',
    );
  }

  /**
   * Prompt delete draft: p:del:<postId>:<version>
   */
  async handlePromptDeleteDraft(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    await ctx.answerCallbackQuery();

    const kb = PostControlsKeyboardBuilder.buildConfirmationKeyboard(
      PostCallbackAction.DELETE_DRAFT_CONFIRM,
      postId,
      expectedVersion,
    );

    if (ctx.callbackQuery?.message?.message_id && ctx.chat) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        '⚠️ <b>Удаление публикации</b>\n\n' +
          'Вы действительно хотите удалить этот черновик? Это действие необратимо.',
        {
          parse_mode: 'HTML',
          reply_markup: kb,
        },
      );
    }
  }

  /**
   * Confirm delete draft: p:del_ok:<postId>:<version>
   */
  async handleConfirmDeleteDraft(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery({ text: 'Черновик удален' });
    await this.postsService.softDeletePost(postId, expectedVersion, user.id);

    if (ctx.callbackQuery?.message?.message_id && ctx.chat) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        '🗑 <b>Черновик успешно удалён.</b>',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔙 В главное меню', 'nav:main'),
        },
      );
    }
  }

  /**
   * View post: p:view:<postId>
   */
  async handleViewPost(ctx: BotContext, postId: string): Promise<void> {
    await ctx.answerCallbackQuery();

    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post || post.deletedAt !== null) {
      await ctx.reply('❌ Публикация не найдена или была удалена.');
      return;
    }

    if (ctx.chat) {
      await this.previewService.sendPostPreview(
        ctx.api,
        ctx.chat.id,
        post,
        this.getPermissions(ctx, post),
      );
    }
  }

  /**
   * Edit post menu: p:edt:<postId>:<version>
   */
  async handleEditPostMenu(ctx: BotContext, postId: string): Promise<void> {
    await ctx.answerCallbackQuery();

    const post = await this.postsRepository.findById(postId);
    if (!post) return;

    const template = await this.templatesService.getById(post.templateId);
    const schema = template.schemaJson as unknown as TemplateSchema;

    const kb = new InlineKeyboard();
    for (const field of schema.fields) {
      kb.text(`✏️ ${field.label}`, `draft:edit:${post.id}:${field.key}`).row();
    }
    kb.text('🔙 Назад к публикации', `p:view:${post.id}`);

    await ctx.reply('<b>Выберите поле для редактирования:</b>', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  /**
   * Manage media: p:med:<postId>:<version>
   */
  async handleManageMedia(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();

    const post = await this.postsRepository.findById(postId);
    if (!post) return;

    // Set wizard session in Redis
    await this.redis.set(
      `wizard:session:${user.id}`,
      JSON.stringify({
        postId: post.id,
        channelId: post.channelId,
        templateId: post.templateId,
        step: 'MEDIA_UPLOAD',
        expectedVersion,
      } as WizardSessionData),
      86400,
    );

    const kb = new InlineKeyboard()
      .text('✅ Завершить и просмотреть', `p:view:${postId}`)
      .row()
      .text('🔙 Назад', `p:view:${postId}`);

    await ctx.reply(
      '🖼 <b>Управление медиафайлами</b>\n\n' +
        'Отправьте фото, видео, анимацию или документ для прикрепления к публикации:',
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  }

  /**
   * Publish Now: pub:now:<postId>:<expectedVersion>
   */
  async handlePublishNow(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post || post.deletedAt !== null) {
      await ctx.answerCallbackQuery({
        text: '❌ Публикация не найдена.',
        show_alert: true,
      });
      return;
    }

    if (post.version !== expectedVersion) {
      await ctx.answerCallbackQuery({
        text: '⚠️ Публикация была изменена другим пользователем.',
        show_alert: true,
      });
      await this.refreshControlCard(ctx, post);
      return;
    }

    await ctx.answerCallbackQuery({ text: '🚀 Отправлено в очередь публикации!' });

    const job = await this.publishingService.enqueuePublish(postId, user.id);

    await this.refreshControlCard(
      ctx,
      post,
      `⏳ <b>Публикация передана в очередь!</b>\n` +
        `ID задачи: <code>${job.id}</code>\n` +
        `Статус: <b>Обработка воркером...</b>`,
    );
  }

  /**
   * Schedule Prompt: pub:sch:<postId>:<expectedVersion>
   */
  async handleSchedulePrompt(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post) return;

    await ctx.answerCallbackQuery();

    const channelTimezone = post.channel?.timezone || DEFAULT_CHANNEL_TIMEZONE;
    const nowFormatted = formatChannelDate(new Date(), channelTimezone);

    // Save schedule session in Redis
    await this.redis.set(
      this.scheduleSessionKey(user.id),
      JSON.stringify({
        state: 'AWAITING_SCHEDULE_DATETIME',
        postId,
        expectedVersion,
        channelId: post.channelId,
      } as ScheduleSessionData),
      900,
    );

    const kb = PostControlsKeyboardBuilder.buildSchedulePresetsKeyboard(postId, expectedVersion);

    const text =
      `📅 <b>Планирование публикации</b>\n\n` +
      `Часовой пояс канала: <b>${channelTimezone}</b>\n` +
      `Текущее время в канале: <b>${nowFormatted}</b>\n\n` +
      `Выберите быстрый пресет ниже или введите дату и время вручную в формате:\n` +
      `<code>ДД.ММ.ГГГГ ЧЧ:ММ</code>\n\n` +
      `Например: <code>${nowFormatted}</code>`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  /**
   * Handle quick schedule preset
   */
  async handleSchedulePreset(
    ctx: BotContext,
    preset: string,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const post = (await this.postsRepository.findById(postId)) as PostWithRelations | null;
    if (!post) return;

    await ctx.answerCallbackQuery({ text: 'Планирование...' });

    const zone = post.channel?.timezone || DEFAULT_CHANNEL_TIMEZONE;
    let target = DateTime.now().setZone(zone);

    switch (preset) {
      case '1h':
        target = target.plus({ hours: 1 });
        break;
      case '3h':
        target = target.plus({ hours: 3 });
        break;
      case 't10':
        target = target.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0 });
        break;
      case 't18':
        target = target.plus({ days: 1 }).set({ hour: 18, minute: 0, second: 0 });
        break;
      default:
        target = target.plus({ hours: 1 });
    }

    const scheduledDate = target.toJSDate();

    const scheduled = await this.schedulingService.schedulePost(
      postId,
      scheduledDate,
      user.id,
      expectedVersion,
    );

    await this.redis.del(this.scheduleSessionKey(user.id));

    const full = (await this.postsRepository.findById(scheduled.id)) as PostWithRelations;
    const formatted = formatChannelDate(scheduledDate, zone);

    await ctx.reply(
      `🕒 <b>Публикация успешно запланирована!</b>\n\n` +
        `Канал: <b>${post.channel.title}</b>\n` +
        `Время: <b>${formatted} (${zone})</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(
            '❌ Отменить расписание',
            CallbackCodec.encode(
              PostCallbackAction.CANCEL_SCHEDULE_PROMPT,
              full.id,
              full.version,
            ),
          )
          .row()
          .text('🔙 В главное меню', 'nav:main'),
      },
    );
  }

  /**
   * Cancel schedule prompt: pub:sch_c:<postId>:<expectedVersion>
   */
  async handlePromptCancelSchedule(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    await ctx.answerCallbackQuery();

    const kb = PostControlsKeyboardBuilder.buildConfirmationKeyboard(
      PostCallbackAction.CANCEL_SCHEDULE_CONFIRM,
      postId,
      expectedVersion,
    );

    await ctx.reply(
      '⚠️ <b>Отмена запланированной публикации</b>\n\n' +
        'Вы действительно хотите отменить расписание публикации?',
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  }

  /**
   * Confirm cancel schedule: pub:sch_ok:<postId>:<expectedVersion>
   */
  async handleConfirmCancelSchedule(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery({ text: 'Расписание отменено' });

    const cancelled = await this.schedulingService.cancelSchedule(
      postId,
      user.id,
      expectedVersion,
    );

    const full = (await this.postsRepository.findById(cancelled.id)) as PostWithRelations;
    await this.refreshControlCard(ctx, full, '🚫 <b>Запланированная публикация отменена.</b>');
  }

  /**
   * Retry failed publish: pub:ret:<postId>:<expectedVersion>
   */
  async handleRetryPublish(
    ctx: BotContext,
    postId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.handlePublishNow(ctx, postId, expectedVersion);
  }

  /**
   * Text message received while awaiting schedule date/time
   */
  async handleTextInput(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message?.text) return false;

    const raw = await this.redis.get(this.scheduleSessionKey(user.id));
    if (!raw) return false;

    let session: ScheduleSessionData;
    try {
      session = JSON.parse(raw) as ScheduleSessionData;
    } catch {
      return false;
    }

    if (session.state !== 'AWAITING_SCHEDULE_DATETIME' || !session.postId) {
      return false;
    }

    const post = (await this.postsRepository.findById(session.postId)) as PostWithRelations | null;
    if (!post) {
      await this.redis.del(this.scheduleSessionKey(user.id));
      return false;
    }

    const zone = post.channel?.timezone || DEFAULT_CHANNEL_TIMEZONE;

    let targetDate: Date;
    try {
      targetDate = parseAndValidateScheduledDate(ctx.message.text, zone);
    } catch (err: unknown) {
      await ctx.reply(
        `⚠️ <b>Некорректная дата публикации:</b>\n` +
          `${err instanceof Error ? err.message : String(err)}\n\n` +
          `Пожалуйста, используйте формат <code>ДД.ММ.ГГГГ ЧЧ:ММ</code> (например: 22.09.2026 15:30):`,
        { parse_mode: 'HTML' },
      );
      return true;
    }

    const scheduled = await this.schedulingService.schedulePost(
      session.postId,
      targetDate,
      user.id,
      session.expectedVersion,
    );

    await this.redis.del(this.scheduleSessionKey(user.id));

    const full = (await this.postsRepository.findById(scheduled.id)) as PostWithRelations;
    const formatted = formatChannelDate(targetDate, zone);

    await ctx.reply(
      `🕒 <b>Публикация успешно запланирована!</b>\n\n` +
        `Канал: <b>${post.channel.title}</b>\n` +
        `Время: <b>${formatted} (${zone})</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(
            '❌ Отменить расписание',
            CallbackCodec.encode(
              PostCallbackAction.CANCEL_SCHEDULE_PROMPT,
              full.id,
              full.version,
            ),
          )
          .row()
          .text('🔙 В главное меню', 'nav:main'),
      },
    );

    return true;
  }

  /**
   * Navigate back to main menu
   */
  async handleNavMain(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    await this.startHandler.handle(ctx);
  }

  private async refreshControlCard(
    ctx: BotContext,
    post: PostWithRelations,
    notice?: string,
  ): Promise<void> {
    if (ctx.callbackQuery?.message?.message_id && ctx.chat) {
      await this.previewService.updateControlCard(
        ctx.api,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        post,
        this.getPermissions(ctx, post),
        notice,
      );
    } else if (ctx.chat) {
      await this.previewService.sendPostPreview(
        ctx.api,
        ctx.chat.id,
        post,
        this.getPermissions(ctx, post),
      );
    }
  }
}
