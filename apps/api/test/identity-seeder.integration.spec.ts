import 'reflect-metadata';
import argon2 from 'argon2';
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

describe('identity seeder', () => {
  it('creates two tenants and four users once, with verifiable password hashes', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new DatabaseSeeder(runner.manager).run();
      const first: Array<{
        slug: string;
        email: string;
        role: string;
        password_hash: string;
      }> = await runner.query(`
        SELECT t.slug, u.email, u.role, u.password_hash
        FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug IN ('alpha', 'beta') ORDER BY t.slug, u.role
      `);
      expect(first.map(({ slug, email, role }) => ({ slug, email, role }))).toEqual([
        { slug: 'alpha', email: 'admin@alpha.stocksync.test', role: 'admin' },
        { slug: 'alpha', email: 'operator@alpha.stocksync.test', role: 'operator' },
        { slug: 'beta', email: 'admin@beta.stocksync.test', role: 'admin' },
        { slug: 'beta', email: 'operator@beta.stocksync.test', role: 'operator' },
      ]);
      for (const user of first) {
        expect(user.password_hash).toMatch(/^\$argon2id\$/);
        expect(await argon2.verify(user.password_hash, 'StockSyncDemo123!')).toBe(true);
      }

      await new DatabaseSeeder(runner.manager).run();
      const repeated: Array<{ email: string; password_hash: string }> = await runner.query(`
        SELECT u.email, u.password_hash FROM users u
        JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug IN ('alpha', 'beta') ORDER BY t.slug, u.role
      `);
      expect(repeated).toEqual(first.map(({ email, password_hash }) => ({ email, password_hash })));
      const counts: Array<{ tenants: string; users: string }> = await runner.query(`
        SELECT (SELECT count(*) FROM tenants WHERE slug IN ('alpha', 'beta')) AS tenants,
               (SELECT count(*) FROM users u JOIN tenants t ON t.id = u.tenant_id
                WHERE t.slug IN ('alpha', 'beta')) AS users
      `);
      expect(counts).toEqual([{ tenants: '2', users: '4' }]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
