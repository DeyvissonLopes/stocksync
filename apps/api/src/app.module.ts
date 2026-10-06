import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { loadDatabaseOptions } from './database/database-options.js';
import { BrowserSecurityModule } from './security/browser-security.module.js';

@Module({
  imports: [
    ConfigModule,
    BrowserSecurityModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...loadDatabaseOptions({ ...process.env, NODE_ENV: config.nodeEnv }),
        retryAttempts: 0,
      }),
    }),
  ],
})
export class AppModule {}
