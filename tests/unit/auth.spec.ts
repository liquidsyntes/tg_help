import 'reflect-metadata';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UsersService } from '../../src/modules/users/users.service';
import { UsersRepository } from '../../src/modules/users/users.repository';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SystemRole, ChannelRole } from '@prisma/client';
import {
  UnauthorizedUserException,
  UserDeactivatedException,
} from '../../src/common/exceptions/domain.exceptions';

describe('AuthService & UsersService Unit Tests', () => {
  let authService: AuthService;
  let usersService: UsersService;
  let mockUsersRepository: Partial<UsersRepository>;
  let mockAuditService: Partial<AuditService>;

  const testUser = {
    id: 'user-1',
    telegramId: 123456789n,
    username: 'testuser',
    firstName: 'Test',
    lastName: 'User',
    systemRole: SystemRole.USER,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    channelMembers: [
      {
        id: 'cm-1',
        channelId: 'chan-1',
        userId: 'user-1',
        role: ChannelRole.AUTHOR,
        canPublish: false,
        canApprove: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        channel: {
          id: 'chan-1',
          telegramChatId: '-100123',
          title: 'News Channel',
          username: 'news_channel',
          timezone: 'Europe/Kyiv',
          publicationMode: 'DIRECT',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ],
  };

  beforeEach(() => {
    mockUsersRepository = {
      findByTelegramId: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' } as any),
    };

    authService = new AuthService(mockUsersRepository as UsersRepository);
    usersService = new UsersService(
      mockUsersRepository as UsersRepository,
      mockAuditService as AuditService,
    );
  });

  describe('AuthService.resolveUser', () => {
    it('should return AuthUser for active registered user', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue(testUser);

      const user = await authService.resolveUser(123456789n);
      expect(user).not.toBeNull();
      expect(user?.id).toBe('user-1');
      expect(user?.telegramId).toBe(123456789n);
      expect(user?.isActive).toBe(true);
      expect(user?.channelMemberships).toHaveLength(1);
      expect(user?.channelMemberships?.[0]?.channelTitle).toBe('News Channel');
    });

    it('should accept string or number telegramId and convert to BigInt', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue(testUser);

      const user = await authService.resolveUser('123456789');
      expect(mockUsersRepository.findByTelegramId).toHaveBeenCalledWith(123456789n);
      expect(user?.id).toBe('user-1');
    });

    it('should return null when user is not found in database', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue(null);

      const user = await authService.resolveUser(999999999n);
      expect(user).toBeNull();
    });

    it('should throw UserDeactivatedException when user isActive is false', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue({
        ...testUser,
        isActive: false,
      });

      await expect(authService.resolveUser(123456789n)).rejects.toThrow(UserDeactivatedException);
      await expect(authService.resolveUser(123456789n)).rejects.toThrow(
        /Ваш аккаунт деактивирован/,
      );
    });
  });

  describe('AuthService.authenticate', () => {
    it('should return AuthUser for active registered user', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue(testUser);

      const user = await authService.authenticate(123456789n);
      expect(user.id).toBe('user-1');
    });

    it('should throw UnauthorizedUserException with Russian user message for unknown Telegram ID', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue(null);

      await expect(authService.authenticate(999999999n)).rejects.toThrow(
        UnauthorizedUserException,
      );
      await expect(authService.authenticate(999999999n)).rejects.toThrow(
        /У вас пока нет доступа к редакции/,
      );
    });

    it('should throw UserDeactivatedException with Russian message for deactivated user', async () => {
      (mockUsersRepository.findByTelegramId as jest.Mock).mockResolvedValue({
        ...testUser,
        isActive: false,
      });

      await expect(authService.authenticate(123456789n)).rejects.toThrow(UserDeactivatedException);
      await expect(authService.authenticate(123456789n)).rejects.toThrow(
        /Ваш аккаунт деактивирован/,
      );
    });
  });

  describe('UsersService lifecycle', () => {
    it('should create user, convert telegramId to BigInt, and log audit event', async () => {
      (mockUsersRepository.create as jest.Mock).mockResolvedValue({
        id: 'user-new',
        telegramId: 555555n,
        username: 'newuser',
        firstName: 'New',
        lastName: 'User',
        systemRole: SystemRole.USER,
        isActive: true,
      });

      const user = await usersService.createUser(
        {
          telegramId: '555555',
          username: 'newuser',
        },
        'admin-1',
      );

      expect(mockUsersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ telegramId: 555555n }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user_added',
          actorId: 'admin-1',
          entityId: 'user-new',
        }),
      );
      expect(user.id).toBe('user-new');
    });

    it('should deactivate user and log user_blocked audit event', async () => {
      (mockUsersRepository.update as jest.Mock).mockResolvedValue({
        ...testUser,
        isActive: false,
      });

      const updated = await usersService.deactivateUser('user-1', 'admin-1');
      expect(mockUsersRepository.update).toHaveBeenCalledWith('user-1', { isActive: false });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user_blocked', entityId: 'user-1' }),
      );
      expect(updated.isActive).toBe(false);
    });

    it('should reactivate user and log user_reactivated audit event', async () => {
      (mockUsersRepository.update as jest.Mock).mockResolvedValue({
        ...testUser,
        isActive: true,
      });

      const updated = await usersService.reactivateUser('user-1', 'admin-1');
      expect(mockUsersRepository.update).toHaveBeenCalledWith('user-1', { isActive: true });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user_reactivated', entityId: 'user-1' }),
      );
      expect(updated.isActive).toBe(true);
    });
  });
});
