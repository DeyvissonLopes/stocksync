import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { loadDatabaseOptions } from './database/database-options.js';

@Module({
  imports: [
    ConfigModule,
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
