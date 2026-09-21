/**
 * Help Handler
 * Handles /help command and '❓ Помощь' menu item.
 * Authoritative reference: tasks.md § 8
 */

import { Injectable } from '@nestjs/common';
import { BotContext } from '../interfaces/bot-context.interface';
import { ChannelRole } from '../../../common/enums';

@Injectable()
export class HelpHandler {
  async handle(ctx: BotContext): Promise<void> {
    const user = ctx.authUser;
    if (!user) return;

    const isEditorOrAdmin =
      ctx.isSuperAdmin ||
      user.channelMemberships.some((m) => m.role === ChannelRole.EDITOR);

    let text =
      `📖 <b>Справка по редакционной системе</b>\n\n` +
      `Этот бот является редакционной панелью для подготовки и публикации материалов в Telegram-каналы.\n\n` +
      `<b>Основные возможности:</b>\n` +
      `• <b>➕ Создать пост:</b> Пошаговый мастер создания публикации с автосохранением каждого шага в базе данных.\n` +
      `• <b>📝 Мои материалы:</b> Список ваших черновиков. Вы можете продолжить заполнение или удалить черновик.\n` +
      `• <b>Предпросмотр:</b> Точное отображение того, как публикация будет выглядеть в канале.\n` +
      `• <b>Согласование:</b> Отправка готового черновика редактору.\n`;

    if (isEditorOrAdmin) {
      text +=
        `\n<b>Функции редактора:</b>\n` +
        `• <b>✅ На согласовании:</b> Очередь публикаций, ожидающих проверки. Вы можете одобрить пост, вернуть его на доработку с обязательным комментарием или отклонить.\n` +
        `• <b>🚀 Публикация:</b> Немедленная публикация одобренных постов через надежную очередь.\n` +
        `• <b>🕒 Планирование:</b> Установка точного времени публикации в часовом поясе канала.\n`;
    }

    text += `\n<i>По всем вопросам и для расширения прав обращайтесь к главному администратору.</i>`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}
