import 'reflect-metadata';
import { IANAZone } from 'luxon';
import { AuthService } from '../../src/modules/auth/auth.service';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { UsersService } from '../../src/modules/users/users.service';
import { UsersRepository } from '../../src/modules/users/users.repository';
import { ChannelsService } from '../../src/modules/channels/channels.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import {
  parseAndValidateScheduledDate,
  formatChannelDate,
  DEFAULT_CHANNEL_TIMEZONE,
} from '../../src/modules/channels/utils/timezone.util';
import {
  SystemRole,
  ChannelRole,
  PostStatus,
  ChannelPermission,
  SystemPermission,
} from '../../src/common/enums';
import {
  UnauthorizedUserException,
  UserDeactivatedException,
  PermissionDeniedException,
  ValidationException,
  ChannelNotFoundException,
} from '../../src/common/exceptions/domain.exceptions';

describe('Milestone 2 Empirical Adversarial Stress Suite (m2_challenger_1)', () => {
  // =========================================================================
  // Dimension 1: Authentication & BigInt Boundary Stress-Testing
  // =========================================================================
  describe('1. Authentication & BigInt Boundary Handling', () => {
    let authService: AuthService;
    let usersService: UsersService;
    let mockUsersRepo: Partial<UsersRepository>;
    let mockAuditService: Partial<AuditService>;

    const activeDbUser = {
      id: 'usr-active-uuid',
      telegramId: 123456789n,
      username: 'active_reporter',
      firstName: 'Active',
      lastName: 'Reporter',
      systemRole: SystemRole.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      channelMembers: [
        {
          id: 'cm-1',
          channelId: 'chan-alpha',
          userId: 'usr-active-uuid',
          role: ChannelRole.AUTHOR,
          canPublish: false,
          canApprove: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          channel: {
            id: 'chan-alpha',
            telegramChatId: '-1001234567890',
            title: 'Alpha Channel',
            username: 'alpha_chan',
            timezone: 'Europe/Kyiv',
            publicationMode: 'DIRECT',
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
    };

    const deactivatedDbUser = {
      ...activeDbUser,
      id: 'usr-deactivated-uuid',
      telegramId: 999111222n,
      username: 'banned_reporter',
      isActive: false,
    };

    beforeEach(() => {
      mockUsersRepo = {
        findByTelegramId: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      };

      mockAuditService = {
        record: jest.fn().mockResolvedValue({ id: 'audit-id-1' } as any),
      };

      authService = new AuthService(mockUsersRepo as UsersRepository);
      usersService = new UsersService(
        mockUsersRepo as UsersRepository,
        mockAuditService as AuditService,
      );
    });

    describe('1.1 Unknown Telegram ID Rejection', () => {
      it('should return null on resolveUser for non-existent Telegram ID', async () => {
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(null);

        const result = await authService.resolveUser(888777666n);
        expect(result).toBeNull();
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(888777666n);
      });

      it('should throw UnauthorizedUserException on authenticate for non-existent Telegram ID', async () => {
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(null);

        const unknownId = 888777666n;
        await expect(authService.authenticate(unknownId)).rejects.toThrow(UnauthorizedUserException);

        try {
          await authService.authenticate(unknownId);
          fail('Should have thrown UnauthorizedUserException');
        } catch (error: any) {
          expect(error).toBeInstanceOf(UnauthorizedUserException);
          expect(error.statusCode).toBe(401);
          expect(error.errorCode).toBe('UNAUTHORIZED_USER');
          expect(error.userFriendlyMessage).toBe(
            'У вас пока нет доступа к редакции. Обратитесь к администратору.',
          );
          expect(error.message).toContain('888777666');
          expect(error.message).toContain('У вас пока нет доступа к редакции');
        }
      });

      it('should reject string and number representations of unknown Telegram ID', async () => {
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(null);

        await expect(authService.authenticate('5544332211')).rejects.toThrow(
          UnauthorizedUserException,
        );
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(5544332211n);

        await expect(authService.authenticate(5544332211)).rejects.toThrow(
          UnauthorizedUserException,
        );
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(5544332211n);
      });
    });

    describe('1.2 Deactivated User Rejection', () => {
      it('should throw UserDeactivatedException on resolveUser when isActive is false', async () => {
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(deactivatedDbUser);

        await expect(authService.resolveUser(999111222n)).rejects.toThrow(
          UserDeactivatedException,
        );

        try {
          await authService.resolveUser(999111222n);
          fail('Should have thrown UserDeactivatedException');
        } catch (error: any) {
          expect(error).toBeInstanceOf(UserDeactivatedException);
          expect(error.statusCode).toBe(403);
          expect(error.errorCode).toBe('USER_DEACTIVATED');
          expect(error.userFriendlyMessage).toBe(
            'Ваш аккаунт деактивирован. Обратитесь к администратору.',
          );
          expect(error.message).toContain('999111222');
          expect(error.message).toContain('Ваш аккаунт деактивирован');
        }
      });

      it('should throw UserDeactivatedException on authenticate when isActive is false', async () => {
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(deactivatedDbUser);

        await expect(authService.authenticate(999111222n)).rejects.toThrow(
          UserDeactivatedException,
        );
      });

      it('validateActive should throw UserDeactivatedException if user is inactive', () => {
        const inactiveAuthUser = {
          id: 'u-1',
          telegramId: 999111222n,
          username: 'test',
          firstName: null,
          lastName: null,
          systemRole: SystemRole.USER,
          isActive: false,
          channelMemberships: [],
        };

        expect(() => authService.validateActive(inactiveAuthUser)).toThrow(
          UserDeactivatedException,
        );
      });

      it('validateActive should not throw if user is active', () => {
        const activeAuthUser = {
          id: 'u-1',
          telegramId: 123456789n,
          username: 'test',
          firstName: null,
          lastName: null,
          systemRole: SystemRole.USER,
          isActive: true,
          channelMemberships: [],
        };

        expect(() => authService.validateActive(activeAuthUser)).not.toThrow();
      });
    });

    describe('1.3 BigInt Boundary & Extreme Values Handling', () => {
      it('should accurately handle PostgreSQL maximum signed 64-bit integer (9223372036854775807n)', async () => {
        const maxInt64 = 9223372036854775807n; // 2^63 - 1
        const maxUser = {
          ...activeDbUser,
          id: 'usr-max-int64',
          telegramId: maxInt64,
        };
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(maxUser);

        // BigInt literal
        const userByBigInt = await authService.resolveUser(maxInt64);
        expect(userByBigInt?.telegramId).toBe(maxInt64);
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(9223372036854775807n);

        // String representation (prevents float64 IEEE 754 precision loss)
        const userByString = await authService.resolveUser('9223372036854775807');
        expect(userByString?.telegramId).toBe(maxInt64);
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(9223372036854775807n);

        // Prove that string preserves precision where Number() loses it
        const lostPrecisionNumber = Number('9223372036854775807');
        expect(BigInt(lostPrecisionNumber)).not.toBe(maxInt64); // 9223372036854775808n !== 9223372036854775807n
      });

      it('should accurately handle negative Telegram chat IDs (-1001234567890n)', async () => {
        const negChatId = -1001234567890n;
        const negUser = {
          ...activeDbUser,
          telegramId: negChatId,
        };
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(negUser);

        const res = await authService.resolveUser('-1001234567890');
        expect(res?.telegramId).toBe(-1001234567890n);
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(-1001234567890n);
      });

      it('should accurately handle PostgreSQL minimum signed 64-bit integer (-9223372036854775808n)', async () => {
        const minInt64 = -9223372036854775808n; // -2^63
        const minUser = {
          ...activeDbUser,
          telegramId: minInt64,
        };
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(minUser);

        const res = await authService.resolveUser('-9223372036854775808');
        expect(res?.telegramId).toBe(minInt64);
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(-9223372036854775808n);
      });

      it('should handle zero (0n) as a valid Telegram ID without treating it as falsy null', async () => {
        const zeroUser = {
          ...activeDbUser,
          telegramId: 0n,
        };
        (mockUsersRepo.findByTelegramId as jest.Mock).mockResolvedValue(zeroUser);

        const res = await authService.resolveUser(0n);
        expect(res?.telegramId).toBe(0n);
        expect(mockUsersRepo.findByTelegramId).toHaveBeenCalledWith(0n);
      });

      it('should pass exact BigInt to UsersRepository.create on UsersService.createUser', async () => {
        (mockUsersRepo.create as jest.Mock).mockResolvedValue({
          id: 'u-created',
          telegramId: 9223372036854775807n,
          username: 'max_user',
          isActive: true,
          systemRole: SystemRole.USER,
        });

        const created = await usersService.createUser({
          telegramId: '9223372036854775807',
          username: 'max_user',
        });

        expect(mockUsersRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            telegramId: 9223372036854775807n,
          }),
        );
        expect(mockAuditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              telegramId: '9223372036854775807',
            }),
          }),
        );
        expect(created.id).toBe('u-created');
      });

      it('should fail with SyntaxError if malformed non-numeric string is provided to resolveUser', async () => {
        await expect(authService.resolveUser('invalid-alphanumeric-id')).rejects.toThrow(SyntaxError);
      });
    });
  });

  // =========================================================================
  // Dimension 2: RBAC Permissions & System Bypass Stress-Testing
  // =========================================================================
  describe('2. RBAC Permissions & Security Boundaries', () => {
    let permissionService: PermissionService;
    let mockPrisma: any;

    const channelId = 'chan-test-uuid';
    const authorUserId = 'author-uuid';
    const editorUserId = 'editor-uuid';
    const superAdminUserId = 'superadmin-uuid';
    const viewerUserId = 'viewer-uuid';

    beforeEach(() => {
      mockPrisma = {
        user: { findUnique: jest.fn() },
        channel: { findUnique: jest.fn() },
        channelMember: { findUnique: jest.fn() },
      };
      permissionService = new PermissionService(mockPrisma as any);
    });

    describe('2.1 Author Attempting Privileged Operations (Must Be Rejected)', () => {
      beforeEach(() => {
        // Active Author user
        mockPrisma.user.findUnique.mockImplementation(({ where }: any) => {
          if (where.id === authorUserId) {
            return Promise.resolve({
              id: authorUserId,
              systemRole: SystemRole.USER,
              isActive: true,
            });
          }
          return Promise.resolve(null);
        });

        // Active Channel
        mockPrisma.channel.findUnique.mockResolvedValue({
          id: channelId,
          isActive: true,
        });

        // Channel Member: AUTHOR without publish/approve flags
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          id: 'cm-author',
          channelId,
          userId: authorUserId,
          role: ChannelRole.AUTHOR,
          canPublish: false,
          canApprove: false,
        });
      });

      it('Author attempting APPROVE_POST must return false and throw PermissionDeniedException', async () => {
        const allowed = await permissionService.checkChannelPermission(
          authorUserId,
          channelId,
          ChannelPermission.APPROVE_POST,
        );
        expect(allowed).toBe(false);

        await expect(
          permissionService.enforceChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          ),
        ).rejects.toThrow(PermissionDeniedException);

        try {
          await permissionService.enforceChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          );
          fail('Should have thrown PermissionDeniedException');
        } catch (err: any) {
          expect(err).toBeInstanceOf(PermissionDeniedException);
          expect(err.statusCode).toBe(403);
          expect(err.errorCode).toBe('PERMISSION_DENIED');
          expect(err.message).toContain('APPROVE_POST');
        }
      });

      it('Author attempting PUBLISH_POST must return false and throw PermissionDeniedException', async () => {
        const allowed = await permissionService.checkChannelPermission(
          authorUserId,
          channelId,
          ChannelPermission.PUBLISH_POST,
        );
        expect(allowed).toBe(false);

        await expect(
          permissionService.enforceChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.PUBLISH_POST,
          ),
        ).rejects.toThrow(PermissionDeniedException);
      });

      it('Author attempting REJECT_POST and REQUEST_REVISION must return false', async () => {
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.REJECT_POST,
          ),
        ).toBe(false);

        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.REQUEST_REVISION,
          ),
        ).toBe(false);
      });

      it('Author attempting SCHEDULE_POST or CANCEL_SCHEDULE must return false', async () => {
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.SCHEDULE_POST,
          ),
        ).toBe(false);

        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.CANCEL_SCHEDULE,
          ),
        ).toBe(false);
      });

      it('Author with malicious flag injection (canApprove: true on AUTHOR) is still rejected from APPROVE_POST', async () => {
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          id: 'cm-author-tampered',
          channelId,
          userId: authorUserId,
          role: ChannelRole.AUTHOR,
          canPublish: false,
          canApprove: true, // Malicious flag set while role is AUTHOR
        });

        const allowed = await permissionService.checkChannelPermission(
          authorUserId,
          channelId,
          ChannelPermission.APPROVE_POST,
        );
        expect(allowed).toBe(false);
      });

      it('Author is permitted CREATE_POST, SUBMIT_REVIEW, DELETE_POST, VIEW_POST', async () => {
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.CREATE_POST,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.SUBMIT_REVIEW,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.DELETE_POST,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            authorUserId,
            channelId,
            ChannelPermission.VIEW_POST,
          ),
        ).toBe(true);
      });
    });

    describe('2.2 Editor Granular Permissions & Flag Combinations', () => {
      beforeEach(() => {
        mockPrisma.user.findUnique.mockResolvedValue({
          id: editorUserId,
          systemRole: SystemRole.USER,
          isActive: true,
        });
        mockPrisma.channel.findUnique.mockResolvedValue({
          id: channelId,
          isActive: true,
        });
      });

      it('Editor with canApprove: true and canPublish: false can approve/reject but CANNOT publish', async () => {
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          role: ChannelRole.EDITOR,
          canApprove: true,
          canPublish: false,
        });

        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.REJECT_POST,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.REQUEST_REVISION,
          ),
        ).toBe(true);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.SCHEDULE_POST,
          ),
        ).toBe(true);
        // CANNOT publish!
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.PUBLISH_POST,
          ),
        ).toBe(false);
      });

      it('Editor with canApprove: false and canPublish: true can publish but CANNOT approve', async () => {
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          role: ChannelRole.EDITOR,
          canApprove: false,
          canPublish: true,
        });

        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.PUBLISH_POST,
          ),
        ).toBe(true);
        // CANNOT approve/reject/request revision!
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          ),
        ).toBe(false);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.REJECT_POST,
          ),
        ).toBe(false);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.REQUEST_REVISION,
          ),
        ).toBe(false);
      });

      it('Editor with canApprove: false and canPublish: false cannot approve or publish or schedule', async () => {
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          role: ChannelRole.EDITOR,
          canApprove: false,
          canPublish: false,
        });

        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          ),
        ).toBe(false);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.PUBLISH_POST,
          ),
        ).toBe(false);
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.SCHEDULE_POST,
          ),
        ).toBe(false);
        // Base actions still allowed
        expect(
          await permissionService.checkChannelPermission(
            editorUserId,
            channelId,
            ChannelPermission.CREATE_POST,
          ),
        ).toBe(true);
      });

      it('EMPERICAL FINDING: PostWorkflowService checks PUBLISH_POST instead of SCHEDULE_POST when transitioning to SCHEDULED', async () => {
        // Setup Editor with canApprove: true, canPublish: false
        mockPrisma.channelMember.findUnique.mockResolvedValue({
          role: ChannelRole.EDITOR,
          canApprove: true,
          canPublish: false,
        });

        // 1. PermissionService considers this Editor authorized for SCHEDULE_POST
        const canSchedule = await permissionService.checkChannelPermission(
          editorUserId,
          channelId,
          ChannelPermission.SCHEDULE_POST,
        );
        expect(canSchedule).toBe(true);

        // 2. But PostWorkflowService.transition checks PUBLISH_POST
        const canPublish = await permissionService.checkChannelPermission(
          editorUserId,
          channelId,
          ChannelPermission.PUBLISH_POST,
        );
        expect(canPublish).toBe(false);
      });
    });

    describe('2.3 Super Admin Bypass & Inactive State', () => {
      it('SUPER_ADMIN bypasses all channel checks even if not a member and channel not queried', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
          id: superAdminUserId,
          systemRole: SystemRole.SUPER_ADMIN,
          isActive: true,
        });

        const perms = [
          ChannelPermission.CREATE_POST,
          ChannelPermission.APPROVE_POST,
          ChannelPermission.REJECT_POST,
          ChannelPermission.PUBLISH_POST,
          ChannelPermission.SCHEDULE_POST,
          ChannelPermission.DELETE_POST,
        ];

        for (const p of perms) {
          const allowed = await permissionService.checkChannelPermission(
            superAdminUserId,
            channelId,
            p,
          );
          expect(allowed).toBe(true);
        }

        // Verify channel and channelMember were never even queried
        expect(mockPrisma.channel.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.channelMember.findUnique).not.toHaveBeenCalled();
      });

      it('Deactivated SUPER_ADMIN (isActive: false) is strictly blocked from all operations', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
          id: superAdminUserId,
          systemRole: SystemRole.SUPER_ADMIN,
          isActive: false, // Banned / deactivated admin
        });

        const allowed = await permissionService.checkChannelPermission(
          superAdminUserId,
          channelId,
          ChannelPermission.APPROVE_POST,
        );
        expect(allowed).toBe(false);

        await expect(
          permissionService.enforceChannelPermission(
            superAdminUserId,
            channelId,
            ChannelPermission.APPROVE_POST,
          ),
        ).rejects.toThrow(PermissionDeniedException);

        // System permission also denied
        expect(
          await permissionService.checkSystemPermission(
            superAdminUserId,
            SystemPermission.MANAGE_USERS,
          ),
        ).toBe(false);
      });

      it('Normal user attempting SystemPermission must be rejected', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
          id: authorUserId,
          systemRole: SystemRole.USER,
          isActive: true,
        });

        expect(
          await permissionService.checkSystemPermission(
            authorUserId,
            SystemPermission.MANAGE_USERS,
          ),
        ).toBe(false);

        await expect(
          permissionService.enforceSystemPermission(
            authorUserId,
            SystemPermission.MANAGE_USERS,
          ),
        ).rejects.toThrow(PermissionDeniedException);
      });
    });

    describe('2.4 Post Edit Permissions (Ownership & Status Restrictions)', () => {
      beforeEach(() => {
        mockPrisma.user.findUnique.mockImplementation(({ where }: any) => {
          if (where.id === authorUserId) {
            return Promise.resolve({
              id: authorUserId,
              systemRole: SystemRole.USER,
              isActive: true,
            });
          }
          if (where.id === editorUserId) {
            return Promise.resolve({
              id: editorUserId,
              systemRole: SystemRole.USER,
              isActive: true,
            });
          }
          if (where.id === superAdminUserId) {
            return Promise.resolve({
              id: superAdminUserId,
              systemRole: SystemRole.SUPER_ADMIN,
              isActive: true,
            });
          }
          return Promise.resolve(null);
        });

        mockPrisma.channelMember.findUnique.mockImplementation(({ where }: any) => {
          const { userId } = where.channelId_userId;
          if (userId === authorUserId) {
            return Promise.resolve({ role: ChannelRole.AUTHOR });
          }
          if (userId === editorUserId) {
            return Promise.resolve({ role: ChannelRole.EDITOR });
          }
          return Promise.resolve(null);
        });
      });

      it('Author can edit own post in DRAFT or NEEDS_REVISION', async () => {
        // DRAFT
        expect(
          await permissionService.checkPostEditPermission(authorUserId, {
            authorId: authorUserId,
            channelId,
            status: PostStatus.DRAFT,
          }),
        ).toBe(true);

        // NEEDS_REVISION
        expect(
          await permissionService.checkPostEditPermission(authorUserId, {
            authorId: authorUserId,
            channelId,
            status: PostStatus.NEEDS_REVISION,
          }),
        ).toBe(true);
      });

      it('Author CANNOT edit own post in non-editable statuses (PENDING_REVIEW, APPROVED, SCHEDULED, PUBLISHED)', async () => {
        const nonEditableStatuses = [
          PostStatus.PENDING_REVIEW,
          PostStatus.APPROVED,
          PostStatus.SCHEDULED,
          PostStatus.PUBLISHING,
          PostStatus.PUBLISHED,
          PostStatus.REJECTED,
          PostStatus.CANCELLED,
          PostStatus.PUBLISH_FAILED,
        ];

        for (const status of nonEditableStatuses) {
          const allowed = await permissionService.checkPostEditPermission(authorUserId, {
            authorId: authorUserId,
            channelId,
            status,
          });
          expect(allowed).toBe(false);

          await expect(
            permissionService.enforcePostEditPermission(authorUserId, {
              authorId: authorUserId,
              channelId,
              status,
            }),
          ).rejects.toThrow(PermissionDeniedException);
        }
      });

      it('Author A CANNOT edit Author B post even in DRAFT', async () => {
        const allowed = await permissionService.checkPostEditPermission(authorUserId, {
          authorId: 'different-author-id',
          channelId,
          status: PostStatus.DRAFT,
        });
        expect(allowed).toBe(false);
      });

      it('Editor can edit any post in their channel across any status', async () => {
        expect(
          await permissionService.checkPostEditPermission(editorUserId, {
            authorId: authorUserId,
            channelId,
            status: PostStatus.PENDING_REVIEW,
          }),
        ).toBe(true);
      });

      it('Editor CANNOT edit a post in a channel they do not belong to', async () => {
        mockPrisma.channelMember.findUnique.mockResolvedValue(null);

        const allowed = await permissionService.checkPostEditPermission(editorUserId, {
          authorId: authorUserId,
          channelId: 'different-channel-id',
          status: PostStatus.DRAFT,
        });
        expect(allowed).toBe(false);
      });

      it('Super Admin can edit any post anywhere', async () => {
        expect(
          await permissionService.checkPostEditPermission(superAdminUserId, {
            authorId: authorUserId,
            channelId: 'any-channel',
            status: PostStatus.APPROVED,
          }),
        ).toBe(true);
      });
    });
  });

  // =========================================================================
  // Dimension 3: Timezones & Scheduling Stress-Testing
  // =========================================================================
  describe('3. Timezones & Scheduling Conversions', () => {
    // Reference now: 2026-09-21 10:00:00 UTC
    const fixedNowMs = new Date('2026-09-21T10:00:00.000Z').getTime();

    describe('3.1 Kyiv Summer (EEST, UTC+3) and Winter (EET, UTC+2) DST Conversions', () => {
      it('should convert Kyiv summer time (EEST, UTC+3) to exact UTC instant', () => {
        // September 21, 2026 18:30 Kyiv -> 15:30 UTC
        const input = '21.09.2026 18:30';
        const parsed = parseAndValidateScheduledDate(input, 'Europe/Kyiv', fixedNowMs);

        expect(parsed.toISOString()).toBe('2026-09-21T15:30:00.000Z');
        expect(parsed.getTime() - fixedNowMs).toBe(5.5 * 3600 * 1000); // 5.5 hours in future

        // Round-trip formatting
        const formatted = formatChannelDate(parsed, 'Europe/Kyiv');
        expect(formatted).toBe('21.09.2026 18:30');
      });

      it('should convert Kyiv winter time (EET, UTC+2) to exact UTC instant', () => {
        // January 15, 2027 18:30 Kyiv -> 16:30 UTC (UTC+2 in winter)
        const input = '15.01.2027 18:30';
        const parsed = parseAndValidateScheduledDate(input, 'Europe/Kyiv', fixedNowMs);

        expect(parsed.toISOString()).toBe('2027-01-15T16:30:00.000Z');

        // Round-trip formatting
        const formatted = formatChannelDate(parsed, 'Europe/Kyiv');
        expect(formatted).toBe('15.01.2027 18:30');
      });

      it('should verify DST spring-forward boundary for Europe/Kyiv (March 2026)', () => {
        // Spring forward in Kyiv in 2026 occurs on March 29 at 03:00 (clocks move forward to 04:00)
        // Use an anchor before March 2026 so scheduled dates are in the future relative to anchor
        const nowBeforeMarch2026 = new Date('2026-03-01T00:00:00.000Z').getTime();

        // Winter before transition (March 28, 2026 12:00 Kyiv, UTC+2) -> 10:00 UTC
        const winter = parseAndValidateScheduledDate('28.03.2026 12:00', 'Europe/Kyiv', nowBeforeMarch2026);
        expect(winter.toISOString()).toBe('2026-03-28T10:00:00.000Z');

        // Summer after transition (March 30, 2026 12:00 Kyiv, UTC+3) -> 09:00 UTC
        const summer = parseAndValidateScheduledDate('30.03.2026 12:00', 'Europe/Kyiv', nowBeforeMarch2026);
        expect(summer.toISOString()).toBe('2026-03-30T09:00:00.000Z');
      });

      it('should verify DST fall-back boundary for Europe/Kyiv (October 2026)', () => {
        // In 2026, fall back in Kyiv occurs on October 25 at 04:00 (clocks move back to 03:00)
        // Summer before transition (October 24, 2026 12:00 Kyiv, UTC+3) -> 09:00 UTC
        const summer = parseAndValidateScheduledDate('24.10.2026 12:00', 'Europe/Kyiv', fixedNowMs);
        expect(summer.toISOString()).toBe('2026-10-24T09:00:00.000Z');

        // Winter after transition (October 26, 2026 12:00 Kyiv, UTC+2) -> 10:00 UTC
        const winter = parseAndValidateScheduledDate('26.10.2026 12:00', 'Europe/Kyiv', fixedNowMs);
        expect(winter.toISOString()).toBe('2026-10-26T10:00:00.000Z');
      });

      it('should accurately handle non-Kyiv IANA timezones (e.g. America/New_York, Asia/Tokyo, UTC)', () => {
        // New York in September is EDT (UTC-4)
        // 21.09.2026 18:30 EDT -> 22:30 UTC
        const nyDate = parseAndValidateScheduledDate('21.09.2026 18:30', 'America/New_York', fixedNowMs);
        expect(nyDate.toISOString()).toBe('2026-09-21T22:30:00.000Z');
        expect(formatChannelDate(nyDate, 'America/New_York')).toBe('21.09.2026 18:30');

        // Tokyo is JST (UTC+9, no DST)
        // 22.09.2026 10:00 Tokyo -> 01:00 UTC
        const tokyoDate = parseAndValidateScheduledDate('22.09.2026 10:00', 'Asia/Tokyo', fixedNowMs);
        expect(tokyoDate.toISOString()).toBe('2026-09-22T01:00:00.000Z');
        expect(formatChannelDate(tokyoDate, 'Asia/Tokyo')).toBe('22.09.2026 10:00');

        // UTC
        const utcDate = parseAndValidateScheduledDate('21.09.2026 18:30', 'UTC', fixedNowMs);
        expect(utcDate.toISOString()).toBe('2026-09-21T18:30:00.000Z');
      });
    });

    describe('3.2 Past Date Rejection with User-Friendly Russian Error', () => {
      it('should reject dates in the past with exact Russian message', () => {
        // fixedNowMs is 2026-09-21 10:00 UTC = 13:00 Kyiv
        // 12:59 Kyiv = 09:59 UTC (1 minute in past)
        const pastInput = '21.09.2026 12:59';
        expect(() =>
          parseAndValidateScheduledDate(pastInput, 'Europe/Kyiv', fixedNowMs),
        ).toThrow(ValidationException);

        try {
          parseAndValidateScheduledDate(pastInput, 'Europe/Kyiv', fixedNowMs);
          fail('Should have thrown ValidationException');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ValidationException);
          expect(err.statusCode).toBe(400);
          expect(err.errorCode).toBe('VALIDATION_ERROR');
          expect(err.message).toBe('Нельзя планировать публикацию в прошлом.');
        }
      });

      it('should reject date exactly equal to nowMs', () => {
        // 13:00 Kyiv = 10:00 UTC = fixedNowMs
        const exactlyNowInput = '21.09.2026 13:00';
        expect(() =>
          parseAndValidateScheduledDate(exactlyNowInput, 'Europe/Kyiv', fixedNowMs),
        ).toThrow('Нельзя планировать публикацию в прошлом.');
      });

      it('should accept date in future (even 1 minute ahead)', () => {
        // 13:01 Kyiv = 10:01 UTC = 1 minute in future
        const futureInput = '21.09.2026 13:01';
        const parsed = parseAndValidateScheduledDate(futureInput, 'Europe/Kyiv', fixedNowMs);
        expect(parsed.toISOString()).toBe('2026-09-21T10:01:00.000Z');
      });
    });

    describe('3.3 Invalid IANA Timezones & Fallback Stress-Testing', () => {
      const invalidTimezones = [
        'Invalid/NonExistent_Zone',
        'Mars/Olympus_Mons',
        'Europe/FakeCity',
        'Not_A_Timezone',
        'GMT+99',
        '12345',
        '',
      ];

      it('IANAZone.isValidZone should discriminate valid and invalid zones', () => {
        for (const badZone of invalidTimezones) {
          expect(IANAZone.isValidZone(badZone)).toBe(false);
        }

        const validZones = ['Europe/Kyiv', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Warsaw'];
        for (const goodZone of validZones) {
          expect(IANAZone.isValidZone(goodZone)).toBe(true);
        }
      });

      it('parseAndValidateScheduledDate should safely fallback to Europe/Kyiv when given invalid timezone without throwing unexpected crash', () => {
        // If an invalid timezone is supplied, timezone.util safely falls back to DEFAULT_CHANNEL_TIMEZONE ('Europe/Kyiv')
        for (const badZone of invalidTimezones) {
          const parsed = parseAndValidateScheduledDate('21.09.2026 18:30', badZone, fixedNowMs);
          expect(parsed.toISOString()).toBe('2026-09-21T15:30:00.000Z'); // Uses Europe/Kyiv (UTC+3)
        }
      });

      it('formatChannelDate should safely fallback to Europe/Kyiv when given invalid timezone', () => {
        const utcDate = new Date('2026-09-21T15:30:00.000Z');
        for (const badZone of invalidTimezones) {
          const formatted = formatChannelDate(utcDate, badZone);
          expect(formatted).toBe('21.09.2026 18:30');
        }
      });

      it('ChannelsService should integrate with parseAndValidateScheduledDate via channel timezone', async () => {
        const mockPrisma: any = {
          channel: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'chan-kyiv',
              timezone: 'Europe/Kyiv',
            }),
          },
        };
        const mockAudit: any = { record: jest.fn() };
        const channelsService = new ChannelsService(mockPrisma, mockAudit);

        const futureYear = new Date().getFullYear() + 1;
        const date = await channelsService.parseAndValidateDate(`21.09.${futureYear} 18:30`, 'chan-kyiv');
        expect(date).toBeInstanceOf(Date);
        expect(mockPrisma.channel.findUnique).toHaveBeenCalledWith({ where: { id: 'chan-kyiv' } });
      });

      it('ChannelsService.parseAndValidateDate throws ChannelNotFoundException if channel does not exist', async () => {
        const mockPrisma: any = {
          channel: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        const mockAudit: any = { record: jest.fn() };
        const channelsService = new ChannelsService(mockPrisma, mockAudit);

        const futureYear = new Date().getFullYear() + 1;
        await expect(
          channelsService.parseAndValidateDate(`21.09.${futureYear} 18:30`, 'missing-chan'),
        ).rejects.toThrow(ChannelNotFoundException);
      });
    });
  });
});
