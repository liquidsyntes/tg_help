import 'reflect-metadata';
import { validateEnvironment } from '../../src/infrastructure/config/environment.validation';
import { TelegramMode, NodeEnv } from '../../src/infrastructure/config/environment.variables';

describe('Config Module & Environment Validation Unit Tests', () => {
  const validBaseConfig = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public',
    REDIS_URL: 'redis://127.0.0.1:6379',
    BOT_TOKEN: '123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11',
    DEFAULT_TIMEZONE: 'Europe/Kyiv',
    TELEGRAM_MODE: 'polling',
  };

  it('should successfully validate a complete and correct environment config', () => {
    const validated = validateEnvironment(validBaseConfig);
    expect(validated).toBeDefined();
    expect(validated.NODE_ENV).toBe(NodeEnv.DEVELOPMENT);
    expect(validated.PORT).toBe(3000);
    expect(validated.DATABASE_URL).toBe(validBaseConfig.DATABASE_URL);
    expect(validated.REDIS_URL).toBe(validBaseConfig.REDIS_URL);
    expect(validated.BOT_TOKEN).toBe(validBaseConfig.BOT_TOKEN);
    expect(validated.DEFAULT_TIMEZONE).toBe('Europe/Kyiv');
    expect(validated.TELEGRAM_MODE).toBe(TelegramMode.POLLING);
  });

  it('should apply defaults when optional values are omitted', () => {
    const minimalConfig = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      BOT_TOKEN: '123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11',
    };

    const validated = validateEnvironment(minimalConfig);
    expect(validated.PORT).toBe(3000);
    expect(validated.DEFAULT_TIMEZONE).toBe('Europe/Kyiv');
    expect(validated.TELEGRAM_MODE).toBe(TelegramMode.POLLING);
    expect(validated.NODE_ENV).toBe(NodeEnv.DEVELOPMENT);
  });

  it('should throw when DATABASE_URL is missing', () => {
    const invalid = { ...validBaseConfig, DATABASE_URL: undefined };
    expect(() => validateEnvironment(invalid)).toThrow(/DATABASE_URL is required/);
  });

  it('should throw when DATABASE_URL is not a valid postgres connection string', () => {
    const invalid = { ...validBaseConfig, DATABASE_URL: 'mysql://user:pass@localhost/db' };
    expect(() => validateEnvironment(invalid)).toThrow(/DATABASE_URL must be a valid PostgreSQL/);
  });

  it('should throw when REDIS_URL is missing', () => {
    const invalid = { ...validBaseConfig, REDIS_URL: undefined };
    expect(() => validateEnvironment(invalid)).toThrow(/REDIS_URL is required/);
  });

  it('should throw when BOT_TOKEN does not match Telegram Bot API token format', () => {
    const invalid = { ...validBaseConfig, BOT_TOKEN: 'invalid-token' };
    expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
  });

  it('should throw when DEFAULT_TIMEZONE is not a valid IANA timezone', () => {
    const invalid = { ...validBaseConfig, DEFAULT_TIMEZONE: 'Invalid/NonExistent_Zone' };
    expect(() => validateEnvironment(invalid)).toThrow(/not a valid IANA timezone/);
  });

  it('should throw when TELEGRAM_MODE is webhook but WEBHOOK_DOMAIN is missing', () => {
    const invalid = {
      ...validBaseConfig,
      TELEGRAM_MODE: 'webhook',
      WEBHOOK_DOMAIN: '',
    };
    expect(() => validateEnvironment(invalid)).toThrow(/WEBHOOK_DOMAIN is strictly required when TELEGRAM_MODE is set to "webhook"/);
  });
});
