/**
 * Media Extractor Utility
 * Extracts AttachMediaDto from grammY Context Message.
 * Enforces Zero-Download principle (reusing Telegram file_id directly).
 * Authoritative reference: AGENTS.md § 19; tasks.md § 18; PROJECT.md F-21, F-22
 */

import { Message } from 'grammy/types';
import { MediaType } from '@prisma/client';
import { AttachMediaDto } from '../../media/dto/attach-media.dto';
import { entitiesToHtml } from './entity-converter.util';

export interface ExtractedMediaResult {
  dto: AttachMediaDto;
  mediaGroupId?: string;
}

export function extractMediaFromMessage(message: Message): ExtractedMediaResult | null {
  const caption = message.caption
    ? entitiesToHtml(message.caption, message.caption_entities)
    : null;

  const mediaGroupId = message.media_group_id;

  // 1. Photo
  if (message.photo && message.photo.length > 0) {
    const largestPhoto = message.photo[message.photo.length - 1]!;
    return {
      dto: {
        telegramFileId: largestPhoto.file_id,
        telegramFileUniqueId: largestPhoto.file_unique_id,
        mediaType: MediaType.PHOTO,
        fileSize: largestPhoto.file_size ?? null,
        caption,
      },
      mediaGroupId,
    };
  }

  // 2. Video
  if (message.video) {
    const v = message.video;
    return {
      dto: {
        telegramFileId: v.file_id,
        telegramFileUniqueId: v.file_unique_id,
        mediaType: MediaType.VIDEO,
        fileName: v.file_name ?? null,
        mimeType: v.mime_type ?? 'video/mp4',
        fileSize: v.file_size ?? null,
        caption,
      },
      mediaGroupId,
    };
  }

  // 3. Animation (GIF)
  if (message.animation) {
    const a = message.animation;
    return {
      dto: {
        telegramFileId: a.file_id,
        telegramFileUniqueId: a.file_unique_id,
        mediaType: MediaType.ANIMATION,
        fileName: a.file_name ?? null,
        mimeType: a.mime_type ?? 'video/mp4',
        fileSize: a.file_size ?? null,
        caption,
      },
      mediaGroupId,
    };
  }

  // 4. Document
  if (message.document) {
    const d = message.document;
    return {
      dto: {
        telegramFileId: d.file_id,
        telegramFileUniqueId: d.file_unique_id,
        mediaType: MediaType.DOCUMENT,
        fileName: d.file_name ?? null,
        mimeType: d.mime_type ?? null,
        fileSize: d.file_size ?? null,
        caption,
      },
      mediaGroupId,
    };
  }

  return null;
}
