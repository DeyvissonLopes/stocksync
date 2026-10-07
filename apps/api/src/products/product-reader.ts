import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, IsNull } from 'typeorm';
import type { FindOptionsWhere, Repository } from 'typeorm';
import { ProductEntity } from '../database/entities/product.entity.js';

export const PRODUCT_PAGE_SIZE = 10;

export type ProductListFilters = {
  page: number;
  name?: string;
  zeroStock: boolean;
};

export type StockMovement = {
  id: string;
  userId: string;
  reason: string;
  note: string | null;
  quantityDelta: number;
  stockBefore: number;
  stockAfter: number;
  createdAt: Date;
};

type StockMovementRow = {
  id: string;
  user_id: string;
  reason: string;
  note: string | null;
  quantity_delta: number;
  stock_before: number;
  stock_after: number;
  created_at: Date;
};

function literalLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

@Injectable()
export class ProductReader {
  constructor(@InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>) {}

  async listMovements(tenantId: string, productId: string, page: number):
    Promise<[StockMovement[], number] | null> {
    if (!await this.products.existsBy({ tenantId, id: productId })) return null;
    const countRows: Array<{ total: string }> = await this.products.query(
      `SELECT count(*) AS total FROM stock_movements
       WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
    const rows: StockMovementRow[] = await this.products.query(
      `SELECT id, user_id, reason, note, quantity_delta, stock_before,
         stock_after, created_at
       FROM stock_movements WHERE tenant_id = $1 AND product_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [tenantId, productId, PRODUCT_PAGE_SIZE, (page - 1) * PRODUCT_PAGE_SIZE]);
    return [rows.map((row) => ({
      id: row.id, userId: row.user_id, reason: row.reason, note: row.note,
      quantityDelta: row.quantity_delta, stockBefore: row.stock_before,
      stockAfter: row.stock_after, createdAt: row.created_at,
    })), Number(countRows[0]!.total)];
  }

  findActive(tenantId: string, id: string): Promise<ProductEntity | null> {
    return this.products.findOneBy({ tenantId, id, deletedAt: IsNull() });
  }

  listActive(tenantId: string, filters: ProductListFilters): Promise<[ProductEntity[], number]> {
    const where: FindOptionsWhere<ProductEntity> = {
      tenantId,
      deletedAt: IsNull(),
      ...(filters.name ? { name: ILike(`%${literalLike(filters.name)}%`) } : {}),
      ...(filters.zeroStock ? { stock: 0 } : {}),
    };
    return this.products.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (filters.page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
    });
  }
}
