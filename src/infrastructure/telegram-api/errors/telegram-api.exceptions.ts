/**
 * Telegram API Exceptions
 * Authoritative reference: AGENTS.md § 48, § 49, § 50
 */

import { TelegramErrorCategory } from '../interfaces/telegram-publisher.interface';

export abstract class TelegramApiException extends Error {
  public abstract readonly category: TelegramErrorCategory;
  public readonly statusCode?: number;
  public readonly originalError?: unknown;

  constructor(message: string, statusCode?: number, originalError?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}

export class TelegramRateLimitException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.RATE_LIMITED;
  public readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, originalError?: unknown) {
    super(message, 429, originalError);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramRetryableException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.RETRYABLE;

  constructor(message: string, statusCode = 500, originalError?: unknown) {
    super(message, statusCode, originalError);
  }
}

export class TelegramPermanentException extends TelegramApiException {
  public readonly category = TelegramErrorCategory.PERMANENT;

  constructor(message: string, statusCode = 400, originalError?: unknown) {
    super(message, statusCode, originalError);
  }
}
