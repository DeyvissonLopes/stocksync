export type SaleItem = { productId: string; quantity: number };
export type Sale = {
  id: string;
  createdAt: string;
  items: Array<SaleItem & { unitPrice: string }>;
};

export class SaleRequestError extends Error {
  constructor(readonly kind: 'unauthorized' | 'insufficient-stock' | 'unavailable-product' |
    'invalid' | 'unknown') {
    super(kind);
  }
}

export async function createSale(key: string, items: SaleItem[]): Promise<Sale> {
  const response = await fetch('/api/sales', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-StockSync-Request': '1',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ items }),
  });
  if (response.status === 401) throw new SaleRequestError('unauthorized');
  if (response.status === 404) throw new SaleRequestError('unavailable-product');
  if (response.status === 409) {
    let body: unknown;
    try { body = await response.json(); } catch { /* Keep a generic conflict message. */ }
    if (typeof body === 'object' && body !== null && 'code' in body &&
      body.code === 'INSUFFICIENT_STOCK') throw new SaleRequestError('insufficient-stock');
    throw new SaleRequestError('invalid');
  }
  if (response.status === 400 || response.status === 403 || response.status === 422) {
    throw new SaleRequestError('invalid');
  }
  if (response.status !== 201) throw new SaleRequestError('unknown');

  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('sale' in body) ||
      typeof body.sale !== 'object' || body.sale === null ||
      !('id' in body.sale) || typeof body.sale.id !== 'string' ||
      !('createdAt' in body.sale) || typeof body.sale.createdAt !== 'string' ||
      !('items' in body.sale) || !Array.isArray(body.sale.items)) {
      throw new SaleRequestError('unknown');
    }
    return body.sale as Sale;
  } catch {
    throw new SaleRequestError('unknown');
  }
}
