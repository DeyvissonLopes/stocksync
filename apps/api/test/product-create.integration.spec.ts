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
  jwtSecret: 'product-create-test-secret-with-at-least-thirty-two-bytes',
};
const valid = { sku: 'CREATE-MUG', name: 'Blue Mug', price: '29.90', stock: 4 };

let db: DataSource;
let app: INestApplication;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let adminCookieA: string;
let adminCookieB: string;
let operatorCookieA: string;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  const tenant = async () => {
    const rows: Array<{ id: string }> = await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`pc-${randomUUID().slice(0, 12)}`, 'Create Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();
  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-create.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  adminB = await user(tenantB, 'admin');
  const operatorA = await user(tenantA, 'operator');
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
    await db.query('DELETE FROM outbox_events WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM stock_movements WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM products WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await db.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  }
  if (db?.isInitialized) await db.destroy();
});

function create(body: unknown, cookie = adminCookieA, headers: Record<string, string> = {}) {
  return fetch(`${url}/products`, {
    method: 'POST',
    headers: { Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /products over HTTP and PostgreSQL', () => {
  it('creates product, initial movement and outbox event for the session tenant', async () => {
    const response = await create(valid);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ product: {
      id: expect.any(String), sku: valid.sku, name: valid.name, price: valid.price,
      stock: 4, version: '1',
    } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const id = body.product.id as string;
    const detail = await fetch(`${url}/products/${id}`, { headers: { Cookie: adminCookieA } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(body);
    const products: Array<{ tenant_id: string; price_cents: string }> = await db.query(
      'SELECT tenant_id, price_cents FROM products WHERE id = $1', [id]);
    expect(products).toEqual([{ tenant_id: tenantA, price_cents: '2990' }]);
    const movements: Array<{ tenant_id: string; user_id: string; reason: string;
      quantity_delta: number; stock_before: number; stock_after: number }> = await db.query(
      `SELECT tenant_id, user_id, reason, quantity_delta, stock_before, stock_after
       FROM stock_movements WHERE product_id = $1`, [id]);
    expect(movements).toEqual([{ tenant_id: tenantA, user_id: adminA,
      reason: 'initial_stock', quantity_delta: 4, stock_before: 0, stock_after: 4 }]);
    const events: Array<{ tenant_id: string; product_version: string;
      sku: string; stock: number; price_cents: string; status: string }> = await db.query(
      `SELECT tenant_id, product_version, sku, stock, price_cents, status
       FROM outbox_events WHERE product_id = $1`, [id]);
    expect(events).toEqual([{ tenant_id: tenantA, product_version: '1',
      sku: valid.sku, stock: 4, price_cents: '2990', status: 'pending' }]);
  });

  it('creates zero-stock products without a fictitious movement and isolates SKUs by tenant',
    async () => {
      const sku = `ZERO-${randomUUID()}`;
      for (const [cookie, tenantId] of [[adminCookieA, tenantA], [adminCookieB, tenantB]]) {
        const response = await create({ sku, name: 'Empty box', price: '0.00', stock: 0 }, cookie);
        expect(response.status).toBe(201);
        const id = (await response.json()).product.id as string;
        expect(await db.query('SELECT tenant_id FROM products WHERE id = $1', [id]))
          .toEqual([{ tenant_id: tenantId }]);
        expect(await db.query('SELECT id FROM stock_movements WHERE product_id = $1', [id]))
          .toEqual([]);
        expect(await db.query('SELECT stock, price_cents FROM outbox_events WHERE product_id = $1',
          [id])).toEqual([{ stock: 0, price_cents: '0' }]);
      }
    });

  it('rejects duplicate SKU in one tenant without adding movements or events', async () => {
    const sku = `DUP-${randomUUID()}`;
    expect((await create({ ...valid, sku })).status).toBe(201);
    expect((await create({ ...valid, sku, name: 'Other' })).status).toBe(409);
    const counts: Array<{ products: string; movements: string; events: string }> = await db.query(`
      SELECT (SELECT count(*) FROM products WHERE tenant_id = $1 AND sku = $2) AS products,
             (SELECT count(*) FROM stock_movements m JOIN products p ON p.id = m.product_id
              WHERE p.tenant_id = $1 AND p.sku = $2) AS movements,
             (SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND sku = $2) AS events
    `, [tenantA, sku]);
    expect(counts).toEqual([{ products: '1', movements: '1', events: '1' }]);
  });

  it('requires admin session and browser write headers', async () => {
    const sku = `DENIED-${randomUUID()}`;
    const payload = { ...valid, sku };
    expect((await create(payload, '')).status).toBe(401);
    expect((await create(payload, operatorCookieA)).status).toBe(403);
    expect((await create(payload, adminCookieA, { Origin: 'https://attacker.test' })).status)
      .toBe(403);
    expect(await db.query('SELECT id FROM products WHERE tenant_id = $1 AND sku = $2',
      [tenantA, sku])).toEqual([]);
  });

  it.each([
    [{ ...valid, tenantId: randomUUID() }],
    [{ ...valid, price: '29.999' }],
    [{ ...valid, price: '92233720368547758.08' }],
    [{ ...valid, price: -1 }],
    [{ ...valid, stock: -1 }],
    [{ ...valid, stock: 1.5 }],
    [{ ...valid, name: ' ' }],
    [{ ...valid, sku: '' }],
  ])('rejects invalid creation input %#', async (payload) => {
    expect((await create(payload)).status).toBe(400);
  });
});
