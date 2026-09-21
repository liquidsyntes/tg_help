import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { StructuredLoggerService } from '../../infrastructure/logger/structured-logger.service';
import { DomainException } from './domain.exceptions';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger?: StructuredLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // If not in HTTP context (e.g. BullMQ worker or RPC), just log and rethrow or return
    if (!response || typeof response.status !== 'function') {
      if (this.logger) {
        this.logger.error(
          {
            event: 'unhandled_non_http_exception',
            error: exception instanceof Error ? exception.message : String(exception),
          },
          exception instanceof Error ? exception.stack : undefined,
        );
      }
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown = undefined;

    if (exception instanceof DomainException) {
      status = exception.statusCode;
      errorCode = exception.errorCode;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body.message as string) || exception.message;
        errorCode = (body.error as string) || exception.name;
        details = body.details ?? undefined;
      } else {
        message = String(res);
        errorCode = exception.name;
      }
    } else if (exception instanceof Error) {
      // In development, show error message; in production, keep generic
      if (process.env.NODE_ENV !== 'production') {
        message = exception.message;
      }
    }

    const logPayload = {
      event: 'http_exception',
      statusCode: status,
      errorCode,
      path: request?.url,
      method: request?.method,
      message,
    };

    if (this.logger) {
      if (status >= 500) {
        this.logger.error(logPayload, exception instanceof Error ? exception.stack : undefined);
      } else {
        this.logger.warn(logPayload);
      }
    }

    response.status(status).json({
      success: false,
      error: {
        code: errorCode,
        message,
        ...(details ? { details } : {}),
      },
      timestamp: new Date().toISOString(),
      path: request?.url,
    });
  }
}
