import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { DatabaseSeeder } from '../src/database/seeders/database-seeder.js';
import { IdentitySeeder } from '../src/database/seeders/identity-seeder.js';

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
        DELETE FROM outbox_events WHERE product_id IN
          (SELECT p.id FROM products p JOIN tenants t ON t.id = p.tenant_id
           WHERE t.slug IN ('alpha', 'beta') AND p.sku LIKE 'DEMO-%')
      `);
      await runner.query(`
        DELETE FROM stock_movements WHERE product_id IN
          (SELECT p.id FROM products p JOIN tenants t ON t.id = p.tenant_id
           WHERE t.slug IN ('alpha', 'beta') AND p.sku LIKE 'DEMO-%')
      `);
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

      const movements: Array<{
        id: string; slug: string; sku: string; email: string; reason: string;
        quantity_delta: number; stock_before: number; stock_after: number;
      }> = await runner.query(`
        SELECT m.id, t.slug, p.sku, u.email, m.reason, m.quantity_delta,
               m.stock_before, m.stock_after
        FROM stock_movements m JOIN products p ON p.id = m.product_id
        JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id
        WHERE t.slug IN ('alpha', 'beta') AND p.sku LIKE 'DEMO-%'
        ORDER BY t.slug, p.sku
      `);
      expect(movements.map(({ slug, sku, email, reason, quantity_delta, stock_before,
        stock_after }) => ({ slug, sku, email, reason, quantity_delta, stock_before,
        stock_after }))).toEqual([
        { slug: 'alpha', sku: 'DEMO-CAN', email: 'admin@alpha.stocksync.test', reason: 'seed_baseline', quantity_delta: 12, stock_before: 0, stock_after: 12 },
        { slug: 'alpha', sku: 'DEMO-NOTE', email: 'admin@alpha.stocksync.test', reason: 'seed_baseline', quantity_delta: 8, stock_before: 0, stock_after: 8 },
        { slug: 'beta', sku: 'DEMO-BAG', email: 'admin@beta.stocksync.test', reason: 'seed_baseline', quantity_delta: 7, stock_before: 0, stock_after: 7 },
        { slug: 'beta', sku: 'DEMO-CAN', email: 'admin@beta.stocksync.test', reason: 'seed_baseline', quantity_delta: 5, stock_before: 0, stock_after: 5 },
      ]);

      const events: Array<{
        id: string; slug: string; sku: string; stock: number;
        price_cents: string; product_version: string; status: string;
      }> = await runner.query(`
        SELECT e.id, t.slug, e.sku, e.stock, e.price_cents,
               e.product_version, e.status
        FROM outbox_events e JOIN tenants t ON t.id = e.tenant_id
        WHERE t.slug IN ('alpha', 'beta') AND e.sku LIKE 'DEMO-%'
        ORDER BY t.slug, e.sku
      `);
      expect(events.map(({ slug, sku, stock, price_cents, product_version, status }) =>
        ({ slug, sku, stock, price_cents, product_version, status }))).toEqual([
        { slug: 'alpha', sku: 'DEMO-CAN', stock: 12, price_cents: '2990', product_version: '1', status: 'pending' },
        { slug: 'alpha', sku: 'DEMO-NOTE', stock: 8, price_cents: '1590', product_version: '1', status: 'pending' },
        { slug: 'alpha', sku: 'DEMO-PEN', stock: 0, price_cents: '490', product_version: '1', status: 'pending' },
        { slug: 'beta', sku: 'DEMO-BAG', stock: 7, price_cents: '2490', product_version: '1', status: 'pending' },
        { slug: 'beta', sku: 'DEMO-CAN', stock: 5, price_cents: '3190', product_version: '1', status: 'pending' },
        { slug: 'beta', sku: 'DEMO-PEN', stock: 0, price_cents: '550', product_version: '1', status: 'pending' },
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
      const repeatedMovements: Array<{ id: string }> = await runner.query(
        'SELECT id FROM stock_movements WHERE product_id = ANY($1::uuid[])',
        [products.map((product) => product.id)],
      );
      const repeatedEvents: Array<{ id: string }> = await runner.query(
        'SELECT id FROM outbox_events WHERE product_id = ANY($1::uuid[])',
        [products.map((product) => product.id)],
      );
      expect(repeatedMovements.map(({ id }) => id).sort()).toEqual(
        movements.map(({ id }) => id).sort(),
      );
      expect(repeatedEvents.map(({ id }) => id).sort()).toEqual(
        events.map(({ id }) => id).sort(),
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('captures the current state of demo products seeded before audit tables existed', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new IdentitySeeder().run(runner.manager);
      const identities: Array<{ slug: string; tenant_id: string; admin_id: string }> =
        await runner.query(`
          SELECT t.slug, t.id AS tenant_id, u.id AS admin_id
          FROM tenants t JOIN users u ON u.tenant_id = t.id
            AND u.email = 'admin@' || t.slug || '.stocksync.test'
          WHERE t.slug IN ('alpha', 'beta') ORDER BY t.slug
        `);
      const alpha = identities[0]!;
      const beta = identities[1]!;

      const priorProducts: Array<{ id: string }> = await runner.query(`
        SELECT p.id FROM products p JOIN tenants t ON t.id = p.tenant_id
        WHERE (t.slug = 'alpha' AND p.sku = 'DEMO-CAN') OR
              (t.slug = 'beta' AND p.sku = 'DEMO-PEN')
      `);
      const priorIds = priorProducts.map(({ id }) => id);
      await runner.query('DELETE FROM outbox_events WHERE product_id = ANY($1::uuid[])',
        [priorIds]);
      await runner.query('DELETE FROM stock_movements WHERE product_id = ANY($1::uuid[])',
        [priorIds]);
      await runner.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [priorIds]);

      const edited: Array<{ id: string }> = await runner.query(`
        INSERT INTO products (tenant_id, sku, name, price_cents, stock, version)
        VALUES ($1, 'DEMO-CAN', 'Customized Mug', 2990, 4, 2) RETURNING id
      `, [alpha.tenant_id]);
      const archived: Array<{ id: string }> = await runner.query(`
        INSERT INTO products
          (tenant_id, sku, name, price_cents, stock, version, deleted_at, deleted_by)
        VALUES ($1, 'DEMO-PEN', 'Blue Pen', 550, 3, 3, now(), $2) RETURNING id
      `, [beta.tenant_id, beta.admin_id]);

      await new DatabaseSeeder(runner.manager).run();
      const rows: Array<{
        id: string; name: string; stock: number; version: string; deleted_at: Date | null;
      }> = await runner.query('SELECT id, name, stock, version, deleted_at FROM products WHERE id = ANY($1::uuid[])',
        [[edited[0]!.id, archived[0]!.id]]);
      expect(rows.find((row) => row.id === edited[0]!.id)).toMatchObject({
        name: 'Customized Mug', stock: 4, version: '2', deleted_at: null,
      });
      expect(rows.find((row) => row.id === archived[0]!.id)).toMatchObject({
        name: 'Blue Pen', stock: 3, version: '3',
      });
      expect(rows.find((row) => row.id === archived[0]!.id)?.deleted_at).not.toBeNull();

      const ids = [edited[0]!.id, archived[0]!.id];
      const movements: Array<{ product_id: string; stock_after: number }> =
        await runner.query(`
          SELECT product_id, stock_after FROM stock_movements
          WHERE product_id = ANY($1::uuid[])
        `, [ids]);
      expect(movements).toEqual(expect.arrayContaining([
        { product_id: edited[0]!.id, stock_after: 4 },
        { product_id: archived[0]!.id, stock_after: 3 },
      ]));
      expect(movements).toHaveLength(2);

      const events: Array<{ product_id: string; product_version: string; stock: number }> =
        await runner.query(`
          SELECT product_id, product_version, stock FROM outbox_events
          WHERE product_id = ANY($1::uuid[])
        `, [ids]);
      expect(events).toEqual(expect.arrayContaining([
        { product_id: edited[0]!.id, product_version: '2', stock: 4 },
        { product_id: archived[0]!.id, product_version: '3', stock: 0 },
      ]));
      expect(events).toHaveLength(2);

      await new DatabaseSeeder(runner.manager).run();
      const counts: Array<{ movements: string; events: string }> = await runner.query(`
        SELECT (SELECT count(*) FROM stock_movements
                WHERE product_id = ANY($1::uuid[])) AS movements,
               (SELECT count(*) FROM outbox_events
                WHERE product_id = ANY($1::uuid[])) AS events
      `, [ids]);
      expect(counts).toEqual([{ movements: '2', events: '2' }]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
