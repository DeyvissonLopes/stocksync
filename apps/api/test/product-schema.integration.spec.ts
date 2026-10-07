import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('product schema', () => {
  it('keeps product identity and archived SKUs within one tenant', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const manager = runner.manager;
      const tenant = async () => {
        const rows: Array<{ id: string }> = await manager.query(
          'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
          [`product-${randomUUID().slice(0, 8)}`, 'Product Schema Test'],
        );
        return rows[0]!.id;
      };
      const tenantA = await tenant();
      const tenantB = await tenant();
      const user = async (tenantId: string) => {
        const rows: Array<{ id: string }> = await manager.query(
          `INSERT INTO users (tenant_id, email, role, password_hash)
           VALUES ($1, $2, 'admin', '$argon2id$test-hash') RETURNING id`,
          [tenantId, `product-${randomUUID()}@schema.test`],
        );
        return rows[0]!.id;
      };
      const actorA = await user(tenantA);
      const actorB = await user(tenantB);
      const product = (tenantId: string, sku = 'SHARED', price = 1990, stock = 3) =>
        manager.query(
          `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
           VALUES ($1, $2, 'Sample', $3, $4) RETURNING id, version`,
          [tenantId, sku, price, stock],
        ) as Promise<Array<{ id: string; version: string }>>;
      const rowsA = await product(tenantA);
      const rowsB = await product(tenantB);
      expect(rowsA[0]?.version).toBe('1');
      expect(rowsB[0]?.version).toBe('1');

      async function rejected(operation: () => Promise<unknown>): Promise<void> {
        await manager.query('SAVEPOINT invalid_product');
        try {
          await expect(operation()).rejects.toThrow();
        } finally {
          await manager.query('ROLLBACK TO SAVEPOINT invalid_product');
          await manager.query('RELEASE SAVEPOINT invalid_product');
        }
      }

      await rejected(() => product(tenantA));
      await rejected(() => product(randomUUID(), 'ORPHAN'));
      await rejected(() => product(tenantA, 'NEGATIVE-STOCK', 1990, -1));
      await rejected(() => product(tenantA, 'NEGATIVE-PRICE', -1, 3));
      await rejected(() => manager.query(
        `INSERT INTO products (tenant_id, sku, name, price_cents, stock, version)
         VALUES ($1, 'BAD-VERSION', 'Sample', 1990, 3, 0)`,
        [tenantA],
      ));
      await rejected(() => manager.query(
        'UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
        [actorB, rowsA[0]!.id],
      ));
      await rejected(() => manager.query(
        'UPDATE products SET deleted_at = now() WHERE id = $1',
        [rowsA[0]!.id],
      ));
      await rejected(() => manager.query(
        'UPDATE products SET deleted_by = $1 WHERE id = $2',
        [actorA, rowsA[0]!.id],
      ));

      await manager.query(
        'UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
        [actorA, rowsA[0]!.id],
      );
      await rejected(() => product(tenantA));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
