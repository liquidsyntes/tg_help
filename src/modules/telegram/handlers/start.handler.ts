/**
 * Start Handler
 * Handles /start command and renders role-tailored persistent reply menu.
 * Authoritative reference: tasks.md § 7, § 8; AGENTS.md § 8
 */

import { Injectable } from '@nestjs/common';
import { BotContext } from '../interfaces/bot-context.interface';
import { buildMainMenuKeyboard } from '../keyboards/main-menu.keyboard';
import { SystemRole, ChannelRole } from '../../../common/enums';

@Injectable()
export class StartHandler {
  async handle(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return; // Guarded by TelegramAuthMiddleware

    const isEditorOrAdmin =
      ctx.isSuperAdmin ||
      user.channelMemberships.some((m) => m.role === ChannelRole.EDITOR);

    const keyboard = buildMainMenuKeyboard(user);

    const roleTitle = ctx.isSuperAdmin
      ? 'Главный администратор'
      : isEditorOrAdmin
        ? 'Редактор'
        : 'Автор';

    const welcome =
      `👋 Добро пожаловать в редакционную панель, <b>${user.firstName || user.username || 'Коллега'}</b>!\n\n` +
      `Ваша роль: <b>${roleTitle}</b>\n` +
      `Доступных каналов: <b>${user.channelMemberships.length}</b>\n\n` +
      `Выберите необходимое действие в меню ниже:`;

    await ctx.reply(welcome, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}
