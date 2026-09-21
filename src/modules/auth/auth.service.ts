import { Injectable } from '@nestjs/common';
import { UsersRepository } from '../users/users.repository';
import { AuthUser, AuthChannelMembership } from './interfaces/auth-user.interface';
import { UnauthorizedUserException, UserDeactivatedException } from '../../common/exceptions/domain.exceptions';

@Injectable()
export class AuthService {
  constructor(private readonly usersRepository: UsersRepository) {}

  /**
   * Resolves an incoming Telegram ID to an AuthUser.
   * Throws UserDeactivatedException if user is deactivated.
   * Returns null if user is not found.
   */
  async resolveUser(telegramId: bigint | number | string): Promise<AuthUser | null> {
    const parsedId = typeof telegramId === 'bigint' ? telegramId : BigInt(telegramId);
    const user = await this.usersRepository.findByTelegramId(parsedId);

    if (!user) {
      return null;
    }

    if (!user.isActive) {
      throw new UserDeactivatedException(parsedId);
    }

    const channelMemberships: AuthChannelMembership[] = (user.channelMembers || []).map((m) => ({
      id: m.id,
      channelId: m.channelId,
      channelTitle: m.channel?.title || '',
      role: m.role,
      canPublish: m.canPublish,
      canApprove: m.canApprove,
    }));

    return {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      systemRole: user.systemRole,
      isActive: user.isActive,
      channelMemberships,
    };
  }

  /**
   * Authenticates an incoming Telegram user.
   * Throws UnauthorizedUserException if user is unknown or not registered.
   */
  async authenticate(telegramId: bigint | number | string): Promise<AuthUser> {
    const parsedId = typeof telegramId === 'bigint' ? telegramId : BigInt(telegramId);
    const authUser = await this.resolveUser(parsedId);

    if (!authUser) {
      throw new UnauthorizedUserException(parsedId);
    }

    return authUser;
  }

  /**
   * Validates that the user is currently active.
   */
  validateActive(user: AuthUser): void {
    if (!user.isActive) {
      throw new UserDeactivatedException(user.telegramId);
    }
  }
}
