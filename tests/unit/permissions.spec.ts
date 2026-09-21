import 'reflect-metadata';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { SystemRole, ChannelRole, PostStatus, ChannelPermission } from '../../src/common/enums';
import { PermissionDeniedException } from '../../src/common/exceptions/domain.exceptions';

describe('PermissionService & RBAC Unit Tests', () => {
  let permissionService: PermissionService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      channel: {
        findUnique: jest.fn(),
      },
      channelMember: {
        findUnique: jest.fn(),
      },
    };

    permissionService = new PermissionService(mockPrisma as any);
  });

  describe('checkChannelPermission & SUPER_ADMIN Bypass', () => {
    it('should deny permission when actor is not found or inactive', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: false });

      const allowed = await permissionService.checkChannelPermission('u1', 'c1', ChannelPermission.CREATE_POST);
      expect(allowed).toBe(false);
    });

    it('should allow SUPER_ADMIN unconditional bypass for any channel permission', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        systemRole: SystemRole.SUPER_ADMIN,
        isActive: true,
      });

      const allowed = await permissionService.checkChannelPermission(
        'admin-1',
        'c1',
        ChannelPermission.APPROVE_POST,
      );
      expect(allowed).toBe(true);
      // Notice channel query is bypassed
      expect(mockPrisma.channel.findUnique).not.toHaveBeenCalled();
    });

    it('should deny permission if channel does not exist or is inactive', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        systemRole: SystemRole.USER,
        isActive: true,
      });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'c1', isActive: false });

      const allowed = await permissionService.checkChannelPermission('u1', 'c1', ChannelPermission.CREATE_POST);
      expect(allowed).toBe(false);
    });

    it('should deny permission if user is not a member of the channel', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        systemRole: SystemRole.USER,
        isActive: true,
      });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'c1', isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue(null);

      const allowed = await permissionService.checkChannelPermission('u1', 'c1', ChannelPermission.CREATE_POST);
      expect(allowed).toBe(false);
    });

    it('should allow AUTHOR to CREATE_POST and SUBMIT_REVIEW, but deny APPROVE_POST', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'author-1', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'c1', isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({
        role: ChannelRole.AUTHOR,
        canPublish: false,
        canApprove: false,
      });

      expect(
        await permissionService.checkChannelPermission('author-1', 'c1', ChannelPermission.CREATE_POST),
      ).toBe(true);
      expect(
        await permissionService.checkChannelPermission('author-1', 'c1', ChannelPermission.SUBMIT_REVIEW),
      ).toBe(true);
      expect(
        await permissionService.checkChannelPermission('author-1', 'c1', ChannelPermission.APPROVE_POST),
      ).toBe(false);
      expect(
        await permissionService.checkChannelPermission('author-1', 'c1', ChannelPermission.PUBLISH_POST),
      ).toBe(false);
    });

    it('should allow EDITOR with canApprove to APPROVE, REJECT, and REQUEST_REVISION', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'ed-1', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'c1', isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({
        role: ChannelRole.EDITOR,
        canPublish: true,
        canApprove: true,
      });

      expect(
        await permissionService.checkChannelPermission('ed-1', 'c1', ChannelPermission.APPROVE_POST),
      ).toBe(true);
      expect(
        await permissionService.checkChannelPermission('ed-1', 'c1', ChannelPermission.REJECT_POST),
      ).toBe(true);
      expect(
        await permissionService.checkChannelPermission('ed-1', 'c1', ChannelPermission.REQUEST_REVISION),
      ).toBe(true);
      expect(
        await permissionService.checkChannelPermission('ed-1', 'c1', ChannelPermission.PUBLISH_POST),
      ).toBe(true);
    });

    it('should throw PermissionDeniedException on enforceChannelPermission if denied', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'c1', isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({
        role: ChannelRole.VIEWER,
        canPublish: false,
        canApprove: false,
      });

      await expect(
        permissionService.enforceChannelPermission('u1', 'c1', ChannelPermission.CREATE_POST),
      ).rejects.toThrow(PermissionDeniedException);
    });
  });

  describe('Post Edit Ownership Rules (checkPostEditPermission)', () => {
    it('should allow SUPER_ADMIN to edit any post regardless of channel membership', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'adm', systemRole: SystemRole.SUPER_ADMIN, isActive: true });

      const allowed = await permissionService.checkPostEditPermission('adm', {
        authorId: 'other-user',
        channelId: 'c1',
        status: PostStatus.APPROVED,
      });
      expect(allowed).toBe(true);
    });

    it('should allow EDITOR to edit any post in their channel', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'ed', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({ role: ChannelRole.EDITOR });

      const allowed = await permissionService.checkPostEditPermission('ed', {
        authorId: 'other-user',
        channelId: 'c1',
        status: PostStatus.PENDING_REVIEW,
      });
      expect(allowed).toBe(true);
    });

    it('should allow AUTHOR to edit own post only when in DRAFT or NEEDS_REVISION status', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'author-1', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({ role: ChannelRole.AUTHOR });

      // Own post in DRAFT
      expect(
        await permissionService.checkPostEditPermission('author-1', {
          authorId: 'author-1',
          channelId: 'c1',
          status: PostStatus.DRAFT,
        }),
      ).toBe(true);

      // Own post in NEEDS_REVISION
      expect(
        await permissionService.checkPostEditPermission('author-1', {
          authorId: 'author-1',
          channelId: 'c1',
          status: PostStatus.NEEDS_REVISION,
        }),
      ).toBe(true);

      // Own post in PENDING_REVIEW (frozen during review!)
      expect(
        await permissionService.checkPostEditPermission('author-1', {
          authorId: 'author-1',
          channelId: 'c1',
          status: PostStatus.PENDING_REVIEW,
        }),
      ).toBe(false);

      // Own post in APPROVED (cannot edit after approval)
      expect(
        await permissionService.checkPostEditPermission('author-1', {
          authorId: 'author-1',
          channelId: 'c1',
          status: PostStatus.APPROVED,
        }),
      ).toBe(false);
    });

    it('should forbid Author A from editing Author B post', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'author-A', systemRole: SystemRole.USER, isActive: true });
      mockPrisma.channelMember.findUnique.mockResolvedValue({ role: ChannelRole.AUTHOR });

      const allowed = await permissionService.checkPostEditPermission('author-A', {
        authorId: 'author-B',
        channelId: 'c1',
        status: PostStatus.DRAFT,
      });
      expect(allowed).toBe(false);

      await expect(
        permissionService.enforcePostEditPermission('author-A', {
          authorId: 'author-B',
          channelId: 'c1',
          status: PostStatus.DRAFT,
        }),
      ).rejects.toThrow(PermissionDeniedException);
    });
  });
});
