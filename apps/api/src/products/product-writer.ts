import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ProductEntity } from '../database/entities/product.entity.js';

export type NewProduct = {
  sku: string;
  name: string;
  priceCents: string;
  stock: number;
};

@Injectable()
export class ProductWriter {
  constructor(private readonly dataSource: DataSource) {}

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
