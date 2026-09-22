import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { Post, MediaType, Prisma, PostStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PostsRepository } from './posts.repository';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../auth/permission.service';
import { MediaService } from '../media/media.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { ChannelPermission, AuditAction } from '../../common/enums';
import {
  PostNotFoundException,
  PermissionDeniedException,
  ValidationException,
} from '../../common/exceptions/domain.exceptions';

export interface AttachMediaDto {
  telegramFileId: string;
  telegramFileUniqueId: string;
  mediaType: MediaType;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: bigint | number | null;
  caption?: string | null;
  sortOrder?: number;
}

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRepository: PostsRepository,
    private readonly auditService: AuditService,
    private readonly permissionService: PermissionService,
    @Optional()
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService?: MediaService,
  ) {}

  /**
   * Initializes a new draft in PostgreSQL.
   */
  async createDraft(dto: CreateDraftDto): Promise<Post> {
    await this.permissionService.enforceChannelPermission(
      dto.authorId,
      dto.channelId,
      ChannelPermission.CREATE_POST,
    );

    const post = await this.postsRepository.createDraft(dto);

    await this.auditService.record({
      action: AuditAction.POST_CREATED,
      entityType: 'post',
      entityId: post.id,
      actorId: dto.authorId,
      payload: {
        channelId: post.channelId,
        templateId: post.templateId,
        status: post.status,
      },
    });

    return post;
  }

  /**
   * Retrieves an active (non-deleted) post by ID.
   */
  async getPost(id: string): Promise<Post> {
    const post = await this.postsRepository.findById(id);
    if (!post || post.deletedAt !== null) {
      throw new PostNotFoundException(id);
    }
    return post;
  }

  /**
   * Retrieves a post by ID with all relations, or null if not found.
   */
  async getPostWithRelations(id: string, includeDeleted = false): Promise<Post | null> {
    return this.postsRepository.findById(id, includeDeleted);
  }

  /**
   * Step-by-step Autosave: Persists draft field updates directly to PostgreSQL.
   * Enforces Optimistic Concurrency Control (OCC).
   * Enforces Autosave Silent Rule (F-40): emits ZERO notifications.
   */
  async autosaveStep(
    postId: string,
    expectedVersion: number,
    actorId: string,
    fieldKey: string,
    fieldValue: unknown,
  ): Promise<Post> {
    const post = await this.getPost(postId);

    await this.permissionService.enforcePostEditPermission(actorId, {
      authorId: post.authorId,
      channelId: post.channelId,
      status: post.status,
    });

    const currentContent = (post.contentJson as Record<string, unknown>) || {};
    const updatedContent = {
      ...currentContent,
      [fieldKey]: fieldValue,
    };

    const updatePayload: Prisma.PostUpdateInput = {
      contentJson: updatedContent as Prisma.InputJsonValue,
    };

    // Update with OCC
    const updatedPost = await this.postsRepository.updateWithOcc(
      postId,
      expectedVersion,
      updatePayload,
    );

    // Append-only audit record (no notifications dispatched!)
    await this.auditService.record({
      action: AuditAction.POST_UPDATED,
      entityType: 'post',
      entityId: postId,
      actorId,
      payload: {
        field: fieldKey,
        previousVersion: expectedVersion,
        newVersion: updatedPost.version,
      },
    });

    return updatedPost;
  }

  /**
   * Attaches media to a post and increments the post version via OCC.
   * Delegates to MediaService when injected.
   */
  async attachMedia(
    postId: string,
    expectedVersion: number,
    actorId: string,
    media: AttachMediaDto,
  ): Promise<Post> {
    if (this.mediaService) {
      return this.mediaService.attachMedia(postId, expectedVersion, actorId, media);
    }

    const post = await this.getPost(postId);
    await this.permissionService.enforcePostEditPermission(actorId, {
      authorId: post.authorId,
      channelId: post.channelId,
      status: post.status,
    });

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
          sortOrder: media.sortOrder ?? 0,
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
   * Removes attached media and increments post OCC version.
   * Delegates to MediaService when injected.
   */
  async removeMedia(
    postId: string,
    mediaId: string,
    expectedVersion: number,
    actorId: string,
  ): Promise<Post> {
    if (this.mediaService) {
      return this.mediaService.removeMedia(postId, mediaId, expectedVersion, actorId);
    }

    const post = await this.getPost(postId);
    await this.permissionService.enforcePostEditPermission(actorId, {
      authorId: post.authorId,
      channelId: post.channelId,
      status: post.status,
    });

    return this.prisma.$transaction(async (tx) => {
      await tx.postMedia.delete({
        where: { id: mediaId },
      });

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
          payload: { mediaId, version: updatedPost.version },
        },
        tx,
      );

      return updatedPost;
    });
  }

  /**
   * Soft deletes a post (`deleted_at = NOW()`).
   * Normal queries automatically filter deleted records.
   */
  async softDeletePost(postId: string, expectedVersion: number, actorId: string): Promise<Post> {
    const post = await this.getPost(postId);

    const isAuthor = post.authorId === actorId;
    const canDelete =
      isAuthor ||
      (await this.permissionService.checkChannelPermission(
        actorId,
        post.channelId,
        ChannelPermission.DELETE_POST,
      ));

    if (!canDelete) {
      throw new PermissionDeniedException(ChannelPermission.DELETE_POST, post.channelId);
    }

    const deletedPost = await this.postsRepository.softDelete(postId, expectedVersion);

    await this.auditService.record({
      action: AuditAction.POST_DELETED,
      entityType: 'post',
      entityId: postId,
      actorId,
      payload: { deletedAt: new Date().toISOString() },
    });

    return deletedPost;
  }
}
