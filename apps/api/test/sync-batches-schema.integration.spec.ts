import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';

let db: DataSource;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
});

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
});

async function withFixture(check: (runner: QueryRunner, tenantA: string,
  tenantB: string, eventA: string, eventB: string) => Promise<void>) {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const tenant = async () => {
      const rows: Array<{ id: string }> = await runner.query(
        'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
        [`sync-${randomUUID()}`, 'Sync Schema Test'],
      );
      return rows[0]!.id;
    };
    const tenantA = await tenant();
    const tenantB = await tenant();
    const event = async (tenantId: string) => {
      const sku = `SYNC-${randomUUID()}`;
      const products: Array<{ id: string }> = await runner.query(
        `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
         VALUES ($1, $2, 'Sync Product', 1290, 5) RETURNING id`,
        [tenantId, sku],
      );
      const rows: Array<{ id: string }> = await runner.query(
        `INSERT INTO outbox_events
           (tenant_id, product_id, product_version, sku, stock, price_cents)
         VALUES ($1, $2, 1, $3, 5, 1290) RETURNING id`,
        [tenantId, products[0]!.id, sku],
      );
      return rows[0]!.id;
    };
    await check(runner, tenantA, tenantB, await event(tenantA), await event(tenantB));
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

async function rejected(runner: QueryRunner, operation: () => Promise<unknown>) {
  await runner.query('SAVEPOINT invalid_batch');
  try {
    await expect(operation()).rejects.toThrow();
  } finally {
    await runner.query('ROLLBACK TO SAVEPOINT invalid_batch');
    await runner.query('RELEASE SAVEPOINT invalid_batch');
  }
}

function batch(runner: QueryRunner, tenantId: string) {
  return runner.query(
    `INSERT INTO sync_batches (tenant_id) VALUES ($1)
     RETURNING id, tenant_id, status, attempts_started, created_at`,
    [tenantId],
  ) as Promise<Array<{ id: string; tenant_id: string; status: string;
    attempts_started: number; created_at: Date }>>;
}

describe('sync batch schema over PostgreSQL', () => {
  it('persists a tenant batch with valid status and nonnegative attempt count',
    async () => withFixture(async (runner, tenantA) => {
      const created = (await batch(runner, tenantA))[0]!;
      expect(created).toMatchObject({
        id: expect.any(String), tenant_id: tenantA, status: 'pending', attempts_started: 0,
        created_at: expect.any(Date),
      });
      await rejected(runner, () => runner.query(
        "UPDATE sync_batches SET status = 'unknown' WHERE id = $1", [created.id]));
      await rejected(runner, () => runner.query(
        'UPDATE sync_batches SET attempts_started = -1 WHERE id = $1', [created.id]));
    }));

  it('links an outbox event only to a batch from its own tenant',
    async () => withFixture(async (runner, tenantA, tenantB, eventA, eventB) => {
      const batchA = (await batch(runner, tenantA))[0]!.id;
      const batchB = (await batch(runner, tenantB))[0]!.id;
      const [linked]: [Array<{ tenant_id: string; batch_id: string }>, number] = await runner.query(
        'UPDATE outbox_events SET batch_id = $1 WHERE id = $2 RETURNING tenant_id, batch_id',
        [batchA, eventA],
      );
      expect(linked).toEqual([{ tenant_id: tenantA, batch_id: batchA }]);
      await rejected(runner, () => runner.query(
        'UPDATE outbox_events SET batch_id = $1 WHERE id = $2', [batchB, eventA]));
      await rejected(runner, () => runner.query(
        'UPDATE outbox_events SET batch_id = $1 WHERE id = $2', [randomUUID(), eventB]));
      expect(await runner.query('SELECT batch_id FROM outbox_events WHERE id = $1', [eventB]))
        .toEqual([{ batch_id: null }]);
      await rejected(runner, () => runner.query(
        'DELETE FROM sync_batches WHERE id = $1', [batchA]));
    }));
});
