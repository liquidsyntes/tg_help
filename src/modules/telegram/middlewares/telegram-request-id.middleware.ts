/**
 * Telegram Request ID & Tracing Middleware
 * Generates unique requestId for every update and logs structured trace.
 * Authoritative reference: AGENTS.md § 33
 */

import { Injectable, Optional } from '@nestjs/common';
import { MiddlewareFn } from 'grammy';
import * as crypto from 'crypto';
import { BotContext } from '../interfaces/bot-context.interface';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';

@Injectable()
export class TelegramRequestIdMiddleware {
  constructor(@Optional() private readonly logger?: StructuredLoggerService) {}

  create(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      ctx.requestId = crypto.randomUUID();

      this.logger?.log({
        event: 'telegram_update_received',
        requestId: ctx.requestId,
        updateId: ctx.update?.update_id,
        chatId: ctx.chat?.id ? String(ctx.chat.id) : undefined,
        fromId: ctx.from?.id ? String(ctx.from.id) : undefined,
        updateType: ctx.message
          ? 'message'
          : ctx.callbackQuery
            ? 'callback_query'
            : 'other',
      });

      await next();
    };
  }
}
