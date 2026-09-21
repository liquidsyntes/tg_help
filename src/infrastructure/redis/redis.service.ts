import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
import { EnvironmentConfigService } from '../config/environment-config.service';
import { StructuredLoggerService } from '../logger/structured-logger.service';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(
    private readonly configService: EnvironmentConfigService,
    private readonly logger?: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.configService.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    if (this.logger) {
      this.logger.log({ event: 'redis_connecting', message: 'Initializing Redis connection...' });
    }

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    this.client.on('connect', () => {
      if (this.logger) {
        this.logger.log({ event: 'redis_connected', message: 'Redis connection established.' });
      }
    });

    this.client.on('error', (error) => {
      if (this.logger) {
        this.logger.error({ event: 'redis_error', error: error.message });
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      if (this.logger) {
        this.logger.log({ event: 'redis_disconnecting', message: 'Disconnecting Redis client...' });
      }
      await this.client.quit();
    }
  }

  getClient(): Redis {
    return this.client;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK' | null> {
    if (ttlSeconds) {
      return this.client.set(key, value, 'EX', ttlSeconds);
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }
}
