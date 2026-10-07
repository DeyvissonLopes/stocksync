import type { DataSource, EntityManager } from 'typeorm';
import type { MockBatch, MockUpdate } from './mock-sync-contract.js';

export class MockVersionConflictError extends Error {}

type Stored = { sku: string; stock: number; price_cents: string; version: string };

async function applyOne(manager: EntityManager, tenantId: string, item: MockUpdate) {
  const applied: Array<{ version: string }> = await manager.query(
    `INSERT INTO mock_sync.products
       (tenant_id, product_id, sku, stock, price_cents, version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET sku = EXCLUDED.sku, stock = EXCLUDED.stock,
           price_cents = EXCLUDED.price_cents, version = EXCLUDED.version,
           updated_at = now()
       WHERE mock_sync.products.version < EXCLUDED.version
     RETURNING version`,
    [tenantId, item.productId, item.sku, item.stock, item.priceCents, item.version],
  );
  if (applied.length > 0) return;

  const existing: Stored[] = await manager.query(
    `SELECT sku, stock, price_cents, version FROM mock_sync.products
     WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE`,
    [tenantId, item.productId],
  );
  const current = existing[0];
  if (!current) throw new Error('Missing mock product after conflict');
  if (BigInt(current.version) === BigInt(item.version) &&
    (current.sku !== item.sku || current.stock !== item.stock ||
      BigInt(current.price_cents) !== BigInt(item.priceCents))) {
    throw new MockVersionConflictError('Same version has different values');
  }
}

export class MockSyncStore {
  constructor(private readonly db: DataSource) {}

  apply(batch: MockBatch): Promise<void> {
    return this.db.transaction(async (manager) => {
      // A stable lock order avoids deadlocks when batches overlap on several products.
      const ordered = [...batch.updates].sort((left, right) =>
        left.productId.localeCompare(right.productId) ||
        (BigInt(left.version) < BigInt(right.version) ? -1 :
          BigInt(left.version) > BigInt(right.version) ? 1 : 0));
      for (const item of ordered) await applyOne(manager, batch.tenantId, item);
    });
  }
}
