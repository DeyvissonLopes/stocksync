import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import type { Repository } from 'typeorm';
import { ProductEntity } from '../database/entities/product.entity.js';

@Injectable()
export class ProductReader {
  constructor(@InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>) {}

  findActive(tenantId: string, id: string): Promise<ProductEntity | null> {
    return this.products.findOneBy({ tenantId, id, deletedAt: IsNull() });
  }
}
