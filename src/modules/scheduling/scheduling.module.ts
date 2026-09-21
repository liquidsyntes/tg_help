/**
 * SchedulingModule
 * Encapsulates post scheduling services and BullMQ delayed job handling.
 * Authoritative reference: AGENTS.md § 24
 */

import { Module, forwardRef } from '@nestjs/common';
import { QueueModule } from '../../infrastructure/queues/queue.module';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { LoggerModule } from '../../infrastructure/logger/logger.module';
import { PostsModule } from '../posts/posts.module';
import { ChannelsModule } from '../channels/channels.module';
import { PublishingModule } from '../publishing/publishing.module';
import { AuthModule } from '../auth/auth.module';
import { SchedulingService } from './scheduling.service';

@Module({
  imports: [
    QueueModule,
    PrismaModule,
    LoggerModule,
    forwardRef(() => PostsModule),
    ChannelsModule,
    PublishingModule,
    AuthModule,
  ],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
