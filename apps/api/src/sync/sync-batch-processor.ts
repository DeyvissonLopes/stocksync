import type { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';

type JobData = { batchId: string; tenantId: string };
type BatchRow = { status: string; attempts_started: number };
type EventRow = { id: string; product_id: string; sku: string; stock: number;
  price_cents: string; product_version: string; status: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobData(value: unknown): value is JobData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.batchId === 'string' && UUID.test(data.batchId) &&
    typeof data.tenantId === 'string' && UUID.test(data.tenantId);
}

function priceFromCents(cents: string): string {
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function validAck(value: unknown, batchId: string, eventIds: string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const ack = value as Record<string, unknown>;
  if (ack.batchId !== batchId || !Array.isArray(ack.acknowledgedEventIds)) return false;
  const ids = ack.acknowledgedEventIds;
  if (ids.length !== eventIds.length || !ids.every((id) => typeof id === 'string')) {
    return false;
  }
  const unique = new Set(ids);
  return unique.size === eventIds.length && eventIds.every((id) => unique.has(id));
}

export class SyncBatchProcessor {
  constructor(private readonly db: DataSource, private readonly endpoint: string) {}

  async process(value: unknown): Promise<void> {
    if (!jobData(value)) throw new Error('Invalid sync job');
    const { batchId, tenantId } = value;
    const events = await this.reserveAndLoad(batchId, tenantId);
    if (!events) return;

    const response = await fetch(this.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId, tenantId, updates: events.map((event) => ({
        eventId: event.id, productId: event.product_id, sku: event.sku,
        stock: event.stock, price: priceFromCents(event.price_cents),
        version: event.product_version,
      })) }),
      signal: AbortSignal.timeout(2000), redirect: 'error',
    });
    if (response.status !== 200) throw new Error(`Sync destination returned ${response.status}`);
    const ack: unknown = await response.json().catch(() => null);
    const eventIds = events.map((event) => event.id);
    if (!validAck(ack, batchId, eventIds)) throw new Error('Invalid sync acknowledgement');

    await this.db.transaction((manager) =>
      this.markSent(manager, batchId, tenantId, eventIds));
  }

  private reserveAndLoad(batchId: string, tenantId: string): Promise<EventRow[] | null> {
    return this.db.transaction(async (manager) => {
      const batches: BatchRow[] = await manager.query(
        'SELECT status, attempts_started FROM sync_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [batchId, tenantId],
      );
      const batch = batches[0];
      if (!batch) throw new Error('Sync batch does not belong to job tenant');
      if (batch.status === 'sent' || batch.status === 'failed') return null;
      if (batch.status !== 'pending' && batch.status !== 'queued') {
        throw new Error('Invalid sync batch status');
      }
      if (batch.attempts_started >= 5) throw new Error('Sync attempt budget exhausted');

      const events: EventRow[] = await manager.query(
        `SELECT id, product_id, sku, stock, price_cents, product_version, status
         FROM outbox_events WHERE batch_id = $1 AND tenant_id = $2 ORDER BY id FOR UPDATE`,
        [batchId, tenantId],
      );
      if (events.length === 0 || events.length > 50 ||
        events.some((event) => event.status !== 'pending')) {
        throw new Error('Invalid sync batch events');
      }
      await manager.query(
        'UPDATE sync_batches SET attempts_started = attempts_started + 1 WHERE id = $1 AND tenant_id = $2',
        [batchId, tenantId],
      );
      return events;
    });
  }

  private async markSent(manager: EntityManager, batchId: string, tenantId: string,
    eventIds: string[]): Promise<void> {
    const batches: Array<{ status: string }> = await manager.query(
      'SELECT status FROM sync_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [batchId, tenantId],
    );
    const batch = batches[0];
    if (!batch) throw new Error('Sync batch not found at confirmation');
    if (batch.status === 'sent') return;
    if (batch.status !== 'pending' && batch.status !== 'queued') {
      throw new Error('Sync batch cannot be confirmed');
    }

    const current: Array<{ id: string; status: string }> = await manager.query(
      `SELECT id, status FROM outbox_events
       WHERE batch_id = $1 AND tenant_id = $2 ORDER BY id FOR UPDATE`, [batchId, tenantId],
    );
    if (current.length !== eventIds.length || current.some((event) =>
      event.status !== 'pending' || !eventIds.includes(event.id))) {
      throw new Error('Sync batch changed before confirmation');
    }
    await manager.query(
      `UPDATE outbox_events SET status = 'sent'
       WHERE batch_id = $1 AND tenant_id = $2 AND status = 'pending'`, [batchId, tenantId],
    );
    await manager.query(
      `UPDATE sync_batches SET status = 'sent', sent_at = now(), last_error = NULL
       WHERE id = $1 AND tenant_id = $2`, [batchId, tenantId],
    );
  }
}
