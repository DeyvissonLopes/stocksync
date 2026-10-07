import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { PreparedSaleRequest } from './sale-request.js';

type SaleRow = { id: string; request_hash: string; created_at: Date };
type SaleItemRow = { product_id: string; quantity: number; unit_price_cents: string };
type UpdatedProduct = {
  sku: string;
  price_cents: string;
  stock: number;
  version: string;
};

export type SaleView = {
  id: string;
  createdAt: string;
  items: Array<{ productId: string; quantity: number; unitPrice: string }>;
};

function decimalPrice(cents: string): string {
  const amount = BigInt(cents);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

async function readSale(manager: EntityManager, tenantId: string, id: string): Promise<SaleView> {
  const sales: SaleRow[] = await manager.query(
    'SELECT id, request_hash, created_at FROM sales WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  const items: SaleItemRow[] = await manager.query(
    `SELECT product_id, quantity, unit_price_cents FROM sale_items
     WHERE tenant_id = $1 AND sale_id = $2 ORDER BY product_id`,
    [tenantId, id],
  );
  return {
    id,
    createdAt: sales[0]!.created_at.toISOString(),
    items: items.map((item) => ({
      productId: item.product_id,
      quantity: item.quantity,
      unitPrice: decimalPrice(item.unit_price_cents),
    })),
  };
}

@Injectable()
export class SaleWriter {
  constructor(private readonly dataSource: DataSource) {}

  create(tenantId: string, userId: string, request: PreparedSaleRequest): Promise<SaleView> {
    return this.dataSource.transaction(async (manager) => {
      const inserted: Array<{ id: string }> = await manager.query(
        `INSERT INTO sales (tenant_id, user_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, userId, request.idempotencyKey, request.requestHash],
      );
      if (inserted.length === 0) {
        const existing: SaleRow[] = await manager.query(
          `SELECT id, request_hash, created_at FROM sales
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, request.idempotencyKey],
        );
        if (existing[0]?.request_hash !== request.requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key reused for another sale',
          });
        }
        return readSale(manager, tenantId, existing[0].id);
      }

      const saleId = inserted[0]!.id;
      for (const item of request.items) {
        const [updated]: [UpdatedProduct[], number] = await manager.query(
          `UPDATE products
           SET stock = stock - $1, version = version + 1, updated_at = now()
           WHERE tenant_id = $2 AND id = $3 AND deleted_at IS NULL AND stock >= $1
           RETURNING sku, price_cents, stock, version`,
          [item.quantity, tenantId, item.productId],
        );
        const product = updated[0];
        if (!product) {
          const active: Array<{ id: string }> = await manager.query(
            `SELECT id FROM products WHERE tenant_id = $1 AND id = $2
             AND deleted_at IS NULL`, [tenantId, item.productId],
          );
          if (active.length === 0) throw new NotFoundException();
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock',
          });
        }

        await manager.query(
          `INSERT INTO sale_items
             (tenant_id, sale_id, product_id, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, saleId, item.productId, item.quantity, product.price_cents],
        );
        await manager.query(
          `INSERT INTO stock_movements
             (tenant_id, product_id, user_id, sale_id, reason, quantity_delta,
              stock_before, stock_after)
           VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7)`,
          [tenantId, item.productId, userId, saleId, -item.quantity,
            product.stock + item.quantity, product.stock],
        );
        await manager.query(
          `INSERT INTO outbox_events
             (tenant_id, product_id, product_version, sku, stock, price_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, item.productId, product.version, product.sku,
            product.stock, product.price_cents],
        );
      }

      return readSale(manager, tenantId, saleId);
    });
  }
}
