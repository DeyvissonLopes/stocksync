import type { EntityManager } from 'typeorm';

export async function markSyncBatchFailed(manager: EntityManager, batchId: string,
  tenantId: string, reason: string): Promise<void> {
  const batches: Array<{ status: string; last_error: string | null }> = await manager.query(
    'SELECT status, last_error FROM sync_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [batchId, tenantId],
  );
  const batch = batches[0];
  if (!batch) throw new Error('Sync batch not found');
  if (batch.status === 'sent' || batch.status === 'failed') return;
  if (batch.status !== 'pending' && batch.status !== 'queued') {
    throw new Error('Invalid sync batch status');
  }
  await manager.query(
    `UPDATE outbox_events SET status = 'failed'
     WHERE batch_id = $1 AND tenant_id = $2 AND status = 'pending'`, [batchId, tenantId],
  );
  await manager.query(
    `UPDATE sync_batches SET status = 'failed', failed_at = now(), last_error = $3
     WHERE id = $1 AND tenant_id = $2`,
    [batchId, tenantId, reason === 'JOB_FAILED' ? batch.last_error ?? reason : reason],
  );
}
