import type { DataSource } from 'typeorm';
import { syncBatchJobId } from './sync-queue.js';
import type { createSyncQueue } from './sync-queue.js';

export class SyncJobPublisher {
  constructor(private readonly dataSource: DataSource,
    private readonly queue: ReturnType<typeof createSyncQueue>) {}

  async publish(batchId: string): Promise<void> {
    const batches: Array<{ tenant_id: string; status: string }> = await this.dataSource.query(
      'SELECT tenant_id, status FROM sync_batches WHERE id = $1', [batchId],
    );
    const batch = batches[0];
    if (!batch) throw new Error('Sync batch not found');
    if (batch.status !== 'pending' && batch.status !== 'queued') return;

    await this.queue.add('sync-batch', { batchId, tenantId: batch.tenant_id }, {
      jobId: syncBatchJobId(batchId),
      removeOnComplete: false,
      removeOnFail: false,
    });
    await this.dataSource.query(
      `UPDATE sync_batches SET status = 'queued', queued_at = COALESCE(queued_at, now())
       WHERE id = $1 AND status = 'pending'`, [batchId],
    );
  }
}
