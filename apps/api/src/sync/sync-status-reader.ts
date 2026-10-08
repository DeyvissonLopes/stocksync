import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

type StatusRow = {
  pending: number;
  sent: number;
  failed: number;
  lastSuccessfulSync: Date | null;
};

@Injectable()
export class SyncStatusReader {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async read(tenantId: string) {
    const rows: StatusRow[] = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
         COUNT(*) FILTER (WHERE status = 'sent')::integer AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
         (SELECT MAX(sent_at) FROM sync_batches
          WHERE tenant_id = $1 AND status = 'sent') AS "lastSuccessfulSync"
       FROM outbox_events WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0]!;
    return { pending: row.pending, sent: row.sent, failed: row.failed,
      lastSuccessfulSync: row.lastSuccessfulSync?.toISOString() ?? null };
  }
}
