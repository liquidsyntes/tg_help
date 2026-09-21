import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { Post, PostMedia, PostTemplate, MediaType, PostStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostsRepository } from '../posts/posts.repository';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../auth/permission.service';
import { AttachMediaDto, ReorderMediaItemDto } from './dto';
import { EnrichedPostMedia, MediaValidationResult } from './interfaces';
import {
  isDocumentAsVideo,
  validateMediaGroupCompatibility,
} from './utils/media-detector.util';
import { TELEGRAM_LIMITS } from '../../common/constants/telegram-limits';
import { AuditAction } from '../../common/enums';
import {
  PostNotFoundException,
  MediaNotFoundException,
  ValidationException,
} from '../../common/exceptions/domain.exceptions';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => PostsRepository))
    private readonly postsRepository: PostsRepository,
    private readonly auditService: AuditService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Attaches a single media item to a post with zero-download Telegram file_id persistence.
   * Atomically increments post version via OCC and logs audit record.
   * Rule F-40: Emits ZERO notifications.
   */
  async attachMedia(
    postId: string,
    expectedVersion: number,
    actorId: string,
    media: AttachMediaDto,
  ): Promise<Post> {
    const post = await this.getAndValidateEditablePost(postId, actorId);

    const existingCount = await this.prisma.postMedia.count({
      where: { postId },
    });
    if (existingCount >= TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
      throw new ValidationException(
        `Максимальное количество медиафайлов для одной публикации — ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE}.`,
      );
    }

    let nextSortOrder = media.sortOrder;
    if (nextSortOrder === undefined || nextSortOrder === null) {
      const highest = await this.prisma.postMedia.findFirst({
        where: { postId },
        orderBy: { sortOrder: 'desc' },
      });
      nextSortOrder = (highest?.sortOrder ?? 0) + 1;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.postMedia.create({
        data: {
          postId,
          telegramFileId: media.telegramFileId,
          telegramFileUniqueId: media.telegramFileUniqueId,
          mediaType: media.mediaType,
          fileName: media.fileName ?? null,
          mimeType: media.mimeType ?? null,
          fileSize: media.fileSize ? BigInt(media.fileSize) : null,
          caption: media.caption ?? null,
          sortOrder: nextSortOrder,
        },
      });

      const updatedPost = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        {},
        tx,
      );

      await this.auditService.record(
        {
          action: AuditAction.MEDIA_ADDED,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            telegramFileUniqueId: media.telegramFileUniqueId,
            mediaType: media.mediaType,
            version: updatedPost.version,
          },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Attaches a batch of media items (e.g. from an incoming Telegram media group).
   * Executes in a single transaction with one OCC version increment.
   */
  async attachMediaBatch(
    postId: string,
    expectedVersion: number,
    actorId: string,
    dtos: AttachMediaDto[],
  ): Promise<Post> {
    if (dtos.length === 0) {
      const post = await this.postsRepository.findById(postId);
      if (!post) throw new PostNotFoundException(postId);
      return post;
    }

    await this.getAndValidateEditablePost(postId, actorId);

    const existingCount = await this.prisma.postMedia.count({
      where: { postId },
    });
    if (existingCount + dtos.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
      throw new ValidationException(
        `Нельзя прикрепить ${dtos.length} медиа. Максимальный лимит медиагруппы — ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE} (уже загружено: ${existingCount}).`,
      );
    }

    const highest = await this.prisma.postMedia.findFirst({
      where: { postId },
      orderBy: { sortOrder: 'desc' },
    });
    let currentSortOrder = highest?.sortOrder ?? 0;

    return this.prisma.$transaction(async (tx) => {
      for (const media of dtos) {
        currentSortOrder += 1;
        await tx.postMedia.create({
          data: {
            postId,
            telegramFileId: media.telegramFileId,
            telegramFileUniqueId: media.telegramFileUniqueId,
            mediaType: media.mediaType,
            fileName: media.fileName ?? null,
            mimeType: media.mimeType ?? null,
            fileSize: media.fileSize ? BigInt(media.fileSize) : null,
            caption: media.caption ?? null,
            sortOrder: media.sortOrder ?? currentSortOrder,
          },
        });
      }

      const updatedPost = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        {},
        tx,
      );

      await this.auditService.record(
        {
          action: AuditAction.MEDIA_ADDED,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            count: dtos.length,
            version: updatedPost.version,
          },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Removes a media item and renormalizes remaining sortOrders (gapless 1..N).
   */
  async removeMedia(
    postId: string,
    mediaId: string,
    expectedVersion: number,
    actorId: string,
  ): Promise<Post> {
    await this.getAndValidateEditablePost(postId, actorId);

    const mediaItem = await this.prisma.postMedia.findUnique({
      where: { id: mediaId },
    });
    if (!mediaItem || mediaItem.postId !== postId) {
      throw new MediaNotFoundException(mediaId);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.postMedia.delete({
        where: { id: mediaId },
      });

      // Renormalize remaining items so sortOrders are 1..N without gaps
      const remaining = await tx.postMedia.findMany({
        where: { postId },
        orderBy: { sortOrder: 'asc' },
      });

      for (let i = 0; i < remaining.length; i++) {
        const item = remaining[i]!;
        const expectedOrder = i + 1;
        if (item.sortOrder !== expectedOrder) {
          await tx.postMedia.update({
            where: { id: item.id },
            data: { sortOrder: expectedOrder },
          });
        }
      }

      const updatedPost = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        {},
        tx,
      );

      await this.auditService.record(
        {
          action: AuditAction.MEDIA_REMOVED,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            mediaId,
            telegramFileUniqueId: mediaItem.telegramFileUniqueId,
            version: updatedPost.version,
          },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Reorders media attachments for a post.
   */
  async reorderMedia(
    postId: string,
    orders: ReorderMediaItemDto[],
    expectedVersion: number,
    actorId: string,
  ): Promise<Post> {
    await this.getAndValidateEditablePost(postId, actorId);

    const mediaList = await this.prisma.postMedia.findMany({
      where: { postId },
    });
    const mediaMap = new Map(mediaList.map((m) => [m.id, m]));

    for (const order of orders) {
      if (!mediaMap.has(order.mediaId)) {
        throw new MediaNotFoundException(order.mediaId);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      for (const order of orders) {
        await tx.postMedia.update({
          where: { id: order.mediaId },
          data: { sortOrder: order.sortOrder },
        });
      }

      const updatedPost = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        {},
        tx,
      );

      await this.auditService.record(
        {
          action: AuditAction.POST_UPDATED,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            operation: 'reorder_media',
            version: updatedPost.version,
          },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Clears all media attachments for a post.
   */
  async clearMedia(
    postId: string,
    expectedVersion: number,
    actorId: string,
  ): Promise<Post> {
    await this.getAndValidateEditablePost(postId, actorId);

    return this.prisma.$transaction(async (tx) => {
      await tx.postMedia.deleteMany({
        where: { postId },
      });

      const updatedPost = await this.postsRepository.updateWithOcc(
        postId,
        expectedVersion,
        {},
        tx,
      );

      await this.auditService.record(
        {
          action: AuditAction.POST_UPDATED,
          entityType: 'post',
          entityId: postId,
          actorId,
          payload: {
            operation: 'clear_media',
            version: updatedPost.version,
          },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Retrieves enriched media items for a post, with document-as-video and transport method detection.
   */
  async getMediaForPost(postId: string): Promise<EnrichedPostMedia[]> {
    const media = await this.prisma.postMedia.findMany({
      where: { postId },
      orderBy: { sortOrder: 'asc' },
    });

    return media.map((m) => {
      const isVideoDoc = isDocumentAsVideo(m);
      const isImageDoc =
        m.mediaType === MediaType.DOCUMENT &&
        (m.mimeType?.startsWith('image/') ?? false);

      let transportMethod: 'sendPhoto' | 'sendVideo' | 'sendDocument' | 'sendAnimation';
      if (m.mediaType === MediaType.PHOTO) {
        transportMethod = 'sendPhoto';
      } else if (m.mediaType === MediaType.VIDEO) {
        transportMethod = 'sendVideo';
      } else if (m.mediaType === MediaType.ANIMATION) {
        transportMethod = 'sendAnimation';
      } else {
        transportMethod = 'sendDocument';
      }

      return {
        ...m,
        isVideoDocument: isVideoDoc,
        isImageDocument: isImageDoc,
        transportMethod,
      };
    });
  }

  /**
   * Validates attached media against template media rules and Telegram media group constraints.
   */
  async validateMediaForPost(
    postId: string,
    template: PostTemplate,
  ): Promise<MediaValidationResult> {
    const media = await this.getMediaForPost(postId);
    const errors: string[] = [];

    const supported = template.supportedMediaTypes || [];
    const supportsPhotos = supported.includes('photo');
    const supportsVideos = supported.includes('video');
    const supportsDocs = supported.includes('document');
    const supportsAnimations = supported.includes('animation');
    const supportsMediaGroup = supported.includes('media_group');

    // 1. Check template mandatory media requirements
    if (template.key === 'photo' && media.length === 0) {
      errors.push('Для шаблона «Фото» необходимо прикрепить хотя бы одну фотографию.');
    } else if (template.key === 'video' && media.length === 0) {
      errors.push('Для шаблона «Видео» необходимо прикрепить видеоролик.');
    }

    // 2. Check each item against supported media types
    for (const item of media) {
      if (item.mediaType === MediaType.PHOTO && !supportsPhotos) {
        errors.push(`Шаблон «${template.name}» не поддерживает фотографии.`);
      } else if (
        item.mediaType === MediaType.VIDEO &&
        !supportsVideos
      ) {
        errors.push(`Шаблон «${template.name}» не поддерживает видео.`);
      } else if (item.mediaType === MediaType.DOCUMENT) {
        // Document-as-video handling: if it is a video document and template supports video, allow it!
        if (item.isVideoDocument && supportsVideos) {
          // Allowed as video!
        } else if (!supportsDocs) {
          errors.push(`Шаблон «${template.name}» не поддерживает документы (файлы).`);
        }
      } else if (item.mediaType === MediaType.ANIMATION && !supportsAnimations) {
        errors.push(`Шаблон «${template.name}» не поддерживает GIF-анимации.`);
      }
    }

    // 3. Check media group rules if multiple items attached
    if (media.length > 1) {
      if (!supportsMediaGroup) {
        errors.push(
          `Шаблон «${template.name}» поддерживает только одно медиа (медиагруппы не разрешены).`,
        );
      }

      const groupCheck = validateMediaGroupCompatibility(media);
      if (!groupCheck.isValid && groupCheck.error) {
        errors.push(groupCheck.error);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  private async getAndValidateEditablePost(
    postId: string,
    actorId: string,
  ): Promise<Post> {
    const post = await this.postsRepository.findById(postId);
    if (!post || post.deletedAt !== null) {
      throw new PostNotFoundException(postId);
    }

    await this.permissionService.enforcePostEditPermission(actorId, {
      authorId: post.authorId,
      channelId: post.channelId,
      status: post.status,
    });

    const isEditable =
      post.status === PostStatus.DRAFT || post.status === PostStatus.NEEDS_REVISION;
    if (!isEditable) {
      throw new ValidationException(
        `Нельзя изменять медиа публикации в статусе «${post.status}».`,
      );
    }

    return post;
  }
}
