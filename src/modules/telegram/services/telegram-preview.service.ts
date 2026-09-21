/**
 * Telegram Preview Service
 * Canonical preview rendering and companion control card management.
 * Authoritative reference: AGENTS.md § 15, § 16; tasks.md § 9, § 13; PROJECT.md F-13, F-18
 */

import { Injectable, Inject } from '@nestjs/common';
import { Api } from 'grammy';
import { Post, PostTemplate, PostMedia, User, Channel, PostReview } from '@prisma/client';
import { TelegramRenderer } from '../../rendering/telegram-renderer.service';
import {
  ITelegramPublisher,
  TELEGRAM_PUBLISHER,
} from '../../../infrastructure/telegram-api/interfaces/telegram-publisher.interface';
import {
  PostControlsKeyboardBuilder,
  UserContextPermissions,
} from '../keyboards/post-controls.keyboard';
import { formatStatusBadge } from '../utils/status-formatter.util';
import { formatChannelDate } from '../../channels/utils/timezone.util';

export type PostWithRelations = Post & {
  template: PostTemplate;
  media: PostMedia[];
  author: User;
  channel: Channel;
  reviews?: (PostReview & { reviewer?: Partial<User> | null })[];
};

@Injectable()
export class TelegramPreviewService {
  constructor(
    private readonly renderer: TelegramRenderer,
    @Inject(TELEGRAM_PUBLISHER)
    private readonly publisher: ITelegramPublisher,
  ) {}

  /**
   * Renders the canonical post preview and sends companion Control Card.
   */
  async sendPostPreview(
    api: Api,
    chatId: number | string,
    post: PostWithRelations,
    perms: UserContextPermissions,
  ): Promise<number> {
    // 1. Render Canonical Preview via TelegramRenderer (AGENTS.md § 15)
    const payload = await this.renderer.render(post, post.template, post.media);

    // 2. Transmit each outgoing preview message
    for (const msg of payload.messages) {
      await this.publisher.publishOutgoingMessage(chatId.toString(), msg);
    }

    // 3. Construct and Transmit the Companion Control Card
    const cardHtml = this.formatControlCardHtml(post);
    const keyboard = PostControlsKeyboardBuilder.buildAuthorControls(post, perms);

    const controlMessageId = await this.publisher.sendMessage(chatId.toString(), cardHtml, {
      parseMode: 'HTML',
    });

    // Attach inline keyboard to the control message
    await api.editMessageReplyMarkup(chatId, controlMessageId, {
      reply_markup: keyboard,
    });

    return controlMessageId;
  }

  /**
   * Updates an existing Control Card in-place (e.g. on status change or OCC conflict).
   */
  async updateControlCard(
    api: Api,
    chatId: number | string,
    messageId: number,
    post: PostWithRelations,
    perms: UserContextPermissions,
    overrideNotice?: string,
  ): Promise<void> {
    const cardHtml = this.formatControlCardHtml(post, overrideNotice);
    const keyboard = PostControlsKeyboardBuilder.buildAuthorControls(post, perms);

    await api.editMessageText(chatId, messageId, cardHtml, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  public formatControlCardHtml(post: PostWithRelations, notice?: string): string {
    const authorName =
      [post.author.firstName, post.author.lastName].filter(Boolean).join(' ') ||
      post.author.username ||
      `ID ${post.author.telegramId.toString()}`;

    const updatedAtStr = formatChannelDate(post.updatedAt, post.channel.timezone);

    let html =
      `📋 <b>Панель управления публикацией</b>\n` +
      `──────────────────────────\n` +
      `📌 <b>Статус:</b> ${formatStatusBadge(post.status, post.version)}\n` +
      `📢 <b>Канал:</b> ${post.channel.title}\n` +
      `📝 <b>Шаблон:</b> ${post.template.name}\n` +
      `👤 <b>Автор:</b> ${authorName}\n` +
      `🕒 <b>Обновлено:</b> ${updatedAtStr}\n`;

    if (post.scheduledAt) {
      const scheduledStr = formatChannelDate(post.scheduledAt, post.channel.timezone);
      html += `⏰ <b>Запланировано на:</b> ${scheduledStr}\n`;
    }

    // If recent revision comment exists, highlight it
    const latestReview = post.reviews?.[0];
    if (latestReview?.comment && latestReview.action === 'REQUEST_REVISION') {
      html +=
        `──────────────────────────\n` +
        `⚠️ <b>Замечания редактора:</b>\n` +
        `«<i>${latestReview.comment}</i>»\n`;
    }

    if (notice) {
      html += `──────────────────────────\n${notice}\n`;
    }

    html += `──────────────────────────`;
    return html;
  }
}
