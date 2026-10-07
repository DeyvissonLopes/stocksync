import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatchReconciler } from '../src/sync/sync-batch-reconciler.js';
import { SyncBatchProcessor } from '../src/sync/sync-batch-processor.js';
import { createSyncQueue, createSyncWorker, migrateSyncQueue } from '../src/sync/sync-queue.js';

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

describe('sync batch reconciliation over PostgreSQL', () => {
  it('mirrors a retained failed job to the batch and its pending events', async () => {
    const tenantId = (await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-${randomUUID()}`, 'Sync Reconciler Failure Test'],
    ) as Array<{ id: string }>)[0]!.id;
    const productId = (await db.query(
      `INSERT INTO products (tenant_id, sku, name, stock, price_cents)
       VALUES ($1, 'RECONCILE-1', 'Reconcile Product', 1, 100) RETURNING id`,
      [tenantId],
    ) as Array<{ id: string }>)[0]!.id;
    const batchId = (await db.query(
      `INSERT INTO sync_batches (tenant_id, status) VALUES ($1, 'queued') RETURNING id`,
      [tenantId],
    ) as Array<{ id: string }>)[0]!.id;
    await db.query(
      `INSERT INTO outbox_events
       (tenant_id, product_id, batch_id, product_version, sku, stock, price_cents)
       VALUES ($1, $2, $3, 1, 'RECONCILE-1', 1, 100)`,
      [tenantId, productId, batchId],
    );
    const jobId = `batch-${batchId}`;
    try {
      await queue.add('invalid-job-type', { batchId, tenantId },
        { jobId, attempts: 1, removeOnFail: false });
      const worker = createSyncWorker(process.env,
        new SyncBatchProcessor(db, 'http://127.0.0.1:1/batches'));
      try {
        const job = await queue.getJob(jobId);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && await job?.getState() !== 'failed') {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await job?.getState()).toBe('failed');
      } finally {
        await worker.close();
      }

      expect(await new SyncBatchReconciler(db, queue).reconcile())
        .toEqual({ publicationAttempts: 0, unresolved: [] });
      expect(await db.query(
        'SELECT status, failed_at, last_error FROM sync_batches WHERE id = $1',
        [batchId],
      )).toEqual([{ status: 'failed', failed_at: expect.any(Date),
        last_error: 'JOB_FAILED' }]);
      expect(await db.query('SELECT status FROM outbox_events WHERE batch_id = $1',
        [batchId])).toEqual([{ status: 'failed' }]);
    } finally {
      await (await queue.getJob(jobId))?.remove();
      await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  });

  it('repairs both publication gaps without duplicating retained jobs', async () => {
    const tenantId = (await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-${randomUUID()}`, 'Sync Reconciler Test'],
    ) as Array<{ id: string }>)[0]!.id;
    const batches: Array<{ id: string }> = await db.query(
      `INSERT INTO sync_batches (tenant_id)
       SELECT $1 FROM generate_series(1, 5) RETURNING id`, [tenantId],
    );
    const [pendingMissing, pendingPresent, queuedMissing, queuedPresent, sent] =
      batches.map((batch) => batch.id) as [string, string, string, string, string];
    const jobId = (batchId: string) => `batch-${batchId}`;
    try {
      await queue.add('sync-batch', { batchId: pendingPresent, tenantId },
        { jobId: jobId(pendingPresent) });
      await queue.add('sync-batch', { batchId: queuedPresent, tenantId },
        { jobId: jobId(queuedPresent) });
      await db.query(
        `UPDATE sync_batches SET status = 'queued', queued_at = now()
         WHERE id IN ($1, $2)`, [queuedMissing, queuedPresent],
      );
      await db.query("UPDATE sync_batches SET status = 'sent' WHERE id = $1", [sent]);

      const reconciler = new SyncBatchReconciler(db, queue);
      expect(await reconciler.reconcile()).toEqual({ publicationAttempts: 3, unresolved: [] });
      expect(await db.query(
        'SELECT id, status, queued_at FROM sync_batches WHERE tenant_id = $1', [tenantId],
      )).toEqual(expect.arrayContaining([
        { id: pendingMissing, status: 'queued', queued_at: expect.any(Date) },
        { id: pendingPresent, status: 'queued', queued_at: expect.any(Date) },
        { id: queuedMissing, status: 'queued', queued_at: expect.any(Date) },
        { id: queuedPresent, status: 'queued', queued_at: expect.any(Date) },
        { id: sent, status: 'sent', queued_at: null },
      ]));
      const expected = [pendingMissing, pendingPresent, queuedMissing, queuedPresent]
        .map(jobId).sort();
      const matchingJobIds = async () => (await queue.getJobs(['waiting']))
        .map((job) => job.id)
        .filter((id): id is string => id !== undefined && expected.includes(id)).sort();
      expect(await matchingJobIds()).toEqual(expected);
      expect(await queue.getJob(jobId(sent))).toBeUndefined();
      expect(await reconciler.reconcile()).toEqual({ publicationAttempts: 0, unresolved: [] });
      expect(await matchingJobIds()).toEqual(expected);
    } finally {
      for (const batch of batches) await (await queue.getJob(jobId(batch.id)))?.remove();
      await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  });
});
