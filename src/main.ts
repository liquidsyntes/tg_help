import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { EnvironmentConfigService } from './infrastructure/config/environment-config.service';
import { StructuredLoggerService } from './infrastructure/logger/structured-logger.service';
import { AllExceptionsFilter } from './common/exceptions/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(logger));

  app.enableShutdownHooks();

  const configService = app.get(EnvironmentConfigService);
  const port = configService.port;
  const host = '0.0.0.0';

  await app.listen(port, host);
  logger.log({
    event: 'application_started',
    port,
    host,
    mode: configService.telegramMode,
    nodeEnv: configService.nodeEnv,
  });
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal bootstrap error:', error);
  process.exit(1);
});
