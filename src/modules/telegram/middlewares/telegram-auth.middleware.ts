/**
 * Telegram Authentication & RBAC Middleware
 * Resolves user by Telegram ID via AuthService.
 * Rejects unregistered and deactivated users immediately.
 * Enriches BotContext with authUser and permission helpers.
 * Authoritative reference: AGENTS.md § 8, § 9; tasks.md § 4, § 7; ORIGINAL_REQUEST.md AC
 */

import { Injectable, Optional } from '@nestjs/common';
import { MiddlewareFn } from 'grammy';
import { AuthService } from '../../auth/auth.service';
import { UserDeactivatedException } from '../../../common/exceptions/domain.exceptions';
import { StructuredLoggerService } from '../../../infrastructure/logger/structured-logger.service';
import { BotContext } from '../interfaces/bot-context.interface';
import { SystemRole, ChannelPermission } from '../../../common/enums';

@Injectable()
export class TelegramAuthMiddleware {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly logger?: StructuredLoggerService,
  ) {}

  create(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      const fromUser = ctx.from;
      if (!fromUser) {
        // Non-user updates (e.g. channel post) are ignored by bot user transport
        return;
      }

      const telegramId = BigInt(fromUser.id);

      try {
        // 1. Resolve user via AuthService
        const authUser = await this.authService.resolveUser(telegramId);

        // 2. Unregistered user rejection
        if (!authUser) {
          this.logger?.warn({
            event: 'auth_unregistered_access_attempt',
            telegramId: telegramId.toString(),
            username: fromUser.username,
            requestId: ctx.requestId,
          });

          const message =
            `🚫 <b>Доступ ограничен</b>\n\n` +
            `У вас пока нет доступа к редакции.\n` +
            `Обратитесь к администратору для получения прав.\n\n` +
            `Ваш Telegram ID: <code>${telegramId.toString()}</code>`;

          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
              text: 'У вас пока нет доступа к редакции. Обратитесь к администратору.',
              show_alert: true,
            });
          } else {
            await ctx.reply(message, { parse_mode: 'HTML' });
          }
          return;
        }

        // 3. Attach resolved user & permission helpers to context
        ctx.authUser = authUser;
        Object.defineProperty(ctx, 'isSuperAdmin', {
          get: () => authUser.systemRole === SystemRole.SUPER_ADMIN,
          configurable: true,
        });

        ctx.canChannel = (permission: ChannelPermission, channelId: string): boolean => {
          if (authUser.systemRole === SystemRole.SUPER_ADMIN) return true;
          const membership = authUser.channelMemberships.find((m) => m.channelId === channelId);
          if (!membership) return false;
          if (permission === ChannelPermission.PUBLISH_POST) return membership.canPublish;
          if (permission === ChannelPermission.APPROVE_POST) return membership.canApprove;
          return true;
        };

        this.logger?.log({
          event: 'auth_user_resolved',
          userId: authUser.id,
          telegramId: telegramId.toString(),
          role: authUser.systemRole,
          requestId: ctx.requestId,
        });

        await next();
      } catch (err: unknown) {
        // 4. Deactivated user rejection
        if (err instanceof UserDeactivatedException) {
          this.logger?.warn({
            event: 'auth_deactivated_user_attempt',
            telegramId: telegramId.toString(),
            requestId: ctx.requestId,
          });

          const deactMessage =
            `🚫 <b>Доступ заблокирован</b>\n\n` +
            `Ваш аккаунт деактивирован. Обратитесь к администратору.\n\n` +
            `Ваш Telegram ID: <code>${telegramId.toString()}</code>`;

          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
              text: 'Ваш аккаунт деактивирован. Обратитесь к администратору.',
              show_alert: true,
            });
          } else {
            await ctx.reply(deactMessage, { parse_mode: 'HTML' });
          }
          return;
        }

        throw err;
      }
    };
  }
}
