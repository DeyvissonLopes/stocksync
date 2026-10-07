import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException,
  Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { ProductEntity } from '../database/entities/product.entity.js';
import { PRODUCT_PAGE_SIZE, ProductReader } from './product-reader.js';
import type { ProductListFilters } from './product-reader.js';
import { ProductWriter } from './product-writer.js';
import type { NewProduct } from './product-writer.js';

function parseNewProduct(body: unknown): NewProduct {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'name,price,sku,stock' ||
    !('sku' in body) || typeof body.sku !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.sku) ||
    !('name' in body) || typeof body.name !== 'string' ||
    body.name.trim().length === 0 || body.name.trim().length > 100 ||
    body.name.includes('\0') ||
    !('stock' in body) || typeof body.stock !== 'number' ||
    !Number.isInteger(body.stock) || body.stock < 0 || body.stock > 2147483647 ||
    !('price' in body) || typeof body.price !== 'string' ||
    !/^(0|[1-9]\d{0,16})\.\d{2}$/.test(body.price)) {
    throw new BadRequestException('Invalid product request');
  }
  const priceCents = BigInt(body.price.replace('.', ''));
  if (priceCents > 9223372036854775807n) {
    throw new BadRequestException('Invalid product request');
  }
  return { sku: body.sku, name: body.name.trim(), priceCents: String(priceCents),
    stock: body.stock };
}

function decimalPrice(cents: string): string {
  const amount = BigInt(cents);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function productResponse(product: ProductEntity) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    price: decimalPrice(product.priceCents),
    stock: product.stock,
    version: String(product.version),
  };
}

function parseListFilters(query: Record<string, unknown>): ProductListFilters {
  if (Object.keys(query).some((key) => !['page', 'name', 'zeroStock'].includes(key))) {
    throw new BadRequestException('Invalid product query');
  }

  const rawPage = query.page;
  let page = 1;
  if (rawPage !== undefined) {
    if (typeof rawPage !== 'string' || !/^[1-9]\d*$/.test(rawPage)) {
      throw new BadRequestException('Invalid product query');
    }
    page = Number(rawPage);
    if (!Number.isSafeInteger(page) ||
      !Number.isSafeInteger((page - 1) * PRODUCT_PAGE_SIZE)) {
      throw new BadRequestException('Invalid product query');
    }
  }

  const rawName = query.name;
  if (rawName !== undefined && (typeof rawName !== 'string' ||
    rawName.includes('\0') || rawName.trim().length > 100)) {
    throw new BadRequestException('Invalid product query');
  }

  const rawZeroStock = query.zeroStock;
  if (rawZeroStock !== undefined && rawZeroStock !== 'true' && rawZeroStock !== 'false') {
    throw new BadRequestException('Invalid product query');
  }

  const name = typeof rawName === 'string' ? rawName.trim() : '';
  return { page, ...(name ? { name } : {}), zeroStock: rawZeroStock === 'true' };
}

@Controller('products')
@UseGuards(SessionGuard)
export class ProductsController {
  constructor(
    private readonly reader: ProductReader,
    private readonly writer: ProductWriter,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    if (request.identity.role !== 'admin') throw new ForbiddenException();
    const input = parseNewProduct(body);
    const product = await this.writer.create(request.identity.tenantId,
      request.identity.userId, input);
    return { product: productResponse(product) };
  }

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthenticatedRequest
  ) {
    const filters = parseListFilters(query);
    const [products, total] = await this.reader.listActive(request.identity.tenantId, filters);
    return {
      products: products.map(productResponse),
      pagination: { page: filters.page, pageSize: PRODUCT_PAGE_SIZE, total,
        totalPages: Math.ceil(total / PRODUCT_PAGE_SIZE) },
    };
  }

  @Get(':id')
  async show(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const product = await this.reader.findActive(request.identity.tenantId, id);
    if (!product) throw new NotFoundException();
    return { product: productResponse(product) };
  }
}
