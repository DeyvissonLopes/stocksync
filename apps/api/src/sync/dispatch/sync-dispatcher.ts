import type { DataSource } from 'typeorm';
import { SyncBatcher } from './sync-batcher.js';
import { SyncBatchReconciler } from './sync-batch-reconciler.js';
import type { SyncReconcileResult } from './sync-batch-reconciler.js';
import { SyncJobPublisher } from './sync-job-publisher.js';
import type { createSyncQueue } from '../queue/sync-queue.js';

export type SyncDispatchResult = {
  reconciliation: SyncReconcileResult;
  batchId: string | null;
};

export class SyncDispatcher {
  constructor(private readonly dataSource: DataSource,
    private readonly queue: ReturnType<typeof createSyncQueue>) {}

  async runOnce(): Promise<SyncDispatchResult> {
    const reconciliation = await new SyncBatchReconciler(this.dataSource, this.queue).reconcile();
    const batch = await new SyncBatcher(this.dataSource).createNext();
    if (batch) await new SyncJobPublisher(this.dataSource, this.queue).publish(batch.id);
    return { reconciliation, batchId: batch?.id ?? null };
  }
}
