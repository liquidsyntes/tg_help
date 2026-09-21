/**
 * BotContext Interface
 * Extends grammY Context with request tracing, resolved authentication, and permission helpers.
 * Authoritative reference: AGENTS.md § 3, § 5, § 8, § 9; tasks.md § 4, § 7
 */

import { Context } from 'grammy';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { ChannelPermission, SystemRole } from '../../../common/enums';

export interface BotContextFlavor {
  requestId: string;
  authUser?: AuthUser;
  readonly isSuperAdmin: boolean;
  canChannel: (permission: ChannelPermission, channelId: string) => boolean;
}

export type BotContext = Context & BotContextFlavor;
