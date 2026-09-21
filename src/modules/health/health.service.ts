import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { LivenessResponse, ReadinessResponse } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  checkLiveness(): LivenessResponse {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  async checkReadiness(): Promise<ReadinessResponse> {
    const checks: ReadinessResponse['checks'] = {
      database: 'down',
      redis: 'down',
    };
    const errors: Record<string, string> = {};

    // 1. Database Check (Timeout capped at 2500ms)
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Database ping timeout after 2500ms')), 2500);
          timer.unref();
        }),
      ]);
      checks.database = 'up';
    } catch (err: unknown) {
      checks.database = 'down';
      errors.database = err instanceof Error ? err.message : 'Database check failed';
    }

    // 2. Redis Ping Check (Timeout capped at 2500ms)
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<string>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Redis ping timeout after 2500ms')), 2500);
          timer.unref();
        }),
      ]);
      if (pong === 'PONG') {
        checks.redis = 'up';
      } else {
        checks.redis = 'down';
        errors.redis = `Unexpected ping response: ${String(pong)}`;
      }
    } catch (err: unknown) {
      checks.redis = 'down';
      errors.redis = err instanceof Error ? err.message : 'Redis check failed';
    }

    const isAllUp = checks.database === 'up' && checks.redis === 'up';

    return {
      status: isAllUp ? 'ok' : 'down',
      checks,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
