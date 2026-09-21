import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, LogLevel, NodeEnv, TelegramMode } from './environment.variables';

@Injectable()
export class EnvironmentConfigService {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  get nodeEnv(): NodeEnv {
    return this.configService.get('NODE_ENV', { infer: true }) ?? NodeEnv.DEVELOPMENT;
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.PRODUCTION;
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === NodeEnv.DEVELOPMENT;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.TEST;
  }

  get port(): number {
    return this.configService.get('PORT', { infer: true }) ?? 3000;
  }

  get databaseUrl(): string {
    return this.configService.get('DATABASE_URL', { infer: true });
  }

  get redisUrl(): string {
    return this.configService.get('REDIS_URL', { infer: true });
  }

  get botToken(): string {
    return this.configService.get('BOT_TOKEN', { infer: true });
  }

  get defaultTimezone(): string {
    return this.configService.get('DEFAULT_TIMEZONE', { infer: true }) ?? 'Europe/Kyiv';
  }

  get telegramMode(): TelegramMode {
    return this.configService.get('TELEGRAM_MODE', { infer: true }) ?? TelegramMode.POLLING;
  }

  get webhookDomain(): string | undefined {
    return this.configService.get('WEBHOOK_DOMAIN', { infer: true });
  }

  get webhookPath(): string {
    return this.configService.get('WEBHOOK_PATH', { infer: true }) ?? '/telegram/webhook';
  }

  get webhookSecretToken(): string | undefined {
    return this.configService.get('WEBHOOK_SECRET_TOKEN', { infer: true });
  }

  get logLevel(): LogLevel {
    return this.configService.get('LOG_LEVEL', { infer: true }) ?? LogLevel.INFO;
  }

  get initialSuperAdminTelegramId(): bigint {
    const raw = this.configService.get('INITIAL_SUPER_ADMIN_TELEGRAM_ID', { infer: true });
    return BigInt(raw ?? '123456789');
  }

  get defaultChannelChatId(): string {
    return this.configService.get('DEFAULT_CHANNEL_CHAT_ID', { infer: true }) ?? '-1001234567890';
  }
}
