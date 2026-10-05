import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, ConfigurationError } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    logger: false,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableShutdownHooks();
  await app.listen(config.port, config.listenHost);
  console.info(`StockSync API listening on port ${config.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError ? error.message : 'Application startup failed',
  );
  process.exitCode = 1;
});
