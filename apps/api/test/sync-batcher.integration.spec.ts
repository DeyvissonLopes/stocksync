import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatcher } from '../src/sync/sync-batcher.js';

let db: DataSource;
let batcher: SyncBatcher;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  batcher = new SyncBatcher(db);
});

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
});

type Fixture = { tenantA: string; tenantB: string; productA: string; productB: string };

async function withFixture(check: (fixture: Fixture) => Promise<void>) {
  const tenant = async () => {
    const rows: Array<{ id: string }> = await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-batcher-${randomUUID()}`, 'Sync Batcher Test'],
    );
    return rows[0]!.id;
  };
  const tenantA = await tenant();
  const tenantB = await tenant();
  const product = async (tenantId: string) => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
       VALUES ($1, $2, 'Sync product', 1290, 5) RETURNING id`,
      [tenantId, `SYNC-${randomUUID()}`],
    );
    return rows[0]!.id;
  };
  try {
    await check({ tenantA, tenantB,
      productA: await product(tenantA), productB: await product(tenantB) });
  } finally {
    await db.query('DELETE FROM outbox_events WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM sync_batches WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM products WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  }
}

async function events(tenantId: string, productId: string, count: number) {
  return db.query(
    `INSERT INTO outbox_events
       (tenant_id, product_id, product_version, sku, stock, price_cents, created_at)
     SELECT $1, $2, version, 'SYNC', 5, 1290, now() + version * interval '1 millisecond'
     FROM generate_series(1, $3::integer) AS version
     RETURNING id, product_version`,
    [tenantId, productId, count],
  ) as Promise<Array<{ id: string; product_version: string }>>;
}

describe('sync batch assignment over PostgreSQL', () => {
  it('chooses the tenant of the oldest pending event, then the next tenant',
    async () => withFixture(async ({ tenantA, tenantB, productA, productB }) => {
      expect(await batcher.createNext()).toBeNull();
      const a = await events(tenantA, productA, 2);
      const b = await events(tenantB, productB, 1);
      await db.query('UPDATE outbox_events SET created_at = $1 WHERE id = $2',
        ['2000-01-01T00:00:00.000Z', a[0]!.id]);
      await db.query('UPDATE outbox_events SET created_at = $1 WHERE id = $2',
        ['2000-01-01T00:00:00.001Z', b[0]!.id]);
      await db.query('UPDATE outbox_events SET created_at = $1 WHERE id = $2',
        ['2000-01-01T00:00:00.002Z', a[1]!.id]);

      const first = await batcher.createNext();
      expect(first).toMatchObject({ tenantId: tenantA,
        eventIds: [a[0]!.id, a[1]!.id] });
      const second = await batcher.createNext();
      expect(second).toMatchObject({ tenantId: tenantB, eventIds: [b[0]!.id] });
      expect(await batcher.createNext()).toBeNull();
      expect(await db.query('SELECT tenant_id, id FROM sync_batches WHERE id IN ($1, $2)',
        [first!.id, second!.id])).toEqual(expect.arrayContaining([
        { tenant_id: tenantA, id: first!.id },
        { tenant_id: tenantB, id: second!.id },
      ]));
    }));

  it('can choose another tenant while the oldest event is locked',
    async () => withFixture(async ({ tenantA, tenantB, productA, productB }) => {
      const a = (await events(tenantA, productA, 1))[0]!;
      const b = (await events(tenantB, productB, 1))[0]!;
      await db.query('UPDATE outbox_events SET created_at = $1 WHERE id = $2',
        ['2000-01-01T00:00:00.000Z', a.id]);
      await db.query('UPDATE outbox_events SET created_at = $1 WHERE id = $2',
        ['2000-01-01T00:00:00.001Z', b.id]);

      const locker: QueryRunner = db.createQueryRunner();
      await locker.connect();
      await locker.startTransaction();
      await locker.query('SELECT id FROM outbox_events WHERE id = $1 FOR UPDATE', [a.id]);
      const claim = batcher.createNext();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          claim,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Dispatcher waited on lock')), 2000);
          }),
        ]);
        expect(result).toMatchObject({ tenantId: tenantB, eventIds: [b.id] });
        expect(await batcher.createNext()).toBeNull();
      } finally {
        clearTimeout(timeout);
        await locker.rollbackTransaction();
        await locker.release();
        await claim.catch(() => undefined);
      }
      expect(await batcher.createNext()).toMatchObject({
        tenantId: tenantA, eventIds: [a.id],
      });
    }));

  it('claims at most 50 ordered pending events from one tenant, then leaves no empty batch',
    async () => withFixture(async ({ tenantA, tenantB, productA, productB }) => {
      expect(await batcher.createForTenant(tenantA)).toBeNull();
      await events(tenantA, productA, 53);
      await events(tenantB, productB, 2);

      const first = await batcher.createForTenant(tenantA);
      expect(first).toMatchObject({ id: expect.any(String), tenantId: tenantA });
      expect(first?.eventIds).toHaveLength(50);
      expect(await db.query(
        `SELECT product_version FROM outbox_events
         WHERE batch_id = $1 ORDER BY created_at, id`, [first!.id],
      )).toEqual(Array.from({ length: 50 }, (_, index) =>
        ({ product_version: String(index + 1) })));

      const second = await batcher.createForTenant(tenantA);
      expect(second?.eventIds).toHaveLength(3);
      expect(second?.id).not.toBe(first?.id);
      expect(await batcher.createForTenant(tenantA)).toBeNull();
      expect(await db.query(
        'SELECT count(*)::integer AS count FROM sync_batches WHERE tenant_id = $1', [tenantA],
      )).toEqual([{ count: 2 }]);
      expect(await db.query(
        'SELECT count(*)::integer AS count FROM outbox_events WHERE tenant_id = $1 AND batch_id IS NULL',
        [tenantB],
      )).toEqual([{ count: 2 }]);
    }));

  it('ignores sent, failed and already batched events',
    async () => withFixture(async ({ tenantA, productA }) => {
      const inserted = await events(tenantA, productA, 4);
      const existing: Array<{ id: string }> = await db.query(
        'INSERT INTO sync_batches (tenant_id) VALUES ($1) RETURNING id', [tenantA],
      );
      await db.query("UPDATE outbox_events SET status = 'sent' WHERE id = $1", [inserted[0]!.id]);
      await db.query("UPDATE outbox_events SET status = 'failed' WHERE id = $1", [inserted[1]!.id]);
      await db.query('UPDATE outbox_events SET batch_id = $1 WHERE id = $2',
        [existing[0]!.id, inserted[2]!.id]);

      const claimed = await batcher.createForTenant(tenantA);
      expect(claimed?.eventIds).toEqual([inserted[3]!.id]);
      expect(await batcher.createForTenant(tenantA)).toBeNull();
      expect(await db.query('SELECT id, batch_id FROM outbox_events WHERE id = $1',
        [inserted[2]!.id])).toEqual([{ id: inserted[2]!.id, batch_id: existing[0]!.id }]);
    }));

  it('does not assign the same event to two concurrent batchers',
    async () => withFixture(async ({ tenantA, productA }) => {
      await events(tenantA, productA, 75);
      const batches = await Promise.all([
        batcher.createForTenant(tenantA), batcher.createForTenant(tenantA),
      ]);
      expect(batches.every((batch) => batch !== null)).toBe(true);
      const ids = batches.flatMap((batch) => batch!.eventIds);
      expect(ids).toHaveLength(75);
      expect(new Set(ids).size).toBe(75);
      expect(batches.every((batch) => batch!.eventIds.length <= 50)).toBe(true);
      expect(await batcher.createForTenant(tenantA)).toBeNull();
      expect(await db.query(
        `SELECT batch_id, count(*)::integer AS count FROM outbox_events
         WHERE tenant_id = $1 GROUP BY batch_id`, [tenantA],
      )).toEqual(expect.arrayContaining(batches.map((batch) =>
        ({ batch_id: batch!.id, count: batch!.eventIds.length }))));
    }));

  it('skips a locked event without waiting for its transaction',
    async () => withFixture(async ({ tenantA, productA }) => {
      const inserted = await events(tenantA, productA, 3);
      const locker: QueryRunner = db.createQueryRunner();
      await locker.connect();
      await locker.startTransaction();
      await locker.query('SELECT id FROM outbox_events WHERE id = $1 FOR UPDATE',
        [inserted[0]!.id]);
      const claim = batcher.createForTenant(tenantA);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          claim,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Batcher waited on lock')), 2000);
          }),
        ]);
        expect(result?.eventIds).toEqual([inserted[1]!.id, inserted[2]!.id]);
      } finally {
        clearTimeout(timeout);
        await locker.rollbackTransaction();
        await locker.release();
        await claim.catch(() => undefined);
      }
      expect((await db.query('SELECT batch_id FROM outbox_events WHERE id = $1',
        [inserted[0]!.id]))[0]).toEqual({ batch_id: null });
    }));
});
