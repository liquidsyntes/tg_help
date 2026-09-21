/**
 * PublishingModule
 * Encapsulates publishing services, two-stage preflight validation, and BullMQ worker.
 * Authoritative reference: AGENTS.md § 20, § 21, § 22, § 23
 */

import { Module, forwardRef } from '@nestjs/common';
import { QueueModule } from '../../infrastructure/queues/queue.module';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { LoggerModule } from '../../infrastructure/logger/logger.module';
import { PostsModule } from '../posts/posts.module';
import { ChannelsModule } from '../channels/channels.module';
import { TemplatesModule } from '../templates/templates.module';
import { RenderingModule } from '../rendering/rendering.module';
import { TelegramApiModule } from '../../infrastructure/telegram-api/telegram-api.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notification.module';
import { AuthModule } from '../auth/auth.module';
import { PublishingService } from './publishing.service';
import { PublishingPreflightService } from './publishing-preflight.service';
import { PublishingProcessor } from './publishing.processor';

@Module({
  imports: [
    QueueModule,
    PrismaModule,
    LoggerModule,
    forwardRef(() => PostsModule),
    ChannelsModule,
    TemplatesModule,
    RenderingModule,
    TelegramApiModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
  ],
  providers: [
    PublishingService,
    PublishingPreflightService,
    PublishingProcessor,
  ],
  exports: [
    PublishingService,
    PublishingPreflightService,
    PublishingProcessor,
  ],
})
export class PublishingModule {}
