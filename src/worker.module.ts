import { Module } from '@nestjs/common';
import { AppConfigModule } from './infrastructure/config/config.module';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { QueueModule } from './infrastructure/queues/queue.module';
import { TelegramApiModule } from './infrastructure/telegram-api/telegram-api.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    TelegramApiModule,
    PublishingModule,
    SchedulingModule,
  ],
})
export class WorkerModule {}
