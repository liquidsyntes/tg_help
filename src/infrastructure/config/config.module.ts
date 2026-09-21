import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { EnvironmentConfigService } from './environment-config.service';
import { validateEnvironment } from './environment.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      envFilePath: ['.env.local', '.env'],
    }),
  ],
  providers: [EnvironmentConfigService],
  exports: [EnvironmentConfigService, NestConfigModule],
})
export class AppConfigModule {}
