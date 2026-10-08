export type Product = {
  id: string;
  sku: string;
  name: string;
  price: string;
  stock: number;
  version: string;
};

export type ProductPage = {
  products: Product[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export type ProductFilters = { name: string; zeroStock: boolean };

export class ProductListError extends Error {
  constructor(readonly kind: 'unauthorized' | 'unavailable') {
    super(kind);
  }
}

function isProduct(value: unknown): value is Product {
  if (typeof value !== 'object' || value === null || !('id' in value) ||
    !('sku' in value) || !('name' in value) || !('price' in value) ||
    !('stock' in value) || !('version' in value)) return false;
  return typeof value.id === 'string' && typeof value.sku === 'string' &&
    typeof value.name === 'string' && typeof value.price === 'string' &&
    typeof value.stock === 'number' && Number.isSafeInteger(value.stock) && value.stock >= 0 &&
    typeof value.version === 'string';
}

function isProductPage(value: unknown, requestedPage: number): value is ProductPage {
  if (typeof value !== 'object' || value === null || !('products' in value) ||
    !('pagination' in value) || !Array.isArray(value.products) ||
    typeof value.pagination !== 'object' || value.pagination === null) return false;
  const pagination = value.pagination as Record<string, unknown>;
  return value.products.length <= 10 && value.products.every(isProduct) &&
    pagination.page === requestedPage && pagination.pageSize === 10 &&
    Number.isSafeInteger(pagination.total) && (pagination.total as number) >= 0 &&
    Number.isSafeInteger(pagination.totalPages) &&
    pagination.totalPages === Math.ceil((pagination.total as number) / 10);
}

export async function listProducts(
  page: number, filters: ProductFilters, signal: AbortSignal,
): Promise<ProductPage> {
  const query = new URLSearchParams({ page: String(page) });
  if (filters.name) query.set('name', filters.name);
  if (filters.zeroStock) query.set('zeroStock', 'true');
  const response = await fetch(`/api/products?${query}`, {
    credentials: 'same-origin', signal,
  });
  if (response.status === 401) throw new ProductListError('unauthorized');
  if (!response.ok) throw new ProductListError('unavailable');
  const body: unknown = await response.json();
  if (!isProductPage(body, page)) throw new ProductListError('unavailable');
  return body;
}
