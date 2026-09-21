/**
 * Centralized Telegram Exception Filter & Error Boundary
 * Maps domain and infrastructure exceptions into empathetic Russian user messages.
 * Authoritative reference: AGENTS.md § 32, § 33; tasks.md § 7, § 12
 */

import { Injectable, Optional } from '@nestjs/common';
import { MiddlewareFn } from 'grammy';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { BotContext } from '../interfaces/bot-context.interface';
import {
  UnauthorizedUserException,
  UserDeactivatedException,
  PermissionDeniedException,
  PostConflictException,
  IdempotencyConflictException,
  InvalidPostStateTransitionException,
  ValidationException,
  PostNotFoundException,
  ChannelNotFoundException,
  TemplateNotFoundException,
} from '../../../common/exceptions/domain.exceptions';
import {
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from '../../../infrastructure/telegram-api/errors/telegram-api.exceptions';

@Injectable()
export class TelegramExceptionFilter {
  constructor(@Optional() private readonly logger?: StructuredLoggerService) {}

  create(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      try {
        await next();
      } catch (err: unknown) {
        await this.handleError(err, ctx);
      }
    };
  }

  async handleError(err: unknown, ctx: BotContext): Promise<void> {
    const { userMessage, errorCode, logLevel } = this.classifyError(err);

    const logPayload = {
      event: 'telegram_handler_error',
      requestId: ctx.requestId,
      telegramUserId: ctx.from?.id ? String(ctx.from.id) : undefined,
      username: ctx.from?.username,
      errorCode,
      errorName: err instanceof Error ? err.name : 'UnknownError',
      errorMessage: err instanceof Error ? err.message : String(err),
    };

    if (this.logger) {
      if (logLevel === 'error') {
        this.logger.error(logPayload, err instanceof Error ? err.stack : undefined);
      } else if (logLevel === 'warn') {
        this.logger.warn(logPayload);
      } else {
        this.logger.log(logPayload);
      }
    }

    try {
      if (ctx.callbackQuery) {
        if (userMessage.length <= 180) {
          await ctx.answerCallbackQuery({ text: userMessage, show_alert: true });
        } else {
          await ctx.answerCallbackQuery();
          if (ctx.chat) {
            await ctx.reply(userMessage, { parse_mode: 'HTML' });
          }
        }
      } else if (ctx.chat) {
        await ctx.reply(userMessage, { parse_mode: 'HTML' });
      }
    } catch (deliveryError) {
      this.logger?.warn({
        event: 'telegram_error_message_delivery_failed',
        requestId: ctx.requestId,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      });
    }
  }

  private classifyError(err: unknown): {
    userMessage: string;
    errorCode: string;
    logLevel: 'info' | 'warn' | 'error';
  } {
    if (err instanceof UnauthorizedUserException) {
      return {
        userMessage: '🚫 У вас пока нет доступа к редакции. Обратитесь к администратору.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof UserDeactivatedException) {
      return {
        userMessage: '🚫 Ваш аккаунт деактивирован. Обратитесь к администратору.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PermissionDeniedException) {
      return {
        userMessage: '⛔️ Недостаточно прав для выполнения этого действия.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PostConflictException) {
      return {
        userMessage:
          '⚠️ Публикация была изменена другим пользователем. Пожалуйста, обновите список и повторите действие.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof IdempotencyConflictException) {
      return {
        userMessage: '⏳ Публикация уже находится в обработке или отправлена в очередь.',
        errorCode: err.errorCode,
        logLevel: 'info',
      };
    }
    if (err instanceof InvalidPostStateTransitionException) {
      return {
        userMessage:
          '⚠️ Невозможно выполнить действие: текущий статус публикации не позволяет этот переход.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof ValidationException) {
      return {
        userMessage: `⚠️ Ошибка проверки данных: ${this.sanitizeValidationMessage(err.message)}`,
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof PostNotFoundException) {
      return {
        userMessage: '❌ Публикация не найдена. Возможно, она была удалена.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof ChannelNotFoundException) {
      return {
        userMessage: '❌ Канал не найден или недоступен.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof TemplateNotFoundException) {
      return {
        userMessage: '❌ Шаблон публикации не найден.',
        errorCode: err.errorCode,
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramRateLimitException) {
      return {
        userMessage: '⏳ Превышен лимит запросов к Telegram. Повторите попытку через несколько секунд.',
        errorCode: 'RATE_LIMITED',
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramRetryableException) {
      return {
        userMessage: '⏳ Временный сбой связи с Telegram. Попробуйте еще раз.',
        errorCode: 'RETRYABLE_ERROR',
        logLevel: 'warn',
      };
    }
    if (err instanceof TelegramPermanentException) {
      return {
        userMessage: '❌ Ошибка Telegram: не удалось выполнить действие.',
        errorCode: 'PERMANENT_ERROR',
        logLevel: 'error',
      };
    }

    return {
      userMessage: '❌ Произошла непредвиденная ошибка. Мы уже зафиксировали проблему. Попробуйте позже.',
      errorCode: 'INTERNAL_ERROR',
      logLevel: 'error',
    };
  }

  private sanitizeValidationMessage(msg: string): string {
    return msg.replace(/[<>&]/g, '');
  }
}
