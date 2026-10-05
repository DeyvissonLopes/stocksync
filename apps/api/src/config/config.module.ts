import { Module } from '@nestjs/common';
import { APP_CONFIG, loadConfiguration } from './app-config.js';

@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfiguration(process.env) },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
