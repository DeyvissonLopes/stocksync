import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatchReconciler } from '../src/sync/sync-batch-reconciler.js';
import { createSyncQueue, migrateSyncQueue } from '../src/sync/sync-queue.js';

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
