import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { AuthTokenModule } from './auth/auth-token.module.js';
import { APP_CONFIG } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { loadDatabaseOptions } from './database/database-options.js';
import { ProductsModule } from './products/products.module.js';
import { SalesModule } from './sales/sales.module.js';
import { BrowserSecurityModule } from './security/browser-security.module.js';
import { ApiErrorFilter } from './security/api-error.filter.js';
import { SyncModule } from './sync/sync.module.js';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    AuthTokenModule,
    BrowserSecurityModule,
    ProductsModule,
    SalesModule,
    SyncModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...loadDatabaseOptions({ ...process.env, NODE_ENV: config.nodeEnv }),
        retryAttempts: 0,
      }),
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
