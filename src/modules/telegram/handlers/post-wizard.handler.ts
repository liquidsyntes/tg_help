/**
 * Post Wizard Transport Handler
 * Handles Telegram commands, callback queries, and messages during post creation.
 * Authoritative reference: AGENTS.md § 3, § 5, § 11, § 12; tasks.md § 9, § 10
 */

import { Injectable, Optional } from '@nestjs/common';
import { BotContext } from '../interfaces/bot-context.interface';
import { PostWizardService } from '../services/post-wizard.service';
import { TelegramPreviewService } from '../services/telegram-preview.service';
import { WizardKeyboardBuilder } from '../keyboards/wizard.keyboard';
import { extractMediaFromMessage } from '../utils/media-extractor.util';
import { ChannelPermission } from '../../../common/enums';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';

@Injectable()
export class PostWizardHandler {
  constructor(
    private readonly wizardService: PostWizardService,
    private readonly previewService: TelegramPreviewService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  /**
   * Starts post creation wizard (/newpost or '➕ Создать пост')
   */
  async handleStartWizard(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const res = await this.wizardService.startWizard(user.id);

    if (res.type === 'CHANNEL_SELECT' && res.channels) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildChannelSelection(res.channels),
      });
      return;
    }

    if (res.type === 'TEMPLATE_SELECT' && res.templates) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildTemplateSelection(res.templates),
      });
      return;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });
  }

  /**
   * Channel selection callback: wiz:chan:<channelId>
   */
  async handleChannelSelect(ctx: BotContext, channelId: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.wizardService.selectChannel(user.id, channelId);

    if (res.type === 'TEMPLATE_SELECT' && res.templates) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildTemplateSelection(res.templates),
      });
    } else {
      await ctx.reply(res.text, { parse_mode: 'HTML' });
    }
  }

  /**
   * Template selection callback: wiz:tpl:<templateId>
   */
  async handleTemplateSelect(ctx: BotContext, templateId: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.wizardService.selectTemplate(user.id, templateId);

    if (res.type === 'FIELD_PROMPT' && res.field) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildFieldInputControls(res.field),
      });
      return;
    }

    if (res.type === 'MEDIA_PROMPT') {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildMediaUploadControls(),
      });
      return;
    }

    if (res.type === 'COMPLETED' && res.post && ctx.chat) {
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, res.post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, res.post.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, res.post.channelId),
        isAuthor: true,
      });
      return;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });
  }

  /**
   * Field skip callback: wiz:skip:<fieldKey>
   */
  async handleSkipField(ctx: BotContext, fieldKey: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.wizardService.skipField(user.id, fieldKey);

    if (res.type === 'FIELD_PROMPT' && res.field) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildFieldInputControls(res.field),
      });
      return;
    }

    if (res.type === 'MEDIA_PROMPT') {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildMediaUploadControls(),
      });
      return;
    }

    if (res.type === 'COMPLETED' && res.post && ctx.chat) {
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, res.post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, res.post.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, res.post.channelId),
        isAuthor: true,
      });
      return;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });
  }

  /**
   * Finish media upload callback: wiz:done_media
   */
  async handleFinishMedia(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.wizardService.finishMedia(user.id);

    if (res.type === 'COMPLETED' && res.post && ctx.chat) {
      await ctx.reply('✅ Черновик публикации успешно сохранён!', { parse_mode: 'HTML' });
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, res.post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, res.post.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, res.post.channelId),
        isAuthor: true,
      });
      return;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });
  }

  /**
   * Cancel wizard callback: wiz:cancel
   */
  async handleCancelWizard(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    await this.wizardService.cancelWizard(user.id);
    await ctx.reply(
      '💾 Черновик сохранён в разделе «Мои материалы». Вы можете продолжить заполнение в любое время.',
      { parse_mode: 'HTML' },
    );
  }

  /**
   * Text message input during wizard
   */
  async handleTextInput(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message?.text) return false;

    const session = await this.wizardService.getSession(user.id);
    if (!session || session.step !== 'FIELD_INPUT') {
      return false; // Not handled by wizard
    }

    const res = await this.wizardService.processFieldInput(
      user.id,
      ctx.message.text,
      ctx.message.entities,
    );

    if (res.type === 'FIELD_PROMPT' && res.field) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildFieldInputControls(res.field),
      });
      return true;
    }

    if (res.type === 'MEDIA_PROMPT') {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildMediaUploadControls(),
      });
      return true;
    }

    if (res.type === 'COMPLETED' && res.post && ctx.chat) {
      await ctx.reply('✅ Все обязательные поля заполнены!', { parse_mode: 'HTML' });
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, res.post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, res.post.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, res.post.channelId),
        isAuthor: true,
      });
      return true;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });
    return true;
  }

  /**
   * Media message upload during wizard
   */
  async handleMediaUpload(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message) return false;

    const session = await this.wizardService.getSession(user.id);
    if (!session || (session.step !== 'MEDIA_UPLOAD' && session.step !== 'FIELD_INPUT')) {
      return false;
    }

    const extracted = extractMediaFromMessage(ctx.message);
    if (!extracted) return false;

    const res = await this.wizardService.processMediaUpload(
      user.id,
      extracted.dto,
      extracted.mediaGroupId,
      async (count: number) => {
        if (ctx.chat) {
          await ctx.api.sendMessage(
            ctx.chat.id,
            `✅ Загружена медиагруппа: добавлено <b>${count}</b> файлов.`,
            {
              parse_mode: 'HTML',
              reply_markup: WizardKeyboardBuilder.buildMediaUploadControls(),
            },
          );
        }
      },
    );

    if (!res.isBatch) {
      await ctx.reply(res.message, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildMediaUploadControls(),
      });
    }

    return true;
  }
}
