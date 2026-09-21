import { SystemRole, ChannelRole } from '@prisma/client';

export interface AuthChannelMembership {
  id: string;
  channelId: string;
  channelTitle: string;
  role: ChannelRole;
  canPublish: boolean;
  canApprove: boolean;
}

export interface AuthUser {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  systemRole: SystemRole;
  isActive: boolean;
  channelMemberships: AuthChannelMembership[];
}
