import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ChannelPermission, SystemPermission, PostStatus, ChannelRole, SystemRole } from '../../common/enums';
import { PermissionDeniedException, UserDeactivatedException } from '../../common/exceptions/domain.exceptions';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates channel-scoped permissions for an actor.
   * SUPER_ADMIN bypasses all channel-level checks.
   */
  async checkChannelPermission(
    actorId: string,
    channelId: string,
    permission: ChannelPermission | string,
  ): Promise<boolean> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
    });

    if (!actor || !actor.isActive) {
      return false;
    }

    // 1. SUPER_ADMIN system bypass
    if (actor.systemRole === SystemRole.SUPER_ADMIN) {
      return true;
    }

    // 2. Channel active check
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || !channel.isActive) {
      return false;
    }

    // 3. Channel membership check
    const member = await this.prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId,
          userId: actorId,
        },
      },
    });

    if (!member) {
      return false;
    }

    // 4. Granular evaluation
    switch (permission) {
      case ChannelPermission.CREATE_POST:
        return member.role === ChannelRole.EDITOR || member.role === ChannelRole.AUTHOR;

      case ChannelPermission.SUBMIT_REVIEW:
        return member.role === ChannelRole.EDITOR || member.role === ChannelRole.AUTHOR;

      case ChannelPermission.APPROVE_POST:
        return member.role === ChannelRole.EDITOR && member.canApprove;

      case ChannelPermission.REJECT_POST:
        return member.role === ChannelRole.EDITOR && member.canApprove;

      case ChannelPermission.REQUEST_REVISION:
        return member.role === ChannelRole.EDITOR && member.canApprove;

      case ChannelPermission.PUBLISH_POST:
        return member.canPublish;

      case ChannelPermission.SCHEDULE_POST:
        return member.role === ChannelRole.EDITOR && (member.canPublish || member.canApprove);

      case ChannelPermission.CANCEL_SCHEDULE:
        return member.role === ChannelRole.EDITOR && (member.canPublish || member.canApprove);

      case ChannelPermission.DELETE_POST:
        return member.role === ChannelRole.EDITOR || member.role === ChannelRole.AUTHOR;

      case ChannelPermission.VIEW_POST:
        return true;

      default:
        return false;
    }
  }

  /**
   * Throws PermissionDeniedException if actor lacks the channel permission.
   */
  async enforceChannelPermission(
    actorId: string,
    channelId: string,
    permission: ChannelPermission | string,
  ): Promise<void> {
    const allowed = await this.checkChannelPermission(actorId, channelId, permission);
    if (!allowed) {
      throw new PermissionDeniedException(permission, channelId);
    }
  }

  /**
   * Checks post-level edit permissions (autosave, granular field modifications).
   */
  async checkPostEditPermission(
    actorId: string,
    post: { authorId: string; channelId: string; status: PostStatus },
  ): Promise<boolean> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
    });

    if (!actor || !actor.isActive) {
      return false;
    }

    if (actor.systemRole === SystemRole.SUPER_ADMIN) {
      return true;
    }

    const member = await this.prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId: post.channelId,
          userId: actorId,
        },
      },
    });

    if (!member) {
      return false;
    }

    // Editor can edit any post in the channel
    if (member.role === ChannelRole.EDITOR) {
      return true;
    }

    // Author can ONLY edit their own post and ONLY while in editable statuses (DRAFT or NEEDS_REVISION)
    if (member.role === ChannelRole.AUTHOR) {
      const isOwner = post.authorId === actorId;
      const isEditableStatus =
        post.status === PostStatus.DRAFT || post.status === PostStatus.NEEDS_REVISION;
      return isOwner && isEditableStatus;
    }

    return false;
  }

  /**
   * Throws PermissionDeniedException if actor cannot edit the post.
   */
  async enforcePostEditPermission(
    actorId: string,
    post: { authorId: string; channelId: string; status: PostStatus },
  ): Promise<void> {
    const allowed = await this.checkPostEditPermission(actorId, post);
    if (!allowed) {
      throw new PermissionDeniedException('EDIT_POST', post.channelId);
    }
  }

  /**
   * Checks system-wide permissions (MANAGE_USERS, MANAGE_CHANNELS, etc.).
   */
  async checkSystemPermission(
    actorId: string,
    permission: SystemPermission | string,
  ): Promise<boolean> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
    });

    if (!actor || !actor.isActive) {
      return false;
    }

    return actor.systemRole === SystemRole.SUPER_ADMIN;
  }

  /**
   * Enforces system-level permission.
   */
  async enforceSystemPermission(
    actorId: string,
    permission: SystemPermission | string,
  ): Promise<void> {
    const allowed = await this.checkSystemPermission(actorId, permission);
    if (!allowed) {
      throw new PermissionDeniedException(permission);
    }
  }

  /**
   * General permission checking contract (PROJECT.md Interface Contract)
   */
  async checkPermission(actorId: string, channelId: string, permission: string): Promise<boolean> {
    return this.checkChannelPermission(actorId, channelId, permission);
  }
}
