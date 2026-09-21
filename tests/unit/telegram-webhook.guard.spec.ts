import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { TelegramWebhookGuard } from '../../src/modules/telegram/guards/telegram-webhook.guard';
import { EnvironmentConfigService } from '../../src/infrastructure/config/environment-config.service';

describe('TelegramWebhookGuard', () => {
  let guard: TelegramWebhookGuard;
  let config: jest.Mocked<Partial<EnvironmentConfigService>>;

  const createMockContext = (headerToken?: string): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: headerToken
            ? { 'x-telegram-bot-api-secret-token': headerToken }
            : {},
        }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should allow access if webhookSecretToken is not configured', () => {
    config = { webhookSecretToken: undefined };
    guard = new TelegramWebhookGuard(config as EnvironmentConfigService);

    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if secret token matches configured token', () => {
    config = { webhookSecretToken: 'super-secret-token-12345' };
    guard = new TelegramWebhookGuard(config as EnvironmentConfigService);

    const context = createMockContext('super-secret-token-12345');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw UnauthorizedException if header is missing', () => {
    config = { webhookSecretToken: 'super-secret-token-12345' };
    guard = new TelegramWebhookGuard(config as EnvironmentConfigService);

    const context = createMockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException if token does not match', () => {
    config = { webhookSecretToken: 'super-secret-token-12345' };
    guard = new TelegramWebhookGuard(config as EnvironmentConfigService);

    const context = createMockContext('wrong-secret-token');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException if token length differs', () => {
    config = { webhookSecretToken: 'super-secret-token-12345' };
    guard = new TelegramWebhookGuard(config as EnvironmentConfigService);

    const context = createMockContext('short');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
