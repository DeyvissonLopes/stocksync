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

const config = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: 'http://127.0.0.1:5173',
  jwtSecret: 'product-movements-test-secret-with-at-least-thirty-two-bytes',
};
let db: DataSource;
let app: INestApplication;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let operatorA: string;
let cookieA: string;
let operatorCookie: string;
let cookieB: string;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  const tenant = async () => {
    const rows: Array<{ id: string }> = await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`pm-${randomUUID()}`, 'Movement Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();
  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-movements.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  operatorA = await user(tenantA, 'operator');
  adminB = await user(tenantB, 'admin');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  cookieA = `stocksync_token=${tokens.issue(adminA)}`;
  operatorCookie = `stocksync_token=${tokens.issue(operatorA)}`;
  cookieB = `stocksync_token=${tokens.issue(adminB)}`;
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

async function product(tenantId = tenantA, archived = false) {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO products (tenant_id, sku, name, price_cents, stock, deleted_at,
      deleted_by) VALUES ($1, $2, 'Movement Test', 1000, 12, $3, $4) RETURNING id`,
    [tenantId, `MOV-${randomUUID()}`, archived ? new Date() : null,
      archived ? adminA : null],
  );
  return rows[0]!.id;
}

async function movement(tenantId: string, productId: string, userId: string,
  before: number, createdAt: string, reason = 'initial_stock', note: string | null = null) {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO stock_movements (tenant_id, product_id, user_id, reason, note,
      quantity_delta, stock_before, stock_after, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6 + 1, $7) RETURNING id`,
    [tenantId, productId, userId, reason, note, before, createdAt],
  );
  return rows[0]!.id;
}

function getMovements(id: string, query = '', cookie = cookieA) {
  return fetch(`${url}/products/${id}/stock-movements${query}`,
    { headers: cookie ? { Cookie: cookie } : {} });
}

describe('GET /products/:id/stock-movements over HTTP and PostgreSQL', () => {
  it('paginates newest first with movement details and a stable total', async () => {
    const id = await product();
    const ids: string[] = [];
    for (let number = 0; number < 12; number++) {
      ids.push(await movement(tenantA, id, adminA, number,
        `2026-01-01T00:00:${String(number).padStart(2, '0')}Z`,
        number === 11 ? 'manual_adjustment' : 'initial_stock',
        number === 11 ? 'Cycle count' : null));
    }
    const first = await getMovements(id);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstBody = await first.json();
    expect(firstBody.pagination).toEqual({ page: 1, pageSize: 10, total: 12,
      totalPages: 2 });
    expect(firstBody.movements.map((item: { id: string }) => item.id))
      .toEqual(ids.slice(2).reverse());
    expect(firstBody.movements[0]).toEqual({
      id: ids[11], userId: adminA, reason: 'manual_adjustment', note: 'Cycle count',
      quantityDelta: 1, stockBefore: 11, stockAfter: 12,
      createdAt: '2026-01-01T00:00:11.000Z',
    });
    const second = await getMovements(id, '?page=2');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      movements: [{ id: ids[1] }, { id: ids[0] }],
      pagination: { page: 2, pageSize: 10, total: 12, totalPages: 2 },
    });
    const beyond = await getMovements(id, '?page=3');
    expect((await beyond.json()).movements).toEqual([]);
  });

  it('shows an archived product history to an operator but hides other tenants', async () => {
    const archived = await product(tenantA, true);
    const movementId = await movement(tenantA, archived, adminA, 0,
      '2026-01-01T00:00:00Z');
    const foreign = await product(tenantB);
    await movement(tenantB, foreign, adminB, 0, '2026-01-01T00:00:00Z');
    const response = await getMovements(archived, '', operatorCookie);
    expect(response.status).toBe(200);
    expect((await response.json()).movements.map((item: { id: string }) => item.id))
      .toEqual([movementId]);
    expect((await getMovements(foreign)).status).toBe(404);
    expect((await getMovements(archived, '', cookieB)).status).toBe(404);
    expect((await getMovements(randomUUID())).status).toBe(404);
  });

  it('returns an empty page for a product without movements', async () => {
    const id = await product();
    const response = await getMovements(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ movements: [], pagination: {
      page: 1, pageSize: 10, total: 0, totalPages: 0,
    } });
  });

  it('uses the movement ID to break timestamp ties', async () => {
    const id = await product();
    const time = '2026-01-01T00:00:00Z';
    const firstId = await movement(tenantA, id, adminA, 0, time);
    const secondId = await movement(tenantA, id, operatorA, 1, time);
    const response = await getMovements(id);
    expect(response.status).toBe(200);
    expect((await response.json()).movements.map((item: { id: string }) => item.id))
      .toEqual([firstId, secondId].sort().reverse());
  });

  it('requires a valid session and rejects invalid or tenant-selecting queries', async () => {
    const id = await product();
    expect((await getMovements(id, '', '')).status).toBe(401);
    expect((await getMovements(id, '', 'stocksync_token=invalid')).status).toBe(401);
    expect((await getMovements('invalid')).status).toBe(400);
    for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=abc',
      '?page=9007199254740992', '?page=1&page=2', '?limit=20',
      `?tenantId=${tenantB}`, '?page[toString]=invalid']) {
      expect((await getMovements(id, query)).status).toBe(400);
    }
  });
});
