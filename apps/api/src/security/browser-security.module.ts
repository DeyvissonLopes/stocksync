import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import { ConfigModule } from '../config/config.module.js';
import { BrowserWriteGuard } from './browser-write.guard.js';

@Module({
  imports: [ConfigModule],
  providers: [{
    provide: APP_GUARD,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new BrowserWriteGuard(config.appOrigin),
  }],
})
export class BrowserSecurityModule {}
