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

const origin = 'http://127.0.0.1:5173';
const config = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'product-archive-test-secret-with-at-least-thirty-two-bytes',
};
let db: DataSource;
let app: INestApplication;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let cookieA: string;
let cookieB: string;
let operatorCookie: string;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  const tenant = async () => {
    const rows: Array<{ id: string }> = await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`pa-${randomUUID().slice(0, 12)}`, 'Archive Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();
  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-archive.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  const adminB = await user(tenantB, 'admin');
  const operatorA = await user(tenantA, 'operator');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  cookieA = `stocksync_token=${tokens.issue(adminA)}`;
  cookieB = `stocksync_token=${tokens.issue(adminB)}`;
  operatorCookie = `stocksync_token=${tokens.issue(operatorA)}`;
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

async function product(cookie = cookieA) {
  const sku = `ARCH-${randomUUID()}`;
  const response = await fetch(`${url}/products`, {
    method: 'POST',
    headers: { Origin: origin, 'X-StockSync-Request': '1',
      'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sku, name: 'Archive Test', price: '10.00', stock: 5 }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).product as { id: string; sku: string };
}

function archive(id: string, query = '?expectedVersion=1', cookie = cookieA,
  headers: Record<string, string> = {}) {
  return fetch(`${url}/products/${id}${query}`, {
    method: 'DELETE',
    headers: { Origin: origin, 'X-StockSync-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

describe('DELETE /products/:id over HTTP and PostgreSQL', () => {
  it('archives the product without changing internal stock or movements', async () => {
    const existing = await product();
    const response = await archive(existing.id);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const rows: Array<{ tenant_id: string; stock: number; price_cents: string;
      version: string; deleted_at: Date | null; deleted_by: string | null }> = await db.query(
      `SELECT tenant_id, stock, price_cents, version, deleted_at, deleted_by
       FROM products WHERE id = $1`, [existing.id]);
    expect(rows[0]).toMatchObject({ tenant_id: tenantA, stock: 5, price_cents: '1000',
      version: '2', deleted_by: adminA });
    expect(rows[0]?.deleted_at).not.toBeNull();
    const movements: Array<{ reason: string; quantity_delta: number }> = await db.query(
      'SELECT reason, quantity_delta FROM stock_movements WHERE product_id = $1', [existing.id]);
    expect(movements).toEqual([{ reason: 'initial_stock', quantity_delta: 5 }]);
    const events: Array<{ product_version: string; stock: number; price_cents: string;
      status: string }> = await db.query(
      `SELECT product_version, stock, price_cents, status FROM outbox_events
       WHERE product_id = $1 ORDER BY product_version`, [existing.id]);
    expect(events).toEqual([
      { product_version: '1', stock: 5, price_cents: '1000', status: 'pending' },
      { product_version: '2', stock: 0, price_cents: '1000', status: 'pending' },
    ]);
    expect((await fetch(`${url}/products/${existing.id}`, { headers: { Cookie: cookieA } })).status)
      .toBe(404);
    const list = await fetch(`${url}/products`, { headers: { Cookie: cookieA } });
    expect((await list.json()).products.some((item: { id: string }) => item.id === existing.id))
      .toBe(false);
  });

  it('returns 204 for repeated archive without another version or event', async () => {
    const existing = await product();
    expect((await archive(existing.id)).status).toBe(204);
    expect((await archive(existing.id)).status).toBe(204);
    expect(await db.query('SELECT version, stock FROM products WHERE id = $1', [existing.id]))
      .toEqual([{ version: '2', stock: 5 }]);
    const events: Array<{ product_version: string }> = await db.query(
      'SELECT product_version FROM outbox_events WHERE product_id = $1 ORDER BY product_version',
      [existing.id]);
    expect(events).toEqual([{ product_version: '1' }, { product_version: '2' }]);
  });

  it('rejects a stale version for an active product without archiving it', async () => {
    const existing = await product();
    const edited = await fetch(`${url}/products/${existing.id}`, {
      method: 'PATCH',
      headers: { Origin: origin, 'X-StockSync-Request': '1',
        'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ expectedVersion: '1', name: 'Renamed Product' }),
    });
    expect(edited.status).toBe(200);
    const response = await archive(existing.id);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PRODUCT_VERSION_CONFLICT');
    expect(await db.query('SELECT version, deleted_at FROM products WHERE id = $1', [existing.id]))
      .toEqual([{ version: '2', deleted_at: null }]);
    expect(await db.query('SELECT product_version FROM outbox_events WHERE product_id = $1',
      [existing.id])).toEqual([{ product_version: '1' }]);
  });

  it('treats simultaneous repeated archives as one state change', async () => {
    const existing = await product();
    const responses = await Promise.all([archive(existing.id), archive(existing.id)]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(await db.query('SELECT version FROM products WHERE id = $1', [existing.id]))
      .toEqual([{ version: '2' }]);
    const events: Array<{ product_version: string }> = await db.query(
      'SELECT product_version FROM outbox_events WHERE product_id = $1 ORDER BY product_version',
      [existing.id]);
    expect(events).toEqual([{ product_version: '1' }, { product_version: '2' }]);
  });

  it('hides foreign and absent products and enforces admin session', async () => {
    const own = await product();
    const foreign = await product(cookieB);
    expect((await archive(foreign.id)).status).toBe(404);
    expect((await archive(randomUUID())).status).toBe(404);
    expect((await archive(own.id, '?expectedVersion=1', '')).status).toBe(401);
    expect((await archive(own.id, '?expectedVersion=1', operatorCookie)).status).toBe(403);
    expect((await archive(own.id, '?expectedVersion=1', cookieA,
      { Origin: 'https://attacker.test' })).status).toBe(403);
    expect(await db.query('SELECT deleted_at FROM products WHERE id = $1', [own.id]))
      .toEqual([{ deleted_at: null }]);
  });

  it.each(['', '?expectedVersion=0', '?expectedVersion=1.0',
    '?expectedVersion=1&tenantId=other', '?expectedVersion=1&expectedVersion=2'])(
    'rejects invalid archive query %#', async (query) => {
    const existing = await product();
    expect((await archive(existing.id, query)).status).toBe(400);
    });
});
