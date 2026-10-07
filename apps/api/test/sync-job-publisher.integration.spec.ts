import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatcher } from '../src/sync/sync-batcher.js';
import { SyncJobPublisher } from '../src/sync/sync-job-publisher.js';
import { createSyncQueue, migrateSyncQueue } from '../src/sync/sync-queue.js';

let db: DataSource;
let queue: ReturnType<typeof createSyncQueue>;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  await migrateSyncQueue(process.env);
  await migrateSyncQueue(process.env);
  queue = createSyncQueue(process.env);
});

afterAll(async () => {
  if (queue) await queue.close();
  if (db?.isInitialized) await db.destroy();
});

describe('sync job publication over PostgreSQL', () => {
  it('persists one job for a tenant batch across queue connections', async () => {
    const tenantId = (await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-${randomUUID()}`, 'Sync Publisher Test'],
    ) as Array<{ id: string }>)[0]!.id;
    let batchId: string | undefined;
    try {
      const productId = (await db.query(
        `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
         VALUES ($1, $2, 'Sync product', 1290, 5) RETURNING id`,
        [tenantId, `SYNC-${randomUUID()}`],
      ) as Array<{ id: string }>)[0]!.id;
      await db.query(
        `INSERT INTO outbox_events
           (tenant_id, product_id, product_version, sku, stock, price_cents)
         VALUES ($1, $2, 1, 'SYNC', 5, 1290)`, [tenantId, productId],
      );
      const batch = await new SyncBatcher(db).createForTenant(tenantId);
      batchId = batch!.id;
      const jobId = `batch-${batchId}`;

      await new SyncJobPublisher(db, queue).publish(batchId);
      expect(await db.query('SELECT status, queued_at FROM sync_batches WHERE id = $1',
        [batchId])).toEqual([{ status: 'queued', queued_at: expect.any(Date) }]);
      await queue.close();
      queue = createSyncQueue(process.env);
      const job = await queue.getJob(jobId);
      expect(job?.data).toEqual({ batchId, tenantId });
      expect(await job?.getState()).toBe('waiting');

      await new SyncJobPublisher(db, queue).publish(batchId);
      expect((await queue.getJobs(['waiting'])).map((entry) => entry.id))
        .toEqual([jobId]);

      await job!.remove();
      await db.query("UPDATE sync_batches SET status = 'sent' WHERE id = $1", [batchId]);
      await new SyncJobPublisher(db, queue).publish(batchId);
      expect(await queue.getJob(jobId)).toBeUndefined();
    } finally {
      if (batchId) await (await queue.getJob(`batch-${batchId}`))?.remove();
      await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  });
});
