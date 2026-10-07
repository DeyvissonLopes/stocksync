export type MockUpdate = {
  eventId: string;
  productId: string;
  sku: string;
  stock: number;
  priceCents: string;
  version: string;
};

export type MockBatch = { batchId: string; tenantId: string; updates: MockUpdate[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[1-9][0-9]*$/;
const PRICE = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const PG_BIGINT_MAX = 9223372036854775807n;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value) && BigInt(value) <= PG_BIGINT_MAX;
}

function priceCents(value: unknown): string | null {
  if (typeof value !== 'string' || !PRICE.test(value)) return null;
  const cents = BigInt(value.replace('.', ''));
  return cents <= PG_BIGINT_MAX ? String(cents) : null;
}

export function parseMockBatch(input: unknown): MockBatch | null {
  if (!record(input) ||
    !uuid(input.batchId) || !uuid(input.tenantId) || !Array.isArray(input.updates) ||
    input.updates.length < 1 || input.updates.length > 50) return null;

  const updates: MockUpdate[] = [];
  const eventIds = new Set<string>();
  for (const raw of input.updates) {
    if (!record(raw) ||
      !uuid(raw.eventId) || !uuid(raw.productId) ||
      typeof raw.sku !== 'string' || raw.sku.length === 0 ||
      typeof raw.stock !== 'number' || !Number.isInteger(raw.stock) ||
      raw.stock < 0 || raw.stock > 2147483647 || !decimal(raw.version)) return null;
    const cents = priceCents(raw.price);
    if (cents === null) return null;
    const eventId = raw.eventId.toLowerCase();
    if (eventIds.has(eventId)) return null;
    eventIds.add(eventId);
    updates.push({ eventId, productId: raw.productId.toLowerCase(), sku: raw.sku,
      stock: raw.stock, priceCents: cents, version: String(BigInt(raw.version)) });
  }
  return { batchId: input.batchId.toLowerCase(), tenantId: input.tenantId.toLowerCase(), updates };
}
