import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull, QueryFailedError } from 'typeorm';
import { ProductEntity } from '../database/entities/product.entity.js';

export type NewProduct = {
  sku: string;
  name: string;
  priceCents: string;
  stock: number;
};

export type ProductChanges = {
  expectedVersion: string;
  name?: string;
  priceCents?: string;
  stock?: number;
  reason?: string;
};

@Injectable()
export class ProductWriter {
  constructor(private readonly dataSource: DataSource) {}

  update(tenantId: string, userId: string, id: string,
    changes: ProductChanges): Promise<ProductEntity> {
    return this.dataSource.transaction(async (manager) => {
      const products = manager.getRepository(ProductEntity);
      const product = await products.findOne({
        where: { tenantId, id, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!product) throw new NotFoundException();
      if (product.version !== changes.expectedVersion) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT', message: 'Product version conflict',
        });
      }

      const stockBefore = product.stock;
      const stockChanged = changes.stock !== undefined && changes.stock !== stockBefore;
      const priceChanged = changes.priceCents !== undefined &&
        changes.priceCents !== product.priceCents;
      const nameChanged = changes.name !== undefined && changes.name !== product.name;
      if (!stockChanged && !priceChanged && !nameChanged) return product;

      if (changes.name !== undefined) product.name = changes.name;
      if (changes.priceCents !== undefined) product.priceCents = changes.priceCents;
      if (changes.stock !== undefined) product.stock = changes.stock;
      product.version = String(BigInt(product.version) + 1n);
      const updated = await products.save(product);

      if (stockChanged) {
        await manager.query(
          `INSERT INTO stock_movements
            (tenant_id, product_id, user_id, reason, note, quantity_delta,
             stock_before, stock_after)
           VALUES ($1, $2, $3, 'manual_adjustment', $4, $5, $6, $7)`,
          [tenantId, id, userId, changes.reason, updated.stock - stockBefore,
            stockBefore, updated.stock],
        );
      }
      if (stockChanged || priceChanged) {
        await manager.query(
          `INSERT INTO outbox_events
            (tenant_id, product_id, product_version, sku, stock, price_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, id, updated.version, updated.sku, updated.stock, updated.priceCents],
        );
      }
      return updated;
    });
  }

  async create(tenantId: string, userId: string, input: NewProduct): Promise<ProductEntity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const product = await manager.getRepository(ProductEntity).save(
          manager.getRepository(ProductEntity).create({
            tenantId, sku: input.sku, name: input.name,
            priceCents: input.priceCents, stock: input.stock, version: '1',
          }),
        );
        if (input.stock > 0) {
          await manager.query(
            `INSERT INTO stock_movements
              (tenant_id, product_id, user_id, reason, quantity_delta, stock_before, stock_after)
             VALUES ($1, $2, $3, 'initial_stock', $4, 0, $4)`,
            [tenantId, product.id, userId, input.stock],
          );
        }
        await manager.query(
          `INSERT INTO outbox_events
            (tenant_id, product_id, product_version, sku, stock, price_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, product.id, product.version, product.sku, product.stock, product.priceCents],
        );
        return product;
      });
    } catch (error) {
      if (error instanceof QueryFailedError &&
        (error.driverError as { code?: string; constraint?: string }).code === '23505' &&
        (error.driverError as { constraint?: string }).constraint === 'products_tenant_sku_unique') {
        throw new ConflictException('SKU already exists');
      }
      throw error;
    }
  }
}
