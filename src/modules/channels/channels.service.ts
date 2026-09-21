import { Injectable } from '@nestjs/common';
import { Channel, ChannelMember, ChannelRole, SystemRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChannelNotFoundException } from '../../common/exceptions/domain.exceptions';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { parseAndValidateScheduledDate, formatChannelDate } from './utils/timezone.util';
import { AuditAction } from '../../common/enums';

export interface AutoSkipResult {
  singleChannel: Channel | null;
  channels: Channel[];
  mustChoose: boolean;
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getById(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
    });
    if (!channel) {
      throw new ChannelNotFoundException(id);
    }
    return channel;
  }

  async getByChatId(telegramChatId: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({
      where: { telegramChatId },
    });
    if (!channel) {
      throw new ChannelNotFoundException(telegramChatId);
    }
    return channel;
  }

  /**
   * Returns all active channels a user is authorized to post or manage.
   * SUPER_ADMIN has access to all active channels.
   */
  async getUserAuthorizedChannels(userId: string): Promise<Channel[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.isActive) {
      return [];
    }

    if (user.systemRole === SystemRole.SUPER_ADMIN) {
      return this.prisma.channel.findMany({
        where: { isActive: true },
        orderBy: { title: 'asc' },
      });
    }

    const memberships = await this.prisma.channelMember.findMany({
      where: {
        userId,
        channel: { isActive: true },
      },
      include: { channel: true },
      orderBy: { channel: { title: 'asc' } },
    });

    return memberships.map((m) => m.channel);
  }

  /**
   * Helper for wizard Step 1: if user has access to exactly 1 channel, automatically skip selection.
   */
  async autoSkipSingleChannel(userId: string): Promise<AutoSkipResult> {
    const channels = await this.getUserAuthorizedChannels(userId);

    if (channels.length === 1) {
      return {
        singleChannel: channels[0] ?? null,
        channels,
        mustChoose: false,
      };
    }

    return {
      singleChannel: null,
      channels,
      mustChoose: channels.length > 1,
    };
  }

  async createChannel(dto: CreateChannelDto, actorId?: string): Promise<Channel> {
    const channel = await this.prisma.channel.create({
      data: {
        telegramChatId: dto.telegramChatId,
        title: dto.title,
        username: dto.username ?? null,
        timezone: dto.timezone ?? 'Europe/Kyiv',
        publicationMode: dto.publicationMode ?? 'DIRECT',
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'channel',
      entityId: channel.id,
      actorId: actorId ?? null,
      payload: {
        telegramChatId: channel.telegramChatId,
        title: channel.title,
        timezone: channel.timezone,
      },
    });

    return channel;
  }

  async updateChannel(id: string, dto: UpdateChannelDto, actorId?: string): Promise<Channel> {
    const channel = await this.prisma.channel.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.username !== undefined ? { username: dto.username } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.publicationMode !== undefined ? { publicationMode: dto.publicationMode } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    await this.auditService.record({
      action: AuditAction.SETTINGS_CHANGED,
      entityType: 'channel',
      entityId: channel.id,
      actorId: actorId ?? null,
      payload: { ...dto },
    });

    return channel;
  }

  async addMember(
    channelId: string,
    userId: string,
    role: ChannelRole = ChannelRole.AUTHOR,
    canPublish = false,
    canApprove = false,
    actorId?: string,
  ): Promise<ChannelMember> {
    const member = await this.prisma.channelMember.upsert({
      where: {
        channelId_userId: { channelId, userId },
      },
      create: {
        channelId,
        userId,
        role,
        canPublish,
        canApprove,
      },
      update: {
        role,
        canPublish,
        canApprove,
      },
    });

    await this.auditService.record({
      action: AuditAction.PERMISSION_CHANGED,
      entityType: 'channel_member',
      entityId: member.id,
      actorId: actorId ?? null,
      payload: { channelId, userId, role, canPublish, canApprove },
    });

    return member;
  }

  async parseAndValidateDate(input: string, channelId: string): Promise<Date> {
    const channel = await this.getById(channelId);
    return parseAndValidateScheduledDate(input, channel.timezone);
  }

  async formatDate(date: Date, channelId: string): Promise<string> {
    const channel = await this.getById(channelId);
    return formatChannelDate(date, channel.timezone);
  }
}
