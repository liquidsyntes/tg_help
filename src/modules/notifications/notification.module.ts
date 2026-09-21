import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { DomainEventBus } from './domain-event.bus';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { LoggerModule } from '../../infrastructure/logger/logger.module';
import { TelegramApiModule } from '../../infrastructure/telegram-api/telegram-api.module';

@Module({
  imports: [PrismaModule, LoggerModule, TelegramApiModule],
  providers: [NotificationService, DomainEventBus],
  exports: [NotificationService, DomainEventBus],
})
export class NotificationsModule {}

export const NotificationModule = NotificationsModule;
