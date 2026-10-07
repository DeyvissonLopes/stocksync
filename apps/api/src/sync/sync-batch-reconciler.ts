import type { DataSource } from 'typeorm';
import { markSyncBatchFailed } from './sync-batch-failure.js';
import { SyncJobPublisher } from './sync-job-publisher.js';
import { syncBatchJobId } from './sync-queue.js';
import type { createSyncQueue } from './sync-queue.js';

export type SyncReconcileResult = {
  publicationAttempts: number;
  unresolved: Array<{ batchId: string; jobState: string }>;
};

export class SyncBatchReconciler {
  constructor(private readonly dataSource: DataSource,
    private readonly queue: ReturnType<typeof createSyncQueue>) {}

  async reconcile(): Promise<SyncReconcileResult> {
    const result: SyncReconcileResult = { publicationAttempts: 0, unresolved: [] };
    const publisher = new SyncJobPublisher(this.dataSource, this.queue);
    let cursor: { created_at: Date; id: string } | undefined;

    while (true) {
      const batches: Array<{ id: string; tenant_id: string; status: string;
        created_at: Date }> =
        await this.dataSource.query(
          `SELECT id, tenant_id, status, created_at FROM sync_batches
           WHERE status IN ('pending', 'queued')
             AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
           ORDER BY created_at, id LIMIT 50`,
          [cursor?.created_at ?? null, cursor?.id ?? null],
        );
      if (batches.length === 0) return result;

      for (const batch of batches) {
        const job = await this.queue.getJob(syncBatchJobId(batch.id));
        if (!job) {
          await publisher.publish(batch.id);
          result.publicationAttempts++;
          continue;
        }
        const state = await job.getState();
        if (state === 'failed') {
          await this.dataSource.transaction((manager) =>
            markSyncBatchFailed(manager, batch.id, batch.tenant_id, 'JOB_FAILED'));
          continue;
        }
        if (state === 'completed' || state === 'unknown') {
          result.unresolved.push({ batchId: batch.id, jobState: state });
          continue;
        }
        if (batch.status === 'pending') {
          await publisher.publish(batch.id);
          result.publicationAttempts++;
        }
      }

      cursor = batches[batches.length - 1]!;
      if (batches.length < 50) return result;
    }
  }
}
