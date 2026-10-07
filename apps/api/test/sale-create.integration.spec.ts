import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';

const origin = 'http://localhost:5173';
const config = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'sale-create-test-secret-with-at-least-thirty-two-bytes',
};

let db: DataSource;
let app: INestApplication;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let operatorA: string;
let adminCookieA: string;
let adminCookieB: string;
let operatorCookieA: string;

async function tenant(): Promise<string> {
  const rows: Array<{ id: string }> = await db.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`sale-${randomUUID().slice(0, 12)}`, 'Sale Test'],
  );
  return rows[0]!.id;
}

async function user(tenantId: string, role: 'admin' | 'operator'): Promise<string> {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
    [tenantId, `${randomUUID()}@sale-create.test`, role],
  );
  return rows[0]!.id;
}

async function product(tenantId = tenantA, stock = 5, priceCents = '1299'): Promise<string> {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
     VALUES ($1, $2, 'Sale fixture', $3, $4) RETURNING id`,
    [tenantId, `SALE-${randomUUID()}`, priceCents, stock],
  );
  return rows[0]!.id;
}

function submit(items: unknown, key: string = randomUUID(), cookie = adminCookieA,
  headers: Record<string, string> = {}) {
  return fetch(`${url}/sales`, {
    method: 'POST',
    headers: { Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json',
      'Idempotency-Key': key, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify({ items }),
  });
}

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  tenantA = await tenant();
  tenantB = await tenant();
  adminA = await user(tenantA, 'admin');
  adminB = await user(tenantB, 'admin');
  operatorA = await user(tenantA, 'operator');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  adminCookieA = `stocksync_token=${tokens.issue(adminA)}`;
  adminCookieB = `stocksync_token=${tokens.issue(adminB)}`;
  operatorCookieA = `stocksync_token=${tokens.issue(operatorA)}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (db?.isInitialized && tenantA && tenantB) {
    await db.query('DELETE FROM stock_movements WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM outbox_events WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM sale_items WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM sales WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM products WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  }
  if (db?.isInitialized) await db.destroy();
});

describe('POST /sales over HTTP and PostgreSQL', () => {
  it('commits multiple items, movements and outbox snapshots with captured prices', async () => {
    const a = await product(tenantA, 5, '1299');
    const b = await product(tenantA, 3, '250');
    const response = await submit([
      { productId: b, quantity: 1 }, { productId: a, quantity: 2 },
    ], randomUUID(), operatorCookieA);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ sale: {
      id: expect.any(String), createdAt: expect.any(String), items: expect.arrayContaining([
        { productId: a, quantity: 2, unitPrice: '12.99' },
        { productId: b, quantity: 1, unitPrice: '2.50' },
      ]),
    } });
    expect(body.sale.items).toHaveLength(2);
    expect(await db.query('SELECT tenant_id, user_id FROM sales WHERE id = $1',
      [body.sale.id])).toEqual([{ tenant_id: tenantA, user_id: operatorA }]);
    expect(await db.query('SELECT id, stock, version FROM products WHERE id IN ($1, $2) ORDER BY id',
      [a, b])).toEqual(expect.arrayContaining([
      { id: a, stock: 3, version: '2' }, { id: b, stock: 2, version: '2' },
    ]));
    expect(await db.query(
      'SELECT product_id, quantity, unit_price_cents FROM sale_items WHERE sale_id = $1 ORDER BY product_id',
      [body.sale.id],
    )).toEqual(expect.arrayContaining([
      { product_id: a, quantity: 2, unit_price_cents: '1299' },
      { product_id: b, quantity: 1, unit_price_cents: '250' },
    ]));
    expect(await db.query(
      `SELECT product_id, user_id, quantity_delta, stock_before, stock_after
       FROM stock_movements WHERE sale_id = $1 ORDER BY product_id`, [body.sale.id],
    )).toEqual(expect.arrayContaining([
      { product_id: a, user_id: operatorA, quantity_delta: -2,
        stock_before: 5, stock_after: 3 },
      { product_id: b, user_id: operatorA, quantity_delta: -1,
        stock_before: 3, stock_after: 2 },
    ]));
    expect(await db.query(
      'SELECT product_id, product_version, stock, price_cents FROM outbox_events WHERE product_id IN ($1, $2) ORDER BY product_id',
      [a, b],
    )).toEqual(expect.arrayContaining([
      { product_id: a, product_version: '2', stock: 3, price_cents: '1299' },
      { product_id: b, product_version: '2', stock: 2, price_cents: '250' },
    ]));
  });

  it('replays equivalent requests with the same key without another stock change', async () => {
    const a = await product();
    const key = randomUUID();
    const first = await submit([{ productId: a, quantity: 2 }], key);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    await db.query(
      'UPDATE products SET price_cents = 9999, deleted_at = now(), deleted_by = $1 WHERE id = $2',
      [adminA, a],
    );
    const validReplay = await submit([
      { productId: a.toUpperCase(), quantity: 1 }, { productId: a, quantity: 1 },
    ], key);
    expect(validReplay.status).toBe(201);
    expect(await validReplay.json()).toEqual(firstBody);
    expect(await db.query('SELECT stock, version FROM products WHERE id = $1', [a]))
      .toEqual([{ stock: 3, version: '2' }]);
    expect(await db.query('SELECT count(*)::int AS n FROM stock_movements WHERE sale_id = $1',
      [firstBody.sale.id])).toEqual([{ n: 1 }]);
    expect(await db.query('SELECT count(*)::int AS n FROM outbox_events WHERE product_id = $1',
      [a])).toEqual([{ n: 1 }]);
    expect(await db.query('SELECT count(*)::int AS n FROM sale_items WHERE sale_id = $1',
      [firstBody.sale.id])).toEqual([{ n: 1 }]);
  });

  it('returns 409 when the same key is reused for a different sale', async () => {
    const a = await product();
    const b = await product();
    const key = randomUUID();
    expect((await submit([{ productId: a, quantity: 1 }], key)).status).toBe(201);
    const second = await submit([{ productId: b, quantity: 2 }], key);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.query('SELECT stock FROM products WHERE id = $1', [b]))
      .toEqual([{ stock: 5 }]);
    expect(await db.query('SELECT count(*)::int AS n FROM sales WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantA, key])).toEqual([{ n: 1 }]);
    expect((await submit([{ productId: a, quantity: 1 }], key, operatorCookieA)).status)
      .toBe(409);
  });

  it('rolls back every effect when a later item has insufficient stock', async () => {
    const a = await product(tenantA, 5);
    const b = await product(tenantA, 5);
    const [first, last] = [a, b].sort();
    await db.query('UPDATE products SET stock = 0 WHERE id = $1', [last]);
    const key = randomUUID();
    const response = await submit([
      { productId: first, quantity: 2 }, { productId: last, quantity: 1 },
    ], key);
    expect(response.status).toBe(409);
    expect(await db.query('SELECT id, stock, version FROM products WHERE id IN ($1, $2) ORDER BY id',
      [first, last])).toEqual([
      { id: first, stock: 5, version: '1' }, { id: last, stock: 0, version: '1' },
    ]);
    expect(await db.query('SELECT id FROM sales WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantA, key])).toEqual([]);
    expect(await db.query('SELECT id FROM stock_movements WHERE product_id IN ($1, $2)',
      [a, b])).toEqual([]);
    expect(await db.query('SELECT id FROM outbox_events WHERE product_id IN ($1, $2)',
      [a, b])).toEqual([]);
  });

  it('hides foreign and archived products and allows the same key in another tenant', async () => {
    const a = await product(tenantA);
    const b = await product(tenantB);
    const key = randomUUID();
    expect((await submit([{ productId: b, quantity: 1 }], key)).status).toBe(404);
    expect((await submit([{ productId: a, quantity: 1 }], key)).status).toBe(201);
    expect((await submit([{ productId: b, quantity: 1 }], key, adminCookieB)).status).toBe(201);
    const archived = await product(tenantA);
    await db.query('UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
      [adminA, archived]);
    expect((await submit([{ productId: archived, quantity: 1 }])).status).toBe(404);
  });

  it('requires a session and browser write headers', async () => {
    const a = await product();
    const items = [{ productId: a, quantity: 1 }];
    expect((await submit(items, randomUUID(), '')).status).toBe(401);
    expect((await submit(items, randomUUID(), adminCookieA,
      { Origin: 'https://attacker.test' })).status).toBe(403);
    expect(await db.query('SELECT stock FROM products WHERE id = $1', [a]))
      .toEqual([{ stock: 5 }]);
  });

  it('rejects malformed sale input before touching stock', async () => {
    const a = await product();
    expect((await submit([{ productId: a, quantity: 1 }], 'not-a-uuid')).status).toBe(400);
    expect((await submit([{ productId: a, quantity: 0 }])).status).toBe(400);
    expect(await db.query('SELECT stock FROM products WHERE id = $1', [a]))
      .toEqual([{ stock: 5 }]);
  });
});
