import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type SyncBatch = { id: string; tenantId: string; eventIds: string[] };
const MAX_BATCH_EVENTS = 50;

@Injectable()
export class SyncBatcher {
  constructor(private readonly dataSource: DataSource) {}

  createForTenant(tenantId: string): Promise<SyncBatch | null> {
    return this.dataSource.transaction(async (manager) => {
      const events: Array<{ id: string }> = await manager.query(
        `SELECT id FROM outbox_events
         WHERE tenant_id = $1 AND status = 'pending' AND batch_id IS NULL
         ORDER BY created_at, id
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [tenantId, MAX_BATCH_EVENTS],
      );
      if (events.length === 0) return null;

      const batches: Array<{ id: string }> = await manager.query(
        'INSERT INTO sync_batches (tenant_id) VALUES ($1) RETURNING id', [tenantId],
      );
      const id = batches[0]!.id;
      const eventIds = events.map((event) => event.id);
      const [linked]: [Array<{ id: string }>, number] = await manager.query(
        `UPDATE outbox_events SET batch_id = $1
         WHERE tenant_id = $2 AND id = ANY($3::uuid[])
           AND status = 'pending' AND batch_id IS NULL
         RETURNING id`,
        [id, tenantId, eventIds],
      );
      if (linked.length !== eventIds.length) {
        throw new Error('Could not assign all selected outbox events');
      }
      return { id, tenantId, eventIds };
    });
  }
}
