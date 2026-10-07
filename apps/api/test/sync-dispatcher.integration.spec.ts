import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatcher } from '../src/sync/sync-batcher.js';
import { SyncDispatcher } from '../src/sync/sync-dispatcher.js';
import { createSyncQueue, migrateSyncQueue, syncBatchJobId } from '../src/sync/sync-queue.js';

let db: DataSource;
let queue: ReturnType<typeof createSyncQueue>;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  await migrateSyncQueue(process.env);
  queue = createSyncQueue(process.env);
});

afterAll(async () => {
  if (queue) await queue.close();
  if (db?.isInitialized) await db.destroy();
});

async function withFixture(check: (tenantId: string, productId: string) => Promise<void>) {
  const tenantId = (await db.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`sync-${randomUUID()}`, 'Sync Dispatcher Test'],
  ) as Array<{ id: string }>)[0]!.id;
  const productId = (await db.query(
    `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
     VALUES ($1, $2, 'Sync product', 1290, 5) RETURNING id`,
    [tenantId, `SYNC-${randomUUID()}`],
  ) as Array<{ id: string }>)[0]!.id;
  try {
    await check(tenantId, productId);
  } finally {
    const batches: Array<{ id: string }> = await db.query(
      'SELECT id FROM sync_batches WHERE tenant_id = $1', [tenantId],
    );
    for (const batch of batches) await (await queue.getJob(syncBatchJobId(batch.id)))?.remove();
    await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
}

async function addEvent(tenantId: string, productId: string, version: number) {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO outbox_events
       (tenant_id, product_id, product_version, sku, stock, price_cents)
     VALUES ($1, $2, $3, 'SYNC', 5, 1290) RETURNING id`,
    [tenantId, productId, version],
  );
  return rows[0]!.id;
}

describe('one sync dispatcher round over PostgreSQL', () => {
  it('recovers an existing batch before forming and publishing a new one',
    async () => withFixture(async (tenantId, productId) => {
      await addEvent(tenantId, productId, 1);
      const oldBatch = (await new SyncBatcher(db).createForTenant(tenantId))!;
      const newEventId = await addEvent(tenantId, productId, 2);
      const dispatcher = new SyncDispatcher(db, queue);
      const failure = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('queue unavailable'));
      try {
        await expect(dispatcher.runOnce()).rejects.toThrow('queue unavailable');
      } finally {
        failure.mockRestore();
      }
      expect(await db.query('SELECT batch_id FROM outbox_events WHERE id = $1',
        [newEventId])).toEqual([{ batch_id: null }]);
      expect(await db.query('SELECT count(*)::integer AS count FROM sync_batches WHERE tenant_id = $1',
        [tenantId])).toEqual([{ count: 1 }]);

      const result = await dispatcher.runOnce();
      expect(result.reconciliation).toEqual({ publicationAttempts: 1, unresolved: [] });
      expect(result.batchId).toEqual(expect.any(String));
      expect(result.batchId).not.toBe(oldBatch.id);
      expect(await queue.getJob(syncBatchJobId(oldBatch.id))).toBeDefined();
      expect(await queue.getJob(syncBatchJobId(result.batchId!))).toBeDefined();
      expect(await db.query('SELECT batch_id FROM outbox_events WHERE id = $1',
        [newEventId])).toEqual([{ batch_id: result.batchId }]);
      expect(await dispatcher.runOnce()).toEqual({
        reconciliation: { publicationAttempts: 0, unresolved: [] }, batchId: null,
      });
    }));

  it('keeps a newly formed batch when publication fails and repairs it next round',
    async () => withFixture(async (tenantId, productId) => {
      const eventId = await addEvent(tenantId, productId, 1);
      const dispatcher = new SyncDispatcher(db, queue);
      const failure = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('queue unavailable'));
      try {
        await expect(dispatcher.runOnce()).rejects.toThrow('queue unavailable');
      } finally {
        failure.mockRestore();
      }
      const batches: Array<{ id: string; status: string }> = await db.query(
        'SELECT id, status FROM sync_batches WHERE tenant_id = $1', [tenantId],
      );
      expect(batches).toEqual([{ id: expect.any(String), status: 'pending' }]);
      expect(await db.query('SELECT batch_id FROM outbox_events WHERE id = $1',
        [eventId])).toEqual([{ batch_id: batches[0]!.id }]);
      expect(await queue.getJob(syncBatchJobId(batches[0]!.id))).toBeUndefined();

      expect(await dispatcher.runOnce()).toEqual({
        reconciliation: { publicationAttempts: 1, unresolved: [] }, batchId: null,
      });
      expect(await db.query('SELECT id, status FROM sync_batches WHERE tenant_id = $1',
        [tenantId])).toEqual([{ id: batches[0]!.id, status: 'queued' }]);
      expect(await queue.getJob(syncBatchJobId(batches[0]!.id))).toBeDefined();
    }));
});
