import { Injectable, LoggerService, Scope } from '@nestjs/common';

export interface LogContext {
  event?: string;
  requestId?: string;
  telegramUpdateId?: number;
  userId?: string;
  channelId?: string;
  postId?: string;
  jobId?: string;
  module?: string;
  operation?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = [
  'token',
  'bottoken',
  'bot_token',
  'password',
  'secret',
  'webhook_secret',
  'database_url',
  'redis_url',
  'authorization',
];

function redactSensitiveData(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Redact bot token pattern
    return obj.replace(/\d+:[A-Za-z0-9_-]{35,}/g, '[REDACTED_BOT_TOKEN]');
  }
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, depth + 1));
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lowerKey.includes(s))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

@Injectable({ scope: Scope.DEFAULT })
export class StructuredLoggerService implements LoggerService {
  private formatLog(
    level: string,
    message: unknown,
    context?: string | LogContext,
    stack?: string,
  ): string {
    const timestamp = new Date().toISOString();
    let payload: Record<string, unknown> = {
      timestamp,
      level,
    };

    if (typeof message === 'object' && message !== null) {
      payload = { ...payload, ...(redactSensitiveData(message) as Record<string, unknown>) };
    } else {
      payload.message = typeof message === 'string' ? redactSensitiveData(message) : String(message);
    }

    if (typeof context === 'string') {
      payload.context = context;
    } else if (typeof context === 'object' && context !== null) {
      payload = { ...payload, ...(redactSensitiveData(context) as Record<string, unknown>) };
    }

    if (stack) {
      payload.stack = stack;
    }

    return JSON.stringify(payload);
  }

  log(message: unknown, context?: string | LogContext): void {
    process.stdout.write(this.formatLog('info', message, context) + '\n');
  }

  error(message: unknown, stack?: string, context?: string | LogContext): void {
    process.stderr.write(this.formatLog('error', message, context, stack) + '\n');
  }

  warn(message: unknown, context?: string | LogContext): void {
    process.stdout.write(this.formatLog('warn', message, context) + '\n');
  }

  debug(message: unknown, context?: string | LogContext): void {
    if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production') {
      process.stdout.write(this.formatLog('debug', message, context) + '\n');
    }
  }

  verbose(message: unknown, context?: string | LogContext): void {
    if (process.env.LOG_LEVEL === 'verbose') {
      process.stdout.write(this.formatLog('verbose', message, context) + '\n');
    }
  }
}
