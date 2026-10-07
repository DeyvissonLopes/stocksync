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
  jwtSecret: 'product-update-test-secret-with-at-least-thirty-two-bytes',
};
let db: DataSource;
let app: INestApplication;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let cookieA: string;
let operatorCookie: string;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  const tenant = async () => {
    const rows: Array<{ id: string }> = await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`pu-${randomUUID().slice(0, 12)}`, 'Product Update Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();
  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-update.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  const operatorA = await user(tenantA, 'operator');
  await user(tenantB, 'admin');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  cookieA = `stocksync_token=${tokens.issue(adminA)}`;
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

async function product(tenantId = tenantA, stock = 5) {
  const rows: Array<{ id: string; sku: string }> = await db.query(
    `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
     VALUES ($1, $2, 'Original Name', 1000, $3) RETURNING id, sku`,
    [tenantId, `UP-${randomUUID()}`, stock],
  );
  return rows[0]!;
}

function update(id: string, body: unknown, cookie = cookieA, headers: Record<string, string> = {}) {
  return fetch(`${url}/products/${id}`, {
    method: 'PATCH',
    headers: { Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

describe('PATCH /products/:id over HTTP and PostgreSQL', () => {
  it('changes only the name without an outbox event and leaves no-op updates untouched', async () => {
    const existing = await product();
    const changed = await update(existing.id, { expectedVersion: '1', name: 'Updated Name' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ product: {
      id: existing.id, sku: existing.sku, name: 'Updated Name', price: '10.00',
      stock: 5, version: '2',
    } });
    expect(changed.headers.get('cache-control')).toBe('no-store');
    const repeated = await update(existing.id, { expectedVersion: '2', name: 'Updated Name' });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).product.version).toBe('2');
    expect(await db.query('SELECT id FROM stock_movements WHERE product_id = $1', [existing.id]))
      .toEqual([]);
    expect(await db.query('SELECT id FROM outbox_events WHERE product_id = $1', [existing.id]))
      .toEqual([]);
  });

  it('records stock adjustments with the supplied reason and snapshots each changed version',
    async () => {
      const existing = await product();
      const first = await update(existing.id, {
        expectedVersion: '1', stock: 2, reason: 'Cycle count',
      });
      expect(first.status).toBe(200);
      expect((await first.json()).product).toMatchObject({ stock: 2, version: '2' });
      const unchanged = await update(existing.id, {
        expectedVersion: '2', stock: 2, reason: 'Count unchanged',
      });
      expect(unchanged.status).toBe(200);
      expect((await unchanged.json()).product.version).toBe('2');
      const second = await update(existing.id, {
        expectedVersion: '2', stock: 4, reason: 'Delivery received', price: '12.50',
      });
      expect(second.status).toBe(200);
      expect((await second.json()).product).toMatchObject({
        stock: 4, price: '12.50', version: '3',
      });
      const movements: Array<{ tenant_id: string; user_id: string; reason: string; note: string;
        quantity_delta: number; stock_before: number; stock_after: number }> = await db.query(
        `SELECT tenant_id, user_id, reason, note, quantity_delta, stock_before, stock_after
         FROM stock_movements WHERE product_id = $1 ORDER BY created_at, id`, [existing.id]);
      expect(movements).toEqual([
        { tenant_id: tenantA, user_id: adminA, reason: 'manual_adjustment',
          note: 'Cycle count', quantity_delta: -3, stock_before: 5, stock_after: 2 },
        { tenant_id: tenantA, user_id: adminA, reason: 'manual_adjustment',
          note: 'Delivery received', quantity_delta: 2, stock_before: 2, stock_after: 4 },
      ]);
      const events: Array<{ product_version: string; stock: number; price_cents: string;
        status: string }> = await db.query(
        `SELECT product_version, stock, price_cents, status FROM outbox_events
         WHERE product_id = $1 ORDER BY product_version`, [existing.id]);
      expect(events).toEqual([
        { product_version: '2', stock: 2, price_cents: '1000', status: 'pending' },
        { product_version: '3', stock: 4, price_cents: '1250', status: 'pending' },
      ]);
    });

  it('creates an outbox snapshot for a price-only change without a stock movement', async () => {
    const existing = await product();
    const response = await update(existing.id, { expectedVersion: '1', price: '19.99' });
    expect(response.status).toBe(200);
    expect((await response.json()).product).toMatchObject({ price: '19.99', version: '2' });
    expect(await db.query('SELECT id FROM stock_movements WHERE product_id = $1', [existing.id]))
      .toEqual([]);
    expect(await db.query('SELECT stock, price_cents, product_version FROM outbox_events WHERE product_id = $1',
      [existing.id])).toEqual([{ stock: 5, price_cents: '1999', product_version: '2' }]);
  });

  it('rejects a stale version without changing stock, movements or outbox', async () => {
    const existing = await product();
    expect((await update(existing.id, { expectedVersion: '1', name: 'New Name' })).status).toBe(200);
    const stale = await update(existing.id, {
      expectedVersion: '1', stock: 9, reason: 'Old count',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('PRODUCT_VERSION_CONFLICT');
    expect(await db.query('SELECT name, stock, version FROM products WHERE id = $1', [existing.id]))
      .toEqual([{ name: 'New Name', stock: 5, version: '2' }]);
    expect(await db.query('SELECT id FROM stock_movements WHERE product_id = $1', [existing.id]))
      .toEqual([]);
    expect(await db.query('SELECT id FROM outbox_events WHERE product_id = $1', [existing.id]))
      .toEqual([]);
  });

  it('serializes concurrent updates to the same version', async () => {
    const existing = await product();
    const responses = await Promise.all([
      update(existing.id, { expectedVersion: '1', name: 'First Name' }),
      update(existing.id, { expectedVersion: '1', name: 'Second Name' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rows: Array<{ name: string; version: string }> = await db.query(
      'SELECT name, version FROM products WHERE id = $1', [existing.id]);
    expect(['First Name', 'Second Name']).toContain(rows[0]?.name);
    expect(rows[0]?.version).toBe('2');
  });

  it('hides foreign, archived and missing products and enforces admin session', async () => {
    const own = await product();
    const foreign = await product(tenantB);
    const archived = await product();
    await db.query('UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
      [adminA, archived.id]);
    for (const id of [foreign.id, archived.id, randomUUID()]) {
      expect((await update(id, { expectedVersion: '1', name: 'Hidden' })).status).toBe(404);
    }
    expect((await update(own.id, { expectedVersion: '1', name: 'Denied' }, '')).status).toBe(401);
    expect((await update(own.id, { expectedVersion: '1', name: 'Denied' }, operatorCookie)).status)
      .toBe(403);
    expect((await update(own.id, { expectedVersion: '1', name: 'Denied' }, cookieA,
      { Origin: 'https://attacker.test' })).status).toBe(403);
    expect(await db.query('SELECT name FROM products WHERE id = $1', [own.id]))
      .toEqual([{ name: 'Original Name' }]);
  });

  it.each([
    [{ name: 'No version' }],
    [{ expectedVersion: '0', name: 'Invalid version' }],
    [{ expectedVersion: '1', sku: 'MUTATED' }],
    [{ expectedVersion: '1', tenantId: randomUUID(), name: 'Denied' }],
    [{ expectedVersion: '1', stock: 3 }],
    [{ expectedVersion: '1', reason: 'No stock' }],
    [{ expectedVersion: '1', stock: 3, reason: ' ' }],
    [{ expectedVersion: '1', price: '1.999' }],
    [{ expectedVersion: '1', price: '92233720368547758.08' }],
    [{ expectedVersion: '1', stock: -1, reason: 'Bad' }],
    [{ expectedVersion: '1' }],
  ])('rejects invalid update input %#', async (body) => {
    const existing = await product();
    expect((await update(existing.id, body)).status).toBe(400);
  });
});
