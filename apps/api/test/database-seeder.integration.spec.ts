import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { DatabaseSeeder } from '../src/database/seeders/database-seeder.js';

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('database seeder', () => {
  it('runs registered seeders in order and rolls back all their writes on failure', async () => {
    const steps: string[] = [];
    const seeder = new DatabaseSeeder(dataSource.manager, [
      {
        async run(manager) {
          steps.push('identity');
          await manager.query(
            "INSERT INTO tenants (slug, name) VALUES ('orchestration-test', 'Orchestration Test')",
          );
        },
      },
      {
        async run(manager) {
          const rows: Array<{ count: string }> = await manager.query(
            "SELECT count(*) AS count FROM tenants WHERE slug = 'orchestration-test'",
          );
          expect(rows).toEqual([{ count: '1' }]);
          steps.push('product');
          throw new Error('later seed failed');
        },
      },
    ]);

    await expect(seeder.run()).rejects.toThrow('later seed failed');
    expect(steps).toEqual(['identity', 'product']);
    const rows: Array<{ count: string }> = await dataSource.query(
      "SELECT count(*) AS count FROM tenants WHERE slug = 'orchestration-test'",
    );
    expect(rows).toEqual([{ count: '0' }]);
  });
});
