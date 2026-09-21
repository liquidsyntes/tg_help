import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { StructuredLoggerService } from './infrastructure/logger/structured-logger.service';

async function bootstrapWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);

  app.enableShutdownHooks();

  logger.log({
    event: 'worker_started',
    processId: process.pid,
    timestamp: new Date().toISOString(),
  });

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log({ event: 'worker_shutting_down', signal });
      await app.close();
      process.exit(0);
    });
  }
}

bootstrapWorker().catch((err: unknown) => {
  console.error('Fatal worker bootstrap error:', err);
  process.exit(1);
});
