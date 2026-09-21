/**
 * PublishingPreflightService
 * Two-stage publication preflight validation service.
 * Authoritative reference: AGENTS.md § 25; tasks.md § 19
 */

import { Injectable, Optional } from '@nestjs/common';
import { Post, Channel, PostTemplate, PostMedia, PostStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { TemplateValidator } from '../templates/template.validator';
import { TelegramRenderer } from '../rendering/telegram-renderer.service';
import { PermissionService } from '../auth/permission.service';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { ChannelPermission } from '../../common/enums';
import {
  ValidationException,
  InvalidPostStateTransitionException,
  PermissionDeniedException,
} from '../../common/exceptions/domain.exceptions';
import { TelegramPermanentException } from '../../infrastructure/telegram-api/errors/telegram-api.exceptions';
import { TELEGRAM_LIMITS } from '../../common/constants/telegram-limits';
import { TemplateSchema } from '../templates/interfaces/template.interface';
import { TelegramPayload } from '../rendering/interfaces/telegram-payload.interface';

export interface PreflightStage1Result {
  post: Post;
  channel: Channel;
  template: PostTemplate;
  media: PostMedia[];
  payload: TelegramPayload;
}

export interface PreflightStage2Result {
  post: Post & { channel: Channel; template: PostTemplate; media: PostMedia[] };
  channel: Channel;
  template: PostTemplate;
  media: PostMedia[];
  payload: TelegramPayload;
}

@Injectable()
export class PublishingPreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templateValidator: TemplateValidator,
    private readonly renderer: TelegramRenderer,
    private readonly permissionService: PermissionService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  /**
   * Stage 1 Preflight: Synchronous pre-enqueue / pre-schedule validation.
   * Throws domain ValidationException / PermissionDeniedException on invalid state.
   */
  async validateStage1(postId: string, actorId: string): Promise<PreflightStage1Result> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        channel: true,
        template: true,
        media: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!post || post.deletedAt !== null) {
      throw new ValidationException(`Post "${postId}" not found or deleted.`);
    }

    // 1. Post Status Validation (Must be APPROVED or PUBLISH_FAILED for manual retry)
    const publishableStatuses: PostStatus[] = [
      PostStatus.APPROVED,
      PostStatus.SCHEDULED,
      PostStatus.PUBLISH_FAILED,
    ];
    if (!publishableStatuses.includes(post.status)) {
      throw new InvalidPostStateTransitionException(post.status, PostStatus.PUBLISHING);
    }

    // 2. Channel Validation
    if (!post.channel || !post.channel.isActive) {
      throw new ValidationException(`Target channel "${post.channelId}" is inactive or missing.`);
    }
    if (!post.channel.telegramChatId || post.channel.telegramChatId.trim().length === 0) {
      throw new ValidationException(`Target channel "${post.channelId}" has no valid telegramChatId configured.`);
    }

    // 3. Permission Validation
    const canPublish = await this.permissionService.checkChannelPermission(
      actorId,
      post.channelId,
      ChannelPermission.PUBLISH_POST,
    );
    if (!canPublish) {
      throw new PermissionDeniedException(ChannelPermission.PUBLISH_POST, post.channelId);
    }

    // 4. Template & Content Validation
    if (!post.template || !post.template.isActive) {
      throw new ValidationException(`Post template "${post.templateId}" is inactive or missing.`);
    }
    const schema = post.template.schemaJson as unknown as TemplateSchema;
    const contentValidation = this.templateValidator.validateContent(
      schema,
      (post.contentJson as Record<string, unknown>) || {},
    );
    if (!contentValidation.isValid) {
      const errorMsg = contentValidation.errors.map((e) => e.message).join('; ');
      throw new ValidationException(`Validation against template "${post.template.name}" failed: ${errorMsg}`);
    }

    // 5. Media Group Invariants Validation
    if (post.media.length > 0) {
      if (post.media.length > TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE) {
        throw new ValidationException(
          `Media attachments count (${post.media.length}) exceeds maximum limit of ${TELEGRAM_LIMITS.MAX_MEDIA_GROUP_SIZE}.`,
        );
      }
      for (const m of post.media) {
        if (!m.telegramFileId || m.telegramFileId.trim().length === 0) {
          throw new ValidationException(`Media item "${m.id}" is missing telegramFileId.`);
        }
        if (!m.telegramFileUniqueId || m.telegramFileUniqueId.trim().length === 0) {
          throw new ValidationException(`Media item "${m.id}" is missing telegramFileUniqueId.`);
        }
        const mediaTypeLower = m.mediaType.toLowerCase();
        if (
          post.template.supportedMediaTypes.length > 0 &&
          !post.template.supportedMediaTypes.some((t) => t.toLowerCase() === mediaTypeLower)
        ) {
          throw new ValidationException(
            `Media type "${m.mediaType}" is not supported by template "${post.template.name}".`,
          );
        }
      }
    }

    // 6. Dry-run Canonical Rendering
    const payload = await this.renderer.render(post, post.template, post.media);
    if (!payload.messages || payload.messages.length === 0) {
      throw new ValidationException('Rendered publication payload produced zero outgoing messages.');
    }

    this.logger?.debug(
      {
        event: 'preflight_stage1_passed',
        postId,
        channelId: post.channelId,
        partsCount: payload.messages.length,
      },
      'PublishingPreflightService',
    );

    return {
      post,
      channel: post.channel,
      template: post.template,
      media: post.media,
      payload,
    };
  }

  /**
   * Stage 2 Preflight: Immediate pre-execution validation inside BullMQ worker before Telegram API dispatch.
   * Throws TelegramPermanentException if publication cannot proceed.
   */
  async validateStage2(postId: string): Promise<PreflightStage2Result> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        channel: true,
        template: true,
        media: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!post || post.deletedAt !== null) {
      throw new TelegramPermanentException(`Preflight Stage 2 failed: Post "${postId}" not found or soft-deleted`, 400);
    }

    const validExecutionStatuses: PostStatus[] = [
      PostStatus.APPROVED,
      PostStatus.SCHEDULED,
      PostStatus.PUBLISHING,
      PostStatus.PUBLISH_FAILED,
    ];
    if (!validExecutionStatuses.includes(post.status)) {
      throw new TelegramPermanentException(
        `Preflight Stage 2 failed: Post status is "${post.status}", publication cannot proceed`,
        400,
      );
    }

    if (!post.channel || !post.channel.isActive) {
      throw new TelegramPermanentException(
        `Preflight Stage 2 failed: Channel "${post.channelId}" is inactive or missing`,
        400,
      );
    }

    if (!post.channel.telegramChatId || post.channel.telegramChatId.trim().length === 0) {
      throw new TelegramPermanentException(
        `Preflight Stage 2 failed: Channel "${post.channelId}" has no valid telegramChatId configured`,
        400,
      );
    }

    if (!post.template || !post.template.isActive) {
      throw new TelegramPermanentException(
        `Preflight Stage 2 failed: Template "${post.templateId}" is inactive or missing`,
        400,
      );
    }

    // Render payload
    const payload = await this.renderer.render(post, post.template, post.media);
    if (!payload.messages || payload.messages.length === 0) {
      throw new TelegramPermanentException('Preflight Stage 2 failed: Rendered payload produced zero messages', 400);
    }

    this.logger?.debug(
      {
        event: 'preflight_stage2_passed',
        postId,
        channelId: post.channelId,
        partsCount: payload.messages.length,
      },
      'PublishingPreflightService',
    );

    return {
      post,
      channel: post.channel,
      template: post.template,
      media: post.media,
      payload,
    };
  }
}
