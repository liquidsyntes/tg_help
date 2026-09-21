/**
 * Status Formatter Utility
 * Maps Prisma PostStatus to friendly Russian localized strings with emoji.
 * Authoritative reference: tasks.md § 6, § 13; AGENTS.md § 46
 */

import { PostStatus } from '@prisma/client';

export interface StatusMetadata {
  label: string;
  emoji: string;
  description: string;
}

export const POST_STATUS_METADATA: Record<PostStatus, StatusMetadata> = {
  [PostStatus.DRAFT]: {
    label: 'Черновик',
    emoji: '📝',
    description: 'Материал редактируется автором.',
  },
  [PostStatus.PENDING_REVIEW]: {
    label: 'На согласовании',
    emoji: '⏳',
    description: 'Ожидает проверки редактором.',
  },
  [PostStatus.APPROVED]: {
    label: 'Одобрено',
    emoji: '✅',
    description: 'Материал проверен и готов к публикации.',
  },
  [PostStatus.NEEDS_REVISION]: {
    label: 'Требуется доработка',
    emoji: '↩️',
    description: 'Редактор вернул публикацию с замечаниями.',
  },
  [PostStatus.REJECTED]: {
    label: 'Отклонено',
    emoji: '❌',
    description: 'Публикация отклонена редактором.',
  },
  [PostStatus.SCHEDULED]: {
    label: 'Запланировано',
    emoji: '🕒',
    description: 'Публикация ожидает наступления указанного времени.',
  },
  [PostStatus.PUBLISHING]: {
    label: 'Публикуется',
    emoji: '🚀',
    description: 'Идет отправка сообщения в канал...',
  },
  [PostStatus.PUBLISHED]: {
    label: 'Опубликовано',
    emoji: '🎉',
    description: 'Пост успешно опубликован в канале.',
  },
  [PostStatus.PUBLISH_FAILED]: {
    label: 'Ошибка публикации',
    emoji: '🚨',
    description: 'Не удалось опубликовать пост. Требуется повтор.',
  },
  [PostStatus.CANCELLED]: {
    label: 'Отменено',
    emoji: '🚫',
    description: 'Публикация отменена.',
  },
};

export function formatStatusBadge(status: PostStatus, version: number): string {
  const meta = POST_STATUS_METADATA[status] || {
    label: status,
    emoji: '📌',
    description: '',
  };
  return `${meta.emoji} ${meta.label} (v${version})`;
}
