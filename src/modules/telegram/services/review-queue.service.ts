/**
 * Review Queue Application Service
 * Manages review queue queries, pagination, and review card formatting for Editors & Admins.
 * Authoritative reference: tasks.md § 8, § 13; AGENTS.md § 64
 */

import { Injectable } from '@nestjs/common';
import { Post, PostStatus, ChannelRole } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { PostsRepository } from '../../posts/posts.repository';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { SystemRole } from '../../../common/enums';
import { PostWithRelations } from './telegram-preview.service';
import { formatChannelDate } from '../../channels/utils/timezone.util';
import { formatStatusBadge } from '../utils/status-formatter.util';

export interface ReviewQueueResult {
  hasItems: boolean;
  totalCount: number;
  currentIndex: number;
  post?: PostWithRelations;
  cardHtml: string;
}

@Injectable()
export class ReviewQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRepository: PostsRepository,
  ) {}

  /**
   * Retrieves all posts awaiting review across channels where user is editor with canApprove or super admin.
   */
  async getPendingPostsForUser(user: AuthUser): Promise<PostWithRelations[]> {
    const isSuperAdmin = user.systemRole === SystemRole.SUPER_ADMIN;

    let channelIds: string[] = [];

    if (isSuperAdmin) {
      const allChannels = await this.prisma.channel.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      channelIds = allChannels.map((c) => c.id);
    } else {
      channelIds = user.channelMemberships
        .filter((m) => m.role === ChannelRole.EDITOR && m.canApprove)
        .map((m) => m.channelId);
    }

    if (channelIds.length === 0) {
      return [];
    }

    const posts = await this.prisma.post.findMany({
      where: {
        channelId: { in: channelIds },
        status: PostStatus.PENDING_REVIEW,
        deletedAt: null,
      },
      include: {
        template: true,
        media: { orderBy: { sortOrder: 'asc' } },
        author: true,
        channel: true,
        reviews: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return posts as PostWithRelations[];
  }

  /**
   * Builds the card HTML for the review queue.
   */
  formatReviewCard(post: PostWithRelations, currentIndex: number, totalCount: number): string {
    const authorName =
      [post.author.firstName, post.author.lastName].filter(Boolean).join(' ') ||
      post.author.username ||
      `ID ${post.author.telegramId.toString()}`;

    const createdAtStr = formatChannelDate(post.createdAt, post.channel.timezone);

    let html =
      `📋 <b>Карточка согласования</b> [${currentIndex + 1} из ${totalCount}]\n` +
      `───────────────────────────────\n` +
      `📢 <b>Канал:</b> ${post.channel.title}\n` +
      `👤 <b>Автор:</b> ${authorName}\n` +
      `📝 <b>Шаблон:</b> ${post.template.name}\n` +
      `🕒 <b>Поступил:</b> ${createdAtStr}\n` +
      `📌 <b>Статус:</b> ${formatStatusBadge(post.status, post.version)}\n`;

    const metadata = post.metadataJson as Record<string, unknown> | null;
    if (metadata?.commentToEditor) {
      html += `💬 <b>Комментарий автора:</b> <i>${String(metadata.commentToEditor)}</i>\n`;
    }

    html += `───────────────────────────────`;
    return html;
  }

  /**
   * Retrieves a post by ID for review inspection.
   */
  async getPost(postId: string): Promise<Post | null> {
    return this.postsRepository.findById(postId);
  }
}
