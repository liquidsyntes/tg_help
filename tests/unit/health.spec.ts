import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { HealthController } from '../../src/modules/health/health.controller';
import { HealthService } from '../../src/modules/health/health.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';

describe('Health Module Unit Tests', () => {
  let controller: HealthController;
  let healthService: HealthService;
  let mockPrisma: Partial<PrismaService>;
  let mockRedis: Partial<RedisService>;

  beforeEach(() => {
    mockPrisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
    };
    healthService = new HealthService(mockPrisma as PrismaService, mockRedis as RedisService);
    controller = new HealthController(healthService);
  });

  describe('GET /health (Liveness)', () => {
    it('should return 200 OK with liveness status without hitting database', () => {
      const response = controller.getHealth();
      expect(response).toBeDefined();
      expect(response.status).toBe('ok');
      expect(typeof response.uptime).toBe('number');
      expect(typeof response.timestamp).toBe('string');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockRedis.ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /ready (Readiness)', () => {
    it('should return 200 OK and status ok when both PostgreSQL and Redis are up', async () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const result = await controller.getReady(mockRes);

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockRedis.ping).toHaveBeenCalled();
      expect(result.status).toBe('ok');
      expect(result.checks.database).toBe('up');
      expect(result.checks.redis).toBe('up');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.OK);
    });

    it('should return 503 Service Unavailable when PostgreSQL is down', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

      const mockRes = {
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const result = await controller.getReady(mockRes);

      expect(result.status).toBe('down');
      expect(result.checks.database).toBe('down');
      expect(result.checks.redis).toBe('up');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('should return 503 Service Unavailable when Redis is down', async () => {
      (mockRedis.ping as jest.Mock).mockRejectedValueOnce(new Error('Redis timeout'));

      const mockRes = {
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const result = await controller.getReady(mockRes);

      expect(result.status).toBe('down');
      expect(result.checks.database).toBe('up');
      expect(result.checks.redis).toBe('down');
      expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
