import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { EnvironmentVariables, TelegramMode } from './environment.variables';

export function validateEnvironment(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors: ValidationError[] = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  const errorMessages: string[] = [];

  if (errors.length > 0) {
    for (const error of errors) {
      if (error.constraints) {
        const constraintMsgs = Object.values(error.constraints).join('; ');
        errorMessages.push(`  - [${error.property}]: ${constraintMsgs}`);
      }
    }
  }

  // Verify DEFAULT_TIMEZONE against IANA registry
  if (validatedConfig.DEFAULT_TIMEZONE) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: validatedConfig.DEFAULT_TIMEZONE });
    } catch {
      errorMessages.push(
        `  - [DEFAULT_TIMEZONE]: "${validatedConfig.DEFAULT_TIMEZONE}" is not a valid IANA timezone name (expected e.g. Europe/Kyiv, UTC)`,
      );
    }
  }

  // Conditional validation: Webhook mode requires WEBHOOK_DOMAIN
  if (validatedConfig.TELEGRAM_MODE === TelegramMode.WEBHOOK) {
    if (!validatedConfig.WEBHOOK_DOMAIN || validatedConfig.WEBHOOK_DOMAIN.trim() === '') {
      errorMessages.push(
        '  - [WEBHOOK_DOMAIN]: WEBHOOK_DOMAIN is strictly required when TELEGRAM_MODE is set to "webhook"',
      );
    }
  }

  if (errorMessages.length > 0) {
    const formatted = errorMessages.join('\n');
    throw new Error(
      `\n================================================================================\n` +
      `[FATAL CONFIGURATION ERROR] Application startup aborted due to invalid environment:\n` +
      `${formatted}\n` +
      `================================================================================\n`,
    );
  }

  return validatedConfig;
}
