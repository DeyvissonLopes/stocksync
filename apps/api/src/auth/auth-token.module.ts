import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import { ConfigModule } from '../config/config.module.js';
import { AuthTokenService } from './auth-token.service.js';

@Module({
  imports: [JwtModule.registerAsync({
    imports: [ConfigModule],
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
  })],
  providers: [AuthTokenService],
  exports: [AuthTokenService],
})
export class AuthTokenModule {}
