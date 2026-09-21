import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EnvironmentConfigService } from '../config/environment-config.service';
import { PUBLICATION_QUEUE_NAME } from '../../common/constants/queue-names';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [EnvironmentConfigService],
      useFactory: (config: EnvironmentConfigService) => {
        const redisUrl = new URL(config.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379');
        return {
          connection: {
            host: redisUrl.hostname || '127.0.0.1',
            port: Number(redisUrl.port) || 6379,
            password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
            username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: PUBLICATION_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600 * 24, // 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 3600 * 24 * 7, // 7 days
          count: 5000,
        },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
