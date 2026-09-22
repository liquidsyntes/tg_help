/**
 * Draft Manager Transport Handler
 * Handles /drafts, "Мои материалы", draft resumption, and granular editing.
 * Authoritative reference: tasks.md § 9, § 10, § 11; AGENTS.md § 11, § 12, § 31, § 54
 */

import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { BotContext } from '../interfaces/bot-context.interface';
import { DraftManagerService } from '../services/draft-manager.service';
import { TelegramPreviewService } from '../services/telegram-preview.service';
import { WizardKeyboardBuilder } from '../keyboards/wizard.keyboard';
import { ChannelPermission } from '../../../common/enums';
import { formatChannelDate } from '../../channels/utils/timezone.util';
import { formatStatusBadge } from '../utils/status-formatter.util';

@Injectable()
export class DraftManagerHandler {
  constructor(
    private readonly draftManagerService: DraftManagerService,
    private readonly previewService: TelegramPreviewService,
  ) {}

  /**
   * Lists drafts: /drafts or '📝 Мои материалы' / '📝 Материалы'
   */
  async handleListDrafts(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const drafts = await this.draftManagerService.listDrafts(user.id);

    if (drafts.length === 0) {
      await ctx.reply('📝 У вас нет активных или сохранённых черновиков.', {
        parse_mode: 'HTML',
      });
      return;
    }

    let text = `📝 <b>Ваши черновики и материалы (${drafts.length}):</b>\n\n`;

    const kb = new InlineKeyboard();

    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      const content = (d.contentJson as Record<string, unknown>) || {};
      const title = String(content.title || 'Без названия').slice(0, 40);
      const dateStr = formatChannelDate(d.updatedAt, d.channel.timezone);

      text +=
        `<b>${i + 1}. ${d.template.name}:</b> «${title}»\n` +
        `   Канал: ${d.channel.title} • ${formatStatusBadge(d.status, d.version)}\n` +
        `   Изменен: ${dateStr}\n\n`;

      kb.text(`✏️ ${i + 1}. Открыть`, `draft:res:${d.id}`);
      kb.text(`🗑 Удалить`, `draft:del:${d.id}:${d.version}`).row();
    }

    kb.text('🔙 В главное меню', 'nav:main');

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  /**
   * Resumes draft: draft:res:<postId>
   */
  async handleResumeDraft(ctx: BotContext, postId: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.draftManagerService.resumeDraft(user.id, postId);

    if (res.action === 'FIELD_PROMPT' && res.field) {
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: WizardKeyboardBuilder.buildFieldInputControls(res.field),
      });
      return;
    }

    if (res.action === 'CONTROL_CARD' && res.post && ctx.chat) {
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
   * Prompt delete draft: draft:del:<postId>[:<version>]
   */
  async handlePromptDeleteDraft(
    ctx: BotContext,
    postId: string,
    versionStr?: string,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();

    let version = versionStr ? parseInt(versionStr, 10) : NaN;
    if (isNaN(version)) {
      const post = await this.draftManagerService.getDraft(postId);
      version = post?.version ?? 1;
    }

    const kb = new InlineKeyboard()
      .text('🗑 Да, удалить', `draft:cdel:${postId}:${version}`)
      .text('🔙 Отмена', `draft:res:${postId}`);

    await ctx.reply(
      '⚠️ <b>Удаление черновика</b>\n\n' +
        'Вы уверены, что хотите удалить этот черновик? Это действие необратимо.',
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  }

  /**
   * Confirm delete draft: draft:cdel:<postId>:<version>
   */
  async handleConfirmDeleteDraft(
    ctx: BotContext,
    postId: string,
    versionStr: string,
  ): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const version = parseInt(versionStr, 10) || 1;
    await ctx.answerCallbackQuery({ text: 'Черновик удален' });

    await this.draftManagerService.deleteDraft(user.id, postId, version);

    await ctx.reply('🗑 Черновик публикации успешно удален.', {
      parse_mode: 'HTML',
    });
  }

  /**
   * Field edit prompt: draft:edit:<postId>:<fieldKey>
   */
  async handleEditFieldPrompt(ctx: BotContext, postId: string, fieldKey: string): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    await ctx.answerCallbackQuery();
    const res = await this.draftManagerService.startEditField(user.id, postId, fieldKey);

    await ctx.reply(res.text, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔙 Отмена', `draft:res:${postId}`),
    });
  }

  /**
   * Text input when user is in EDIT_FIELD mode
   */
  async handleTextInput(ctx: BotContext): Promise<boolean> {
    const user = ctx.authUser;
    if (!user || !ctx.message?.text) return false;

    const res = await this.draftManagerService.submitEditedField(
      user.id,
      ctx.message.text,
      ctx.message.entities,
    );

    if (!res.success && res.text.includes('Сессия редактирования истекла')) {
      return false; // Not in edit field mode
    }

    if (!res.success) {
      await ctx.reply(res.text, { parse_mode: 'HTML' });
      return true;
    }

    await ctx.reply(res.text, { parse_mode: 'HTML' });

    if (res.post && ctx.chat) {
      await this.previewService.sendPostPreview(ctx.api, ctx.chat.id, res.post, {
        isSuperAdmin: ctx.isSuperAdmin,
        canApprove: ctx.canChannel(ChannelPermission.APPROVE_POST, res.post.channelId),
        canPublish: ctx.canChannel(ChannelPermission.PUBLISH_POST, res.post.channelId),
        isAuthor: true,
      });
    }

    return true;
  }
}
