/**
 * TelegramApiModule
 * Encapsulates Telegram API infrastructure and exports TELEGRAM_PUBLISHER provider.
 * Authoritative reference: AGENTS.md § 48
 */

import { Module } from '@nestjs/common';
import { TelegramPublisherService } from './telegram-publisher.service';
import { TELEGRAM_PUBLISHER } from './interfaces/telegram-publisher.interface';

@Module({
  providers: [
    TelegramPublisherService,
    {
      provide: TELEGRAM_PUBLISHER,
      useExisting: TelegramPublisherService,
    },
  ],
  exports: [TelegramPublisherService, TELEGRAM_PUBLISHER],
})
export class TelegramApiModule {}
