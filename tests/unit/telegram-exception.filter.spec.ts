import { TelegramExceptionFilter } from '../../src/modules/telegram/filters/telegram-exception.filter';
import {
  UnauthorizedUserException,
  UserDeactivatedException,
  PermissionDeniedException,
  PostConflictException,
  IdempotencyConflictException,
  InvalidPostStateTransitionException,
  ValidationException,
  PostNotFoundException,
  ChannelNotFoundException,
  TemplateNotFoundException,
} from '../../src/common/exceptions/domain.exceptions';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../src/infrastructure/telegram-api/errors/telegram-api.exceptions';
import { PostStatus, ChannelPermission } from '../../src/common/enums';
import { BotContext } from '../../src/modules/telegram/interfaces/bot-context.interface';

describe('TelegramExceptionFilter', () => {
  let filter: TelegramExceptionFilter;

  beforeEach(() => {
    filter = new TelegramExceptionFilter();
  });

  it('should catch UnauthorizedUserException and answer callback query with alert', async () => {
    const ctx = {
      requestId: 'test-req',
      callbackQuery: { id: 'cb-1' },
      answerCallbackQuery: jest.fn(),
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest.fn().mockRejectedValue(new UnauthorizedUserException(123n));
    await filter.create()(ctx, next);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('У вас пока нет доступа к редакции'),
      show_alert: true,
    });
  });

  it('should catch PostConflictException and alert user about concurrent edit', async () => {
    const ctx = {
      requestId: 'test-req',
      callbackQuery: { id: 'cb-2' },
      answerCallbackQuery: jest.fn(),
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest
      .fn()
      .mockRejectedValue(new PostConflictException('post-1', 1, 2));
    await filter.create()(ctx, next);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('Публикация была изменена другим пользователем'),
      show_alert: true,
    });
  });

  it('should catch PermissionDeniedException and alert user', async () => {
    const ctx = {
      requestId: 'test-req',
      callbackQuery: { id: 'cb-3' },
      answerCallbackQuery: jest.fn(),
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest
      .fn()
      .mockRejectedValue(new PermissionDeniedException(ChannelPermission.PUBLISH_POST, 'ch-1'));
    await filter.create()(ctx, next);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('Недостаточно прав'),
      show_alert: true,
    });
  });

  it('should catch ValidationException and reply to chat when not in callback', async () => {
    const ctx = {
      requestId: 'test-req',
      chat: { id: 12345 },
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest
      .fn()
      .mockRejectedValue(new ValidationException('Поле «Заголовок» обязательно'));
    await filter.create()(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Поле «Заголовок» обязательно'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('should catch RateLimitException and alert user', async () => {
    const ctx = {
      requestId: 'test-req',
      callbackQuery: { id: 'cb-4' },
      answerCallbackQuery: jest.fn(),
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest
      .fn()
      .mockRejectedValue(new TelegramRateLimitException('Too Many Requests', 5));
    await filter.create()(ctx, next);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('Превышен лимит запросов к Telegram'),
      show_alert: true,
    });
  });

  it('should catch generic Error and send friendly Russian error message', async () => {
    const ctx = {
      requestId: 'test-req',
      chat: { id: 12345 },
      reply: jest.fn(),
    } as unknown as BotContext;

    const next = jest.fn().mockRejectedValue(new Error('Unexpected DB timeout'));
    await filter.create()(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Произошла непредвиденная ошибка'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });
});
