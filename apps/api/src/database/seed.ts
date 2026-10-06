import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadDatabaseOptions } from './database-options.js';
import { DatabaseSeeder } from './seeders/database-seeder.js';

async function main(): Promise<void> {
  const dataSource = new DataSource(loadDatabaseOptions(process.env));
  try {
    await dataSource.initialize();
    await new DatabaseSeeder(dataSource.manager).run();
    console.info('Seed data ready');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main().catch(() => {
  console.error('Database seed failed');
  process.exitCode = 1;
});
