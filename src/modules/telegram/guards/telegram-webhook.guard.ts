/**
 * Telegram Webhook Secret Token Guard
 * Validates incoming Telegram Webhook secret token using constant-time comparison.
 * Authoritative reference: AGENTS.md § 36; tasks.md § 30
 */

import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { EnvironmentConfigService } from '../../../infrastructure/config/environment-config.service';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly config: EnvironmentConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.webhookSecretToken;
    if (!secret) {
      return true; // Secret validation disabled if not configured
    }

    const request = context.switchToHttp().getRequest<Request>();
    const headerToken = request.headers['x-telegram-bot-api-secret-token'];

    if (!headerToken || typeof headerToken !== 'string') {
      throw new UnauthorizedException('Missing Telegram webhook secret token header');
    }

    const secretBuf = Buffer.from(secret, 'utf8');
    const headerBuf = Buffer.from(headerToken, 'utf8');

    if (secretBuf.length !== headerBuf.length || !crypto.timingSafeEqual(secretBuf, headerBuf)) {
      throw new UnauthorizedException('Invalid Telegram webhook secret token');
    }

    return true;
  }
}
