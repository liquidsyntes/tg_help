/**
 * Telegram Webhook Controller
 * Receives incoming webhook updates from Telegram at POST /telegram/webhook.
 * Authoritative reference: AGENTS.md § 36, § 37; tasks.md § 28, § 29
 */

import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { TelegramWebhookGuard } from '../guards/telegram-webhook.guard';
import { TelegramBotService } from '../telegram-bot.service';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    @Inject(forwardRef(() => TelegramBotService))
    private readonly botService: TelegramBotService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TelegramWebhookGuard)
  async handleWebhook(@Body() update: unknown): Promise<{ ok: boolean }> {
    if (!update || typeof update !== 'object') {
      throw new BadRequestException('Malformed Telegram update payload');
    }
    await this.botService.handleUpdate(update);
    return { ok: true };
  }
}
