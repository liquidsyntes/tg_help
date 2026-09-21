import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { StructuredLoggerService } from '../logger/structured-logger.service';

// Global BigInt serialization polyfill for Node.js JSON.stringify
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly logger?: StructuredLoggerService) {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [
              { emit: 'stdout', level: 'error' },
            ],
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.logger) {
      this.logger.log({ event: 'database_connecting', message: 'Connecting to PostgreSQL via Prisma...' });
    }
    try {
      await this.$connect();
      if (this.logger) {
        this.logger.log({ event: 'database_connected', message: 'PostgreSQL connected successfully.' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.logger) {
        this.logger.error({ event: 'database_connection_failed', error: message });
      }
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.logger) {
      this.logger.log({ event: 'database_disconnecting', message: 'Disconnecting from PostgreSQL...' });
    }
    await this.$disconnect();
    if (this.logger) {
      this.logger.log({ event: 'database_disconnected', message: 'PostgreSQL disconnected cleanly.' });
    }
  }
}
