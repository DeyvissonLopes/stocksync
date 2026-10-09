import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { createMockSyncServer } from '../src/sync/mock/mock-sync-server.js';
import type { MockOutcome } from '../src/sync/mock/mock-sync-server.js';

let db: DataSource;
const testTenants = new Set<string>();

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
});

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
});

afterEach(async () => {
  if (testTenants.size === 0) return;
  await db.query('DELETE FROM mock_sync.products WHERE tenant_id = ANY($1::uuid[])',
    [[...testTenants]]);
  testTenants.clear();
});

type Update = { eventId: string; productId: string; sku: string; stock: number;
  price: string; version: string };

function update(productId = randomUUID(), version = '1', stock = 5): Update {
  return { eventId: randomUUID(), productId, sku: 'TEST-1', stock,
    price: '12.90', version };
}

async function withServer(check: (url: string) => Promise<void>, options: {
  decideOutcome?: () => MockOutcome; failureMode?: 'off' | 'demo';
  random?: () => number; timeoutDelayMs?: number; now?: () => number;
} = {}) {
  const server = createMockSyncServer(db, options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock address');
  try {
    await check(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      (server as Server).close((error) => error ? reject(error) : resolve()));
  }
}

async function send(url: string, tenantId: string, updates: Update[], batchId = randomUUID()) {
  testTenants.add(tenantId);
  const response = await fetch(`${url}/batches`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId, tenantId, updates }),
  });
  return { response, body: await response.json() as Record<string, unknown>, batchId };
}

async function stored(tenantId: string, productId: string) {
  return db.query(
    `SELECT sku, stock, price_cents, version FROM mock_sync.products
     WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId],
  ) as Promise<Array<{ sku: string; stock: number; price_cents: string; version: string }>>;
}

describe('external sync mock over HTTP and PostgreSQL', () => {
  it('applies a batch atomically and ACKs exactly its event IDs', async () => {
    const tenantId = randomUUID();
    const updates = [update(), update()];
    await withServer(async (url) => {
      const { response, body, batchId } = await send(url, tenantId, updates);
      expect(response.status).toBe(200);
      expect(body).toEqual({ batchId, acknowledgedEventIds: updates.map((item) => item.eventId) });
      expect(await stored(tenantId, updates[0]!.productId)).toEqual([
        { sku: 'TEST-1', stock: 5, price_cents: '1290', version: '1' },
      ]);
    });
  });

  it('ACKs repeated and stale updates without overwriting the newest version', async () => {
    const tenantId = randomUUID();
    const productId = randomUUID();
    await withServer(async (url) => {
      const newest = update(productId, '12', 2);
      const stale = update(productId, '11', 5);
      expect((await send(url, tenantId, [newest])).response.status).toBe(200);
      expect((await send(url, tenantId, [stale, newest])).response.status).toBe(200);
      expect(await stored(tenantId, productId)).toEqual([
        { sku: 'TEST-1', stock: 2, price_cents: '1290', version: '12' },
      ]);
    });
  });

  it('rejects a different payload at the same version and rolls back the whole batch',
    async () => {
      const tenantId = randomUUID();
      const productId = randomUUID();
      await withServer(async (url) => {
        expect((await send(url, tenantId, [update(productId, '1', 5)])).response.status).toBe(200);
        const newProduct = update();
        const conflict = update(productId, '1', 9);
        const result = await send(url, tenantId, [newProduct, conflict]);
        expect(result.response.status).toBe(409);
        expect(await stored(tenantId, newProduct.productId)).toEqual([]);
        expect((await stored(tenantId, productId))[0]?.stock).toBe(5);
      });
    });

  it('isolates identical product IDs across tenants and retains state across restart', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const productId = randomUUID();
    await withServer(async (url) => {
      expect((await send(url, tenantA, [update(productId, '3', 3)])).response.status).toBe(200);
    });
    await withServer(async (url) => {
      expect((await send(url, tenantA, [update(productId, '2', 2)])).response.status).toBe(200);
      expect((await send(url, tenantB, [update(productId, '1', 7)])).response.status).toBe(200);
      expect((await stored(tenantA, productId))[0]?.version).toBe('3');
      expect((await stored(tenantB, productId))[0]?.stock).toBe(7);
    });
  });

  it('rejects malformed batches before writing anything', async () => {
    const tenantId = randomUUID();
    const item = update();
    await withServer(async (url) => {
      const invalid = await send(url, tenantId, [{ ...item, price: '12.9' }]);
      expect(invalid.response.status).toBe(400);
      const tooMany = await send(url, tenantId,
        Array.from({ length: 51 }, () => update()));
      expect(tooMany.response.status).toBe(400);
      expect(await stored(tenantId, item.productId)).toEqual([]);
    });
  });

  it('accepts exactly 50 updates in one batch', async () => {
    const tenantId = randomUUID();
    const updates = Array.from({ length: 50 }, () => update());
    await withServer(async (url) => {
      const result = await send(url, tenantId, updates);
      expect(result.response.status).toBe(200);
      expect(result.body.acknowledgedEventIds).toEqual(updates.map((item) => item.eventId));
      expect((await stored(tenantId, updates[49]!.productId))[0]?.stock).toBe(5);
    });
  });

  it('rejects the sixth request in a moving second and provides Retry-After', async () => {
    let now = 1_000;
    const tenantId = randomUUID();
    await withServer(async (url) => {
      for (let index = 0; index < 5; index++) {
        expect((await send(url, tenantId, [update()])).response.status).toBe(200);
      }
      const sixth = await send(url, tenantId, [update()]);
      expect(sixth.response.status).toBe(429);
      expect(sixth.response.headers.get('retry-after')).toBe('1');
      now += 1_000;
      expect((await send(url, tenantId, [update()])).response.status).toBe(200);
    }, { now: () => now });
  });

  it('can fail before applying or timeout after applying, then safely ACK a retry',
    async () => {
      const tenantId = randomUUID();
      const item = update();
      const outcomes: MockOutcome[] = ['error', 'timeout-after', 'success'];
      await withServer(async (url) => {
        const first = await send(url, tenantId, [item]);
        expect(first.response.status).toBe(503);
        expect(await stored(tenantId, item.productId)).toEqual([]);
        const second = await send(url, tenantId, [item]);
        expect(second.response.status).toBe(504);
        expect((await stored(tenantId, item.productId))[0]?.version).toBe('1');
        const third = await send(url, tenantId, [item]);
        expect(third.response.status).toBe(200);
        expect(third.body.acknowledgedEventIds).toEqual([item.eventId]);
      }, { decideOutcome: () => outcomes.shift() ?? 'success', timeoutDelayMs: 1 });
    });

  it('serializes concurrent writes at the same version', async () => {
    const tenantId = randomUUID();
    const productId = randomUUID();
    await withServer(async (url) => {
      const results = await Promise.all([
        send(url, tenantId, [update(productId, '1', 4)]),
        send(url, tenantId, [update(productId, '1', 9)]),
      ]);
      expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
      expect(['4', '9']).toContain(String((await stored(tenantId, productId))[0]?.stock));
    });
  });

  it('uses deterministic demo draws for error and timeout before or after apply', async () => {
    const tenantId = randomUUID();
    const item = update();
    const draws = [0.05, 0.125, 0.175, 0.5];
    const server = createMockSyncServer(db, {
      failureMode: 'demo', random: () => draws.shift() ?? 0.5, timeoutDelayMs: 1,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing mock address');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      expect((await send(url, tenantId, [item])).response.status).toBe(503);
      expect((await send(url, tenantId, [item])).response.status).toBe(504);
      expect(await stored(tenantId, item.productId)).toEqual([]);
      expect((await send(url, tenantId, [item])).response.status).toBe(504);
      expect((await stored(tenantId, item.productId))[0]?.version).toBe('1');
      expect((await send(url, tenantId, [item])).response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('produces 10% errors and 10% timeouts in demo mode across controlled draws', async () => {
    const tenantId = randomUUID();
    const statuses: number[] = [];
    let draw = 0;
    let now = 0;
    let timeoutsBefore = 0;
    let timeoutsAfter = 0;
    await withServer(async (url) => {
      for (let index = 0; index < 100; index++) {
        const item = update();
        const { response } = await send(url, tenantId, [item]);
        statuses.push(response.status);
        if (response.status === 504) {
          if ((await stored(tenantId, item.productId)).length === 0) timeoutsBefore++;
          else timeoutsAfter++;
        }
      }
    }, {
      failureMode: 'demo',
      random: () => (draw++ + 0.5) / 100,
      now: () => { now += 1000; return now; },
      timeoutDelayMs: 1,
    });
    expect(statuses.filter((status) => status === 200)).toHaveLength(80);
    expect(statuses.filter((status) => status === 503)).toHaveLength(10);
    expect(statuses.filter((status) => status === 504)).toHaveLength(10);
    expect({ timeoutsBefore, timeoutsAfter }).toEqual({ timeoutsBefore: 5, timeoutsAfter: 5 });
    expect(draw).toBe(100);
  });
});
