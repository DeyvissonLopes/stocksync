import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxQuantity = 2147483647;
const maxLines = 100;

export type SaleItemRequest = { productId: string; quantity: number };
export type PreparedSaleRequest = {
  idempotencyKey: string;
  requestHash: string;
  items: SaleItemRequest[];
};

function invalid(): never {
  throw new BadRequestException('Invalid sale request');
}

export function prepareSaleRequest(
  key: unknown, body: unknown, userId: string,
): PreparedSaleRequest {
  if (typeof key !== 'string' || !uuidV4.test(key)) invalid();
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !Object.hasOwn(body, 'items')) invalid();

  const lines = (body as { items: unknown }).items;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > maxLines) invalid();

  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line) ||
      Object.keys(line).length !== 2 || !Object.hasOwn(line, 'productId') ||
      !Object.hasOwn(line, 'quantity')) invalid();

    const { productId, quantity } = line as Record<string, unknown>;
    if (typeof productId !== 'string' || !uuidV4.test(productId) ||
      typeof quantity !== 'number' || !Number.isInteger(quantity) ||
      quantity < 1 || quantity > maxQuantity) invalid();

    const id = productId.toLowerCase();
    const total = (quantities.get(id) ?? 0) + quantity;
    if (total > maxQuantity) invalid();
    quantities.set(id, total);
  }

  const items = [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([productId, quantity]) => ({ productId, quantity }));
  const canonical = JSON.stringify({ version: 1, userId: userId.toLowerCase(), items });
  const requestHash = createHash('sha256').update(canonical).digest('hex');
  return { idempotencyKey: key.toLowerCase(), requestHash, items };
}
