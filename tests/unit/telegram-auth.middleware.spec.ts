import { TelegramAuthMiddleware } from '../../src/modules/telegram/middlewares/telegram-auth.middleware';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UserDeactivatedException } from '../../src/common/exceptions/domain.exceptions';
import { SystemRole, ChannelRole, ChannelPermission } from '../../src/common/enums';
import { BotContext } from '../../src/modules/telegram/interfaces/bot-context.interface';

describe('TelegramAuthMiddleware', () => {
  let middleware: TelegramAuthMiddleware;
  let authService: jest.Mocked<Partial<AuthService>>;

  beforeEach(() => {
    authService = {
      resolveUser: jest.fn(),
    };
    middleware = new TelegramAuthMiddleware(authService as unknown as AuthService);
  });

  it('should ignore updates without a sender (e.g. channel post)', async () => {
    const ctx = { from: undefined } as unknown as BotContext;
    const next = jest.fn();

    await middleware.create()(ctx, next);

    expect(authService.resolveUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject unregistered users with prompt containing their Telegram ID and halt propagation', async () => {
    const ctx = {
      from: { id: 123456789, username: 'testuser' },
      requestId: 'req-1',
      reply: jest.fn(),
    } as unknown as BotContext;
    const next = jest.fn();

    authService.resolveUser = jest.fn().mockResolvedValue(null);

    await middleware.create()(ctx, next);

    expect(authService.resolveUser).toHaveBeenCalledWith(BigInt(123456789));
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('123456789'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('У вас пока нет доступа к редакции'),
      expect.anything(),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should answer callback query with alert for unregistered users on callback query update', async () => {
    const ctx = {
      from: { id: 987654321, username: 'testuser' },
      requestId: 'req-2',
      callbackQuery: { id: 'cb-1' },
      answerCallbackQuery: jest.fn(),
    } as unknown as BotContext;
    const next = jest.fn();

    authService.resolveUser = jest.fn().mockResolvedValue(null);

    await middleware.create()(ctx, next);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'У вас пока нет доступа к редакции. Обратитесь к администратору.',
      show_alert: true,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject deactivated users with Russian prompt when UserDeactivatedException is thrown', async () => {
    const ctx = {
      from: { id: 111222333, username: 'deactivated_user' },
      requestId: 'req-3',
      reply: jest.fn(),
    } as unknown as BotContext;
    const next = jest.fn();

    authService.resolveUser = jest
      .fn()
      .mockRejectedValue(new UserDeactivatedException(BigInt(111222333)));

    await middleware.create()(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Ваш аккаунт деактивирован'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('111222333'),
      expect.anything(),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should enrich BotContext and call next for active authenticated user', async () => {
    const ctx = {
      from: { id: 555666777, username: 'author1' },
      requestId: 'req-4',
    } as unknown as BotContext;
    const next = jest.fn();

    const mockAuthUser = {
      id: 'user-uuid-1',
      telegramId: BigInt(555666777),
      systemRole: SystemRole.USER,
      channelMemberships: [
        {
          channelId: 'channel-1',
          role: ChannelRole.AUTHOR,
          canPublish: false,
          canApprove: false,
        },
      ],
    };

    authService.resolveUser = jest.fn().mockResolvedValue(mockAuthUser);

    await middleware.create()(ctx, next);

    expect(ctx.authUser).toEqual(mockAuthUser);
    expect(ctx.isSuperAdmin).toBe(false);
    expect(ctx.canChannel(ChannelPermission.PUBLISH_POST, 'channel-1')).toBe(false);
    expect(ctx.canChannel(ChannelPermission.CREATE_POST, 'channel-1')).toBe(true);
    expect(ctx.canChannel(ChannelPermission.CREATE_POST, 'unknown-channel')).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should grant all channel permissions when user is SUPER_ADMIN', async () => {
    const ctx = {
      from: { id: 999999999, username: 'admin' },
      requestId: 'req-5',
    } as unknown as BotContext;
    const next = jest.fn();

    const mockAdminUser = {
      id: 'admin-uuid-1',
      telegramId: BigInt(999999999),
      systemRole: SystemRole.SUPER_ADMIN,
      channelMemberships: [],
    };

    authService.resolveUser = jest.fn().mockResolvedValue(mockAdminUser);

    await middleware.create()(ctx, next);

    expect(ctx.isSuperAdmin).toBe(true);
    expect(ctx.canChannel(ChannelPermission.PUBLISH_POST, 'any-channel')).toBe(true);
    expect(ctx.canChannel(ChannelPermission.APPROVE_POST, 'any-channel')).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
