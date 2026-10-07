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

describe('product movement and outbox schema', () => {
  it('keeps movement actors and event snapshots within the product tenant', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const tenant = async () => {
        const rows: Array<{ id: string }> = await runner.query(
          'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
          [`audit-${randomUUID()}`, 'Audit Test'],
        );
        return rows[0]!.id;
      };
      const tenantA = await tenant();
      const tenantB = await tenant();
      const user = async (tenantId: string) => {
        const rows: Array<{ id: string }> = await runner.query(
          `INSERT INTO users (tenant_id, email, role, password_hash)
           VALUES ($1, $2, 'admin', '$argon2id$test-hash') RETURNING id`,
          [tenantId, `${randomUUID()}@audit.test`],
        );
        return rows[0]!.id;
      };
      const actorA = await user(tenantA);
      const actorB = await user(tenantB);
      const product = async (tenantId: string) => {
        const rows: Array<{ id: string }> = await runner.query(
          `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
           VALUES ($1, 'AUDIT', 'Audit Product', 1990, 3) RETURNING id`,
          [tenantId],
        );
        return rows[0]!.id;
      };
      const productA = await product(tenantA);
      const productB = await product(tenantB);

      const movement = (tenantId: string, productId: string, actorId: string,
        delta = 3, stockAfter = 3) => runner.query(
        `INSERT INTO stock_movements
          (tenant_id, product_id, user_id, reason, quantity_delta, stock_before, stock_after)
         VALUES ($1, $2, $3, 'initial_stock', $4, 0, $5) RETURNING id`,
        [tenantId, productId, actorId, delta, stockAfter],
      ) as Promise<Array<{ id: string }>>;
      expect((await movement(tenantA, productA, actorA))[0]?.id).toBeDefined();

      const event = (tenantId: string, productId: string, stock = 3,
        version = '1') => runner.query(
        `INSERT INTO outbox_events
          (tenant_id, product_id, product_version, sku, stock, price_cents)
         VALUES ($1, $2, $3, 'AUDIT', $4, 1990)
         RETURNING id, status, product_version`,
        [tenantId, productId, version, stock],
      ) as Promise<Array<{ id: string; status: string; product_version: string }>>;
      const snapshot = (await event(tenantA, productA))[0];
      expect(snapshot).toMatchObject({ status: 'pending', product_version: '1' });
      expect(snapshot?.id).toBeDefined();

      async function rejected(operation: () => Promise<unknown>): Promise<void> {
        await runner.query('SAVEPOINT invalid_audit');
        try {
          await expect(operation()).rejects.toThrow();
        } finally {
          await runner.query('ROLLBACK TO SAVEPOINT invalid_audit');
          await runner.query('RELEASE SAVEPOINT invalid_audit');
        }
      }

      const manualMovement = (note: string | null) => runner.query(
        `INSERT INTO stock_movements
          (tenant_id, product_id, user_id, reason, note, quantity_delta,
           stock_before, stock_after)
         VALUES ($1, $2, $3, 'manual_adjustment', $4, -1, 3, 2) RETURNING id`,
        [tenantA, productA, actorA, note],
      ) as Promise<Array<{ id: string }>>;
      await rejected(() => manualMovement(null));
      await rejected(() => manualMovement('\t'));
      expect((await manualMovement('Cycle count'))[0]?.id).toBeDefined();

      await rejected(() => movement(tenantA, productB, actorA));
      await rejected(() => movement(tenantA, productA, actorB));
      await rejected(() => movement(tenantA, productA, actorA, 3, 2));
      await rejected(() => movement(tenantA, productA, actorA, 0, 0));
      await rejected(() => runner.query(
        `INSERT INTO stock_movements
          (tenant_id, product_id, user_id, reason, quantity_delta, stock_before, stock_after)
         VALUES ($1, $2, $3, 'initial_stock', -1, 0, -1)`,
        [tenantA, productA, actorA],
      ));
      await rejected(() => runner.query(
        `INSERT INTO stock_movements
          (tenant_id, product_id, user_id, reason, quantity_delta, stock_before, stock_after)
         VALUES ($1, $2, $3, 'initial_stock', 1, -1, 0)`,
        [tenantA, productA, actorA],
      ));
      await rejected(() => event(tenantA, productB));
      await rejected(() => event(tenantA, productA));
      await rejected(() => event(tenantA, productA, -1, '2'));
      await rejected(() => event(tenantA, productA, 3, '0'));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
