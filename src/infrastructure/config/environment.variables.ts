import 'reflect-metadata';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export enum NodeEnv {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}

export enum TelegramMode {
  POLLING = 'polling',
  WEBHOOK = 'webhook',
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv, {
    message: 'NODE_ENV must be one of: development, production, test',
  })
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.DEVELOPMENT;

  @IsInt({ message: 'PORT must be an integer' })
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL is required' })
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL must be a valid PostgreSQL connection string starting with postgresql:// or postgres://',
  })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'REDIS_URL is required' })
  @Matches(/^rediss?:\/\/.+/, {
    message: 'REDIS_URL must be a valid Redis connection string starting with redis:// or rediss://',
  })
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'BOT_TOKEN is required' })
  @Matches(/^\d+:[A-Za-z0-9_-]{35,}$/, {
    message: 'BOT_TOKEN must follow the standard Telegram Bot API token format (e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)',
  })
  BOT_TOKEN!: string;

  @IsString()
  @IsNotEmpty({ message: 'DEFAULT_TIMEZONE is required' })
  DEFAULT_TIMEZONE: string = 'Europe/Kyiv';

  @IsEnum(TelegramMode, {
    message: 'TELEGRAM_MODE must be either "polling" or "webhook"',
  })
  @IsOptional()
  TELEGRAM_MODE: TelegramMode = TelegramMode.POLLING;

  @IsString()
  @IsOptional()
  WEBHOOK_DOMAIN?: string;

  @IsString()
  @IsOptional()
  WEBHOOK_PATH: string = '/telegram/webhook';

  @IsString()
  @IsOptional()
  WEBHOOK_SECRET_TOKEN?: string;

  @IsEnum(LogLevel, {
    message: 'LOG_LEVEL must be one of: error, warn, info, debug, verbose',
  })
  @IsOptional()
  LOG_LEVEL: LogLevel = LogLevel.INFO;

  @IsString()
  @IsOptional()
  INITIAL_SUPER_ADMIN_TELEGRAM_ID?: string;

  @IsString()
  @IsOptional()
  DEFAULT_CHANNEL_CHAT_ID?: string;
}
