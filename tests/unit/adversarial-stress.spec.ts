import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { validateEnvironment } from '../../src/infrastructure/config/environment.validation';
import { TelegramMode, NodeEnv } from '../../src/infrastructure/config/environment.variables';
import { HealthController } from '../../src/modules/health/health.controller';
import { HealthService } from '../../src/modules/health/health.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { StructuredLoggerService } from '../../src/infrastructure/logger/structured-logger.service';

describe('Empirical Challenger: Adversarial Stress Tests (Milestone 1)', () => {
  const validBaseConfig = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://tghelp:tghelp_pass@127.0.0.1:5432/tghelp?schema=public',
    REDIS_URL: 'redis://127.0.0.1:6379',
    BOT_TOKEN: '123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11',
    DEFAULT_TIMEZONE: 'Europe/Kyiv',
    TELEGRAM_MODE: 'polling',
  };

  // ============================================================================
  // AREA 1: validateEnvironment Stress & Security Leaks
  // ============================================================================
  describe('Area 1: Environment Validation & Secret Leakage Prevention', () => {
    describe('1.1 BOT_TOKEN Syntax & Boundary Validation', () => {
      it('should reject BOT_TOKEN containing letters in the bot ID part', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: 'abc12345:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
      });

      it('should reject BOT_TOKEN missing colon separator', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: '123456789AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK11' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
      });

      it('should reject BOT_TOKEN with secret part shorter than 35 characters', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: '123456789:SHORT_SECRET_ONLY_20_CHARS' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
      });

      it('should reject BOT_TOKEN containing invalid characters (spaces, special symbols)', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: '123456789:AAABBBCCC DDD EEE!@#$%^&*()1234567' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
      });

      it('should reject BOT_TOKEN with empty bot ID before colon', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: ':AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK111111' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN must follow the standard Telegram Bot API token format/);
      });

      it('should reject empty string BOT_TOKEN', () => {
        const invalid = { ...validBaseConfig, BOT_TOKEN: '' };
        expect(() => validateEnvironment(invalid)).toThrow(/BOT_TOKEN is required/);
      });

      it('should accept valid BOT_TOKEN with 35+ alphanumeric, underscore, hyphen chars', () => {
        const valid = { ...validBaseConfig, BOT_TOKEN: '9876543210:ABC-DEF_ghi-jkl_MNO-pqr_STU-vwx_YZ01234' };
        const result = validateEnvironment(valid);
        expect(result.BOT_TOKEN).toBe('9876543210:ABC-DEF_ghi-jkl_MNO-pqr_STU-vwx_YZ01234');
      });
    });

    describe('1.2 Timezone Validation against IANA Registry', () => {
      const invalidZones = [
        'Invalid/Timezone',
        'GMT+99',
        'Mars/Olympus_Mons',
        'Europe/FakeCity',
        'Not/A/Timezone',
        'KYIV_WITHOUT_CONTINENT',
        'UTC+05:00',
      ];

      invalidZones.forEach((zone) => {
        it(`should reject non-IANA timezone: "${zone}"`, () => {
          const invalid = { ...validBaseConfig, DEFAULT_TIMEZONE: zone };
          expect(() => validateEnvironment(invalid)).toThrow(/is not a valid IANA timezone name/);
        });
      });

      const validZones = [
        'Europe/Kyiv',
        'UTC',
        'America/New_York',
        'Asia/Tokyo',
        'Europe/London',
      ];

      validZones.forEach((zone) => {
        it(`should accept standard IANA timezone: "${zone}"`, () => {
          const valid = { ...validBaseConfig, DEFAULT_TIMEZONE: zone };
          const res = validateEnvironment(valid);
          expect(res.DEFAULT_TIMEZONE).toBe(zone);
        });
      });
    });

    describe('1.3 Port Range & Type Boundaries', () => {
      it('should reject PORT: 0 (less than Min(1))', () => {
        const invalid = { ...validBaseConfig, PORT: '0' };
        expect(() => validateEnvironment(invalid)).toThrow(/PORT must not be less than 1/);
      });

      it('should reject negative PORT', () => {
        const invalid = { ...validBaseConfig, PORT: '-80' };
        expect(() => validateEnvironment(invalid)).toThrow(/PORT must not be less than 1/);
      });

      it('should reject PORT: 65536 (greater than Max(65535))', () => {
        const invalid = { ...validBaseConfig, PORT: '65536' };
        expect(() => validateEnvironment(invalid)).toThrow(/PORT must not be greater than 65535/);
      });

      it('should reject non-numeric PORT', () => {
        const invalid = { ...validBaseConfig, PORT: 'eight-thousand' };
        expect(() => validateEnvironment(invalid)).toThrow(/PORT must be an integer/);
      });

      it('should reject decimal PORT', () => {
        const invalid = { ...validBaseConfig, PORT: '3000.5' };
        expect(() => validateEnvironment(invalid)).toThrow(/PORT must be an integer/);
      });

      it('should accept valid boundary ports (1 and 65535)', () => {
        const p1 = validateEnvironment({ ...validBaseConfig, PORT: '1' });
        expect(p1.PORT).toBe(1);

        const p65535 = validateEnvironment({ ...validBaseConfig, PORT: '65535' });
        expect(p65535.PORT).toBe(65535);
      });
    });

    describe('1.4 Missing Required Variables', () => {
      it('should throw when DATABASE_URL is missing', () => {
        const { DATABASE_URL, ...rest } = validBaseConfig;
        expect(() => validateEnvironment(rest)).toThrow(/DATABASE_URL is required/);
      });

      it('should throw when REDIS_URL is missing', () => {
        const { REDIS_URL, ...rest } = validBaseConfig;
        expect(() => validateEnvironment(rest)).toThrow(/REDIS_URL is required/);
      });

      it('should throw when BOT_TOKEN is missing', () => {
        const { BOT_TOKEN, ...rest } = validBaseConfig;
        expect(() => validateEnvironment(rest)).toThrow(/BOT_TOKEN is required/);
      });
    });

    describe('1.5 Security: Zero Secret Leakage in Validation Errors', () => {
      it('should NEVER leak invalid BOT_TOKEN contents in validation error message', () => {
        const secretTokenValue = 'super_secret_bot_token_do_not_leak_me';
        const invalid = {
          ...validBaseConfig,
          BOT_TOKEN: `invalid:${secretTokenValue}`,
        };

        try {
          validateEnvironment(invalid);
          fail('Should have thrown configuration error');
        } catch (error: unknown) {
          const message = (error as Error).message;
          expect(message).toContain('[FATAL CONFIGURATION ERROR]');
          expect(message).toContain('[BOT_TOKEN]');
          // Verify secret value is NOT in the error string
          expect(message).not.toContain(secretTokenValue);
        }
      });

      it('should NEVER leak database passwords in validation error message on invalid DB URL', () => {
        const secretDbPassword = 'my_super_confidential_postgres_password_98765';
        const invalid = {
          ...validBaseConfig,
          DATABASE_URL: `mysql://admin:${secretDbPassword}@10.0.0.1:3306/db`,
        };

        try {
          validateEnvironment(invalid);
          fail('Should have thrown configuration error');
        } catch (error: unknown) {
          const message = (error as Error).message;
          expect(message).toContain('[DATABASE_URL]');
          expect(message).not.toContain(secretDbPassword);
          expect(message).not.toContain('mysql://admin');
        }
      });

      it('should NEVER leak redis credentials in validation error message on invalid Redis URL', () => {
        const secretRedisPassword = 'my_confidential_redis_auth_token_54321';
        const invalid = {
          ...validBaseConfig,
          REDIS_URL: `http://default:${secretRedisPassword}@10.0.0.2:6379`,
        };

        try {
          validateEnvironment(invalid);
          fail('Should have thrown configuration error');
        } catch (error: unknown) {
          const message = (error as Error).message;
          expect(message).toContain('[REDIS_URL]');
          expect(message).not.toContain(secretRedisPassword);
        }
      });

      it('should NEVER leak WEBHOOK_SECRET_TOKEN in validation error when another field fails', () => {
        const secretWebhookToken = 'my_webhook_secret_hmac_signature_key_99999';
        const invalid = {
          ...validBaseConfig,
          WEBHOOK_SECRET_TOKEN: secretWebhookToken,
          PORT: 'not-a-port',
        };

        try {
          validateEnvironment(invalid);
          fail('Should have thrown configuration error');
        } catch (error: unknown) {
          const message = (error as Error).message;
          expect(message).toContain('[PORT]');
          expect(message).not.toContain(secretWebhookToken);
        }
      });
    });

    describe('1.6 Webhook Mode Requirements', () => {
      it('should reject webhook mode without WEBHOOK_DOMAIN', () => {
        const invalid = {
          ...validBaseConfig,
          TELEGRAM_MODE: 'webhook',
          WEBHOOK_DOMAIN: undefined,
        };
        expect(() => validateEnvironment(invalid)).toThrow(/WEBHOOK_DOMAIN is strictly required/);
      });

      it('should reject webhook mode with whitespace-only WEBHOOK_DOMAIN', () => {
        const invalid = {
          ...validBaseConfig,
          TELEGRAM_MODE: 'webhook',
          WEBHOOK_DOMAIN: '   ',
        };
        expect(() => validateEnvironment(invalid)).toThrow(/WEBHOOK_DOMAIN is strictly required/);
      });

      it('should accept valid webhook configuration with domain', () => {
        const valid = {
          ...validBaseConfig,
          TELEGRAM_MODE: 'webhook',
          WEBHOOK_DOMAIN: 'publisher.example.com',
          WEBHOOK_SECRET_TOKEN: 'secure_secret_token_123',
        };
        const res = validateEnvironment(valid);
        expect(res.TELEGRAM_MODE).toBe(TelegramMode.WEBHOOK);
        expect(res.WEBHOOK_DOMAIN).toBe('publisher.example.com');
      });
    });
  });

  // ============================================================================
  // AREA 2: Health and Readiness Probes Stress & Outage Handling
  // ============================================================================
  describe('Area 2: /health and /ready Probes Robustness & Outage Handling', () => {
    let healthService: HealthService;
    let controller: HealthController;
    let mockPrisma: Partial<PrismaService>;
    let mockRedis: Partial<RedisService>;

    beforeEach(() => {
      mockPrisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
      };
      mockRedis = {
        ping: jest.fn().mockResolvedValue('PONG'),
      };
      healthService = new HealthService(mockPrisma as PrismaService, mockRedis as RedisService);
      controller = new HealthController(healthService);
    });

    it('Liveness (/health) should NEVER call DB or Redis and return 200 OK', () => {
      const live = controller.getHealth();
      expect(live.status).toBe('ok');
      expect(typeof live.uptime).toBe('number');
      expect(live.uptime).toBeGreaterThanOrEqual(0);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockRedis.ping).not.toHaveBeenCalled();
    });

    it('Readiness (/ready) should return 200 OK when both DB and Redis are up', async () => {
      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);

      expect(ready.status).toBe('ok');
      expect(ready.checks.database).toBe('up');
      expect(ready.checks.redis).toBe('up');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.OK);
    });

    it('Readiness (/ready) should return 503 Service Unavailable when Database is down', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);

      expect(ready.status).toBe('down');
      expect(ready.checks.database).toBe('down');
      expect(ready.checks.redis).toBe('up');
      expect(ready.errors?.database).toContain('Connection terminated unexpectedly');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('Readiness (/ready) should return 503 Service Unavailable when Redis is down', async () => {
      (mockRedis.ping as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);

      expect(ready.status).toBe('down');
      expect(ready.checks.database).toBe('up');
      expect(ready.checks.redis).toBe('down');
      expect(ready.errors?.redis).toContain('ECONNREFUSED 127.0.0.1:6379');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('Readiness (/ready) should return 503 when Redis returns unexpected response', async () => {
      (mockRedis.ping as jest.Mock).mockResolvedValueOnce('LOADING Redis is loading the dataset');

      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);

      expect(ready.status).toBe('down');
      expect(ready.checks.redis).toBe('down');
      expect(ready.errors?.redis).toContain('Unexpected ping response');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('Readiness (/ready) should return 503 when BOTH Database and Redis are down', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('PostgreSQL cluster down'));
      (mockRedis.ping as jest.Mock).mockRejectedValueOnce(new Error('Redis cluster down'));

      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);

      expect(ready.status).toBe('down');
      expect(ready.checks.database).toBe('down');
      expect(ready.checks.redis).toBe('down');
      expect(ready.errors?.database).toBe('PostgreSQL cluster down');
      expect(ready.errors?.redis).toBe('Redis cluster down');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('Readiness (/ready) timeout handling: DB hanging exceeds 2500ms timeout', async () => {
      // Simulate hanging DB query that never resolves
      (mockPrisma.$queryRaw as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      // Fast-forward or use short timeout test
      // In health.service.ts, the timeout is capped at 2500ms
      const startTime = Date.now();
      const mockRes = { status: jest.fn().mockReturnThis() } as unknown as Response;
      const ready = await controller.getReady(mockRes);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(2400);
      expect(elapsed).toBeLessThan(4000);
      expect(ready.status).toBe('down');
      expect(ready.checks.database).toBe('down');
      expect(ready.errors?.database).toContain('Database ping timeout after 2500ms');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    }, 10000);
  });

  // ============================================================================
  // AREA 3: BigInt Serialization in Prisma & System Layers
  // ============================================================================
  describe('Area 3: BigInt Serialization Challenge', () => {
    beforeAll(() => {
      // Ensure PrismaService polyfill is executed
      new PrismaService();
    });

    it('should serialize standard 64-bit Telegram user ID without throwing', () => {
      const user = {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        telegramId: 1234567890n,
        username: 'john_doe',
        role: 'SUPER_ADMIN',
      };

      expect(() => JSON.stringify(user)).not.toThrow();
      const json = JSON.stringify(user);
      const parsed = JSON.parse(json);
      expect(parsed.telegramId).toBe('1234567890');
    });

    it('should serialize negative 64-bit Telegram chat ID (supergroups/channels)', () => {
      const channel = {
        id: 'c8e485b7-04a8-42ce-8f13-a864df014659',
        telegramChatId: -1001234567890n,
        title: 'Editorial Main Channel',
      };

      expect(() => JSON.stringify(channel)).not.toThrow();
      const json = JSON.stringify(channel);
      const parsed = JSON.parse(json);
      expect(parsed.telegramChatId).toBe('-1001234567890');
    });

    it('should serialize zero BigInt correctly', () => {
      const data = { count: 0n };
      expect(JSON.stringify(data)).toBe('{"count":"0"}');
    });

    it('should serialize maximum signed 64-bit integer (PostgreSQL BIGINT MAX)', () => {
      const maxBigInt = 9223372036854775807n;
      const data = { max: maxBigInt };
      const parsed = JSON.parse(JSON.stringify(data));
      expect(parsed.max).toBe('9223372036854775807');
    });

    it('should serialize minimum signed 64-bit integer (PostgreSQL BIGINT MIN)', () => {
      const minBigInt = -9223372036854775808n;
      const data = { min: minBigInt };
      const parsed = JSON.parse(JSON.stringify(data));
      expect(parsed.min).toBe('-9223372036854775808');
    });

    it('should handle nested structures and arrays containing BigInts', () => {
      const complex = {
        post: {
          id: 'post-1',
          author: { telegramId: 111111111n },
          approvers: [222222222n, 333333333n],
          channel: { chatId: -1009999999999n },
        },
      };

      expect(() => JSON.stringify(complex)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(complex));
      expect(parsed.post.author.telegramId).toBe('111111111');
      expect(parsed.post.approvers).toEqual(['222222222', '333333333']);
      expect(parsed.post.channel.chatId).toBe('-1009999999999');
    });

    it('should format logs with BigInt properties in StructuredLoggerService without throwing', () => {
      const logger = new StructuredLoggerService();
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      expect(() => {
        logger.log({
          event: 'user_authenticated',
          telegramId: 9876543210n,
          channelId: -1001234567890n,
        });
      }).not.toThrow();

      expect(writeSpy).toHaveBeenCalled();
      const output = writeSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.telegramId).toBe('9876543210');
      expect(parsed.channelId).toBe('-1001234567890');
      writeSpy.mockRestore();
    });
  });
});
