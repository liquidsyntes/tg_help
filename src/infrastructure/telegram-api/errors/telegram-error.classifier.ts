/**
 * Telegram Error Classifier
 * Tri-tier classification: RATE_LIMITED, RETRYABLE, PERMANENT.
 * Authoritative reference: AGENTS.md § 48, § 49, § 50
 */

import { GrammyError, HttpError } from 'grammy';
import { TelegramErrorCategory } from '../interfaces/telegram-publisher.interface';
import {
  TelegramApiException,
  TelegramRateLimitException,
  TelegramRetryableException,
  TelegramPermanentException,
} from './telegram-api.exceptions';

export interface ClassifiedTelegramError {
  category: TelegramErrorCategory;
  statusCode?: number;
  retryAfterSeconds: number | null;
  isPermanent: boolean;
  isRetryable: boolean;
  sanitizedMessage: string;
}

export class TelegramErrorClassifier {
  /**
   * Classifies any error into a structured classification result.
   */
  public static classify(error: unknown): ClassifiedTelegramError {
    // 1. Already a typed domain exception
    if (error instanceof TelegramRateLimitException) {
      return {
        category: TelegramErrorCategory.RATE_LIMITED,
        statusCode: 429,
        retryAfterSeconds: error.retryAfterSeconds,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: error.message,
      };
    }

    if (error instanceof TelegramRetryableException) {
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: error.statusCode,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: error.message,
      };
    }

    if (error instanceof TelegramPermanentException) {
      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: error.statusCode,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: error.message,
      };
    }

    // 2. grammY GrammyError (Telegram API response error)
    if (error instanceof GrammyError || (typeof error === 'object' && error !== null && 'error_code' in error)) {
      const gErr = error as { error_code: number; description?: string; parameters?: { retry_after?: number } };
      const code = gErr.error_code;
      const desc = gErr.description || 'Telegram API Error';

      if (code === 429) {
        const retryAfter = gErr.parameters?.retry_after ?? this.extractRetryAfterRegex(desc) ?? 5;
        return {
          category: TelegramErrorCategory.RATE_LIMITED,
          statusCode: 429,
          retryAfterSeconds: retryAfter,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: desc,
        };
      }

      if (code >= 500 && code < 600) {
        return {
          category: TelegramErrorCategory.RETRYABLE,
          statusCode: code,
          retryAfterSeconds: null,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: desc,
        };
      }

      // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found
      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: code,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: desc,
      };
    }

    // 3. grammY HttpError or Node.js Network / Socket Errors
    if (error instanceof HttpError || this.isNetworkError(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: 504,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: `Network Failure: ${msg}`,
      };
    }

    // 4. Test harness double TelegramApiError compatibility (duck-typing)
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const tErr = error as { statusCode: number; retryAfter?: number; isPermanent?: boolean; message?: string };
      const msg = tErr.message || 'Telegram Test Double Error';

      if (tErr.isPermanent) {
        return {
          category: TelegramErrorCategory.PERMANENT,
          statusCode: tErr.statusCode,
          retryAfterSeconds: null,
          isPermanent: true,
          isRetryable: false,
          sanitizedMessage: msg,
        };
      }

      if (tErr.statusCode === 429) {
        return {
          category: TelegramErrorCategory.RATE_LIMITED,
          statusCode: 429,
          retryAfterSeconds: tErr.retryAfter ?? 5,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: msg,
        };
      }

      if (tErr.statusCode >= 500 && tErr.statusCode < 600) {
        return {
          category: TelegramErrorCategory.RETRYABLE,
          statusCode: tErr.statusCode,
          retryAfterSeconds: null,
          isPermanent: false,
          isRetryable: true,
          sanitizedMessage: msg,
        };
      }

      return {
        category: TelegramErrorCategory.PERMANENT,
        statusCode: tErr.statusCode,
        retryAfterSeconds: null,
        isPermanent: true,
        isRetryable: false,
        sanitizedMessage: msg,
      };
    }

    // 5. String inspection fallback
    const rawMsg = error instanceof Error ? error.message : String(error);
    if (/429|too many requests|retry after/i.test(rawMsg)) {
      const delay = this.extractRetryAfterRegex(rawMsg) ?? 5;
      return {
        category: TelegramErrorCategory.RATE_LIMITED,
        statusCode: 429,
        retryAfterSeconds: delay,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: rawMsg,
      };
    }

    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(rawMsg)) {
      return {
        category: TelegramErrorCategory.RETRYABLE,
        statusCode: 504,
        retryAfterSeconds: null,
        isPermanent: false,
        isRetryable: true,
        sanitizedMessage: rawMsg,
      };
    }

    // Default fallback: treat unclassified errors as PERMANENT to prevent indefinite retry loops (AGENTS.md §49)
    return {
      category: TelegramErrorCategory.PERMANENT,
      statusCode: 400,
      retryAfterSeconds: null,
      isPermanent: true,
      isRetryable: false,
      sanitizedMessage: rawMsg,
    };
  }

  private static isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: string }).code;
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
      return true;
    }
    return /connect timeout|network timeout|fetch failed|socket hang up|connection lost/i.test(error.message);
  }

  private static extractRetryAfterRegex(message: string): number | null {
    const match = message.match(/retry(?:_after| after)[:\s]+(\d+)/i);
    if (match && match[1]) {
      const sec = parseInt(match[1], 10);
      return Number.isNaN(sec) ? null : sec;
    }
    return null;
  }
}
