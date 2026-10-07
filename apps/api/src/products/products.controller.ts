import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { ProductReader } from './product-reader.js';

function decimalPrice(cents: string): string {
  const amount = BigInt(cents);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

@Controller('products')
export class ProductsController {
  constructor(private readonly reader: ProductReader) {}

  @Get(':id')
  @UseGuards(SessionGuard)
  async show(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const product = await this.reader.findActive(request.identity.tenantId, id);
    if (!product) throw new NotFoundException();
    return {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        price: decimalPrice(product.priceCents),
        stock: product.stock,
        version: String(product.version),
      },
    };
  }
}
