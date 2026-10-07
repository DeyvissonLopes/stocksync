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

function literalLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

@Injectable()
export class ProductReader {
  constructor(@InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>) {}

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
