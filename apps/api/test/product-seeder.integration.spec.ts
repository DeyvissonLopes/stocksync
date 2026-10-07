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

describe('product seeder', () => {
  it('creates repeatable demo products in both tenants without replacing later changes', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`
        DELETE FROM products WHERE tenant_id IN
          (SELECT id FROM tenants WHERE slug IN ('alpha', 'beta'))
          AND sku LIKE 'DEMO-%'
      `);
      await new DatabaseSeeder(runner.manager).run();

      const products: Array<{
        id: string; slug: string; sku: string; name: string;
        price_cents: string; stock: number; version: string; deleted_at: Date | null;
      }> = await runner.query(`
        SELECT p.id, t.slug, p.sku, p.name, p.price_cents, p.stock,
               p.version, p.deleted_at
        FROM products p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug IN ('alpha', 'beta') AND p.sku LIKE 'DEMO-%'
        ORDER BY t.slug, p.sku
      `);
      expect(products.map(({ slug, sku, name, price_cents, stock, version, deleted_at }) =>
        ({ slug, sku, name, price_cents, stock, version, deleted_at }))).toEqual([
        { slug: 'alpha', sku: 'DEMO-CAN', name: 'Blue Mug', price_cents: '2990', stock: 12, version: '1', deleted_at: null },
        { slug: 'alpha', sku: 'DEMO-NOTE', name: 'A5 Notebook', price_cents: '1590', stock: 8, version: '1', deleted_at: null },
        { slug: 'alpha', sku: 'DEMO-PEN', name: 'Black Pen', price_cents: '490', stock: 0, version: '1', deleted_at: null },
        { slug: 'beta', sku: 'DEMO-BAG', name: 'Tote Bag', price_cents: '2490', stock: 7, version: '1', deleted_at: null },
        { slug: 'beta', sku: 'DEMO-CAN', name: 'Red Mug', price_cents: '3190', stock: 5, version: '1', deleted_at: null },
        { slug: 'beta', sku: 'DEMO-PEN', name: 'Blue Pen', price_cents: '550', stock: 0, version: '1', deleted_at: null },
      ]);

      const editedId = products.find((product) => product.slug === 'alpha' &&
        product.sku === 'DEMO-CAN')!.id;
      await runner.query("UPDATE products SET name = 'Customized Mug', stock = 4, version = 2 WHERE id = $1", [editedId]);
      const archivedId = products.find((product) => product.slug === 'beta' &&
        product.sku === 'DEMO-PEN')!.id;
      await runner.query(`
        UPDATE products SET deleted_at = now(), deleted_by =
          (SELECT u.id FROM users u WHERE u.email = 'admin@beta.stocksync.test')
        WHERE id = $1
      `, [archivedId]);

      await new DatabaseSeeder(runner.manager).run();
      const repeated: Array<{
        id: string; name: string; stock: number; version: string; deleted_at: Date | null;
      }> = await runner.query(`
        SELECT p.id, p.name, p.stock, p.version, p.deleted_at
        FROM products p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug IN ('alpha', 'beta') AND p.sku LIKE 'DEMO-%'
      `);
      expect(repeated).toHaveLength(6);
      expect(repeated.find((product) => product.id === editedId)).toMatchObject({
        name: 'Customized Mug', stock: 4, version: '2',
      });
      expect(repeated.find((product) => product.id === archivedId)?.deleted_at).not.toBeNull();
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
