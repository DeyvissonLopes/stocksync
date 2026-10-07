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

const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: 'http://localhost:5173',
  jwtSecret: 'product-list-test-secret-with-at-least-thirty-two-bytes',
};

let dataSource: DataSource;
let app: INestApplication;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let cookieA: string;
let cookieB: string;
const ownIds: string[] = [];
let foreignId: string;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
  const tenant = async () => {
    const rows: Array<{ id: string }> = await dataSource.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`product-list-${randomUUID()}`, 'Product List Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();

  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-list.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  const operatorB = await user(tenantB, 'operator');

  const product = async (tenantId: string, sku: string, name: string, stock: number,
    createdAt: string) => {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO products (tenant_id, sku, name, price_cents, stock, created_at, updated_at)
       VALUES ($1, $2, $3, 1990, $4, $5, $5) RETURNING id`,
      [tenantId, sku, name, stock, createdAt],
    );
    return rows[0]!.id;
  };
  for (let number = 1; number <= 22; number++) {
    const name = number === 1 ? 'Blue Widget' : number === 2 ? 'blue widget' :
      number === 4 ? '100% Cotton' : 'Ordinary item';
    ownIds.push(await product(tenantA, number === 1 ? 'SHARED' : `SKU-${number}`,
      name, number === 1 || number === 3 ? 0 : number,
      `2026-01-01T00:00:${String(number).padStart(2, '0')}Z`));
  }
  foreignId = await product(tenantB, 'SHARED', 'Blue Widget', 0, '2026-01-02T00:00:00Z');
  const archived = await product(tenantA, 'ARCHIVED', 'Blue Widget', 0,
    '2026-01-03T00:00:00Z');
  await dataSource.query(
    'UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
    [adminA, archived],
  );

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(testConfig).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  cookieA = `stocksync_token=${tokens.issue(adminA)}`;
  cookieB = `stocksync_token=${tokens.issue(operatorB)}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (dataSource?.isInitialized && tenantA && tenantB) {
    await dataSource.query('DELETE FROM products WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await dataSource.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await dataSource.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  }
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function list(query = '', cookie?: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/products${query}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

describe('GET /products over HTTP and PostgreSQL', () => {
  it('paginates only active products from the session tenant, including the total', async () => {
    const first = await list('', cookieA);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.pagination).toEqual({ page: 1, pageSize: 10, total: 22, totalPages: 3 });
    expect(firstBody.products.map((product: { id: string }) => product.id)).toEqual(
      ownIds.slice(12).reverse(),
    );
    expect(firstBody.products[0]).toEqual({
      id: ownIds[21], sku: 'SKU-22', name: 'Ordinary item', price: '19.90',
      stock: 22, version: '1',
    });
    expect(first.headers.get('cache-control')).toBe('no-store');

    const second = await list('?page=2', cookieA);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.pagination).toEqual({ page: 2, pageSize: 10, total: 22, totalPages: 3 });
    expect(secondBody.products.map((product: { id: string }) => product.id)).toEqual(
      ownIds.slice(2, 12).reverse(),
    );

    const third = await list('?page=3', cookieA);
    expect(third.status).toBe(200);
    const thirdBody = await third.json();
    expect(thirdBody.pagination).toEqual({ page: 3, pageSize: 10, total: 22, totalPages: 3 });
    expect(thirdBody.products.map((product: { id: string }) => product.id)).toEqual(
      ownIds.slice(0, 2).reverse(),
    );

    const fourth = await list('?page=4', cookieA);
    expect(fourth.status).toBe(200);
    const fourthBody = await fourth.json();
    expect(fourthBody.pagination).toEqual({ page: 4, pageSize: 10, total: 22, totalPages: 3 });
    expect(fourthBody.products).toEqual([]);
  });

  it('does not leak another tenant through items, count or a forged header', async () => {
    const response = await list('', cookieB, { 'X-Tenant-Id': tenantA });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination).toEqual({ page: 1, pageSize: 10, total: 1, totalPages: 1 });
    expect(body.products.map((product: { id: string }) => product.id)).toEqual([foreignId]);
  });

  it('filters names case-insensitively and treats wildcard characters literally', async () => {
    const widgets = await list('?name=WIDGET', cookieA);
    expect(widgets.status).toBe(200);
    const widgetsBody = await widgets.json();
    expect(widgetsBody.pagination.total).toBe(2);
    expect(widgetsBody.products.map((product: { id: string }) => product.id)).toEqual(
      [ownIds[1], ownIds[0]],
    );

    const literalPercent = await list('?name=%25', cookieA);
    expect(literalPercent.status).toBe(200);
    const percentBody = await literalPercent.json();
    expect(percentBody.pagination.total).toBe(1);
    expect(percentBody.products[0].id).toBe(ownIds[3]);
  });

  it('combines the zero-stock and name filters within the tenant', async () => {
    const zero = await list('?zeroStock=true', cookieA);
    expect(zero.status).toBe(200);
    expect((await zero.json()).pagination.total).toBe(2);

    const combined = await list('?name=blue&zeroStock=true', cookieA);
    expect(combined.status).toBe(200);
    const body = await combined.json();
    expect(body.pagination.total).toBe(1);
    expect(body.products[0].id).toBe(ownIds[0]);
  });

  it('rejects missing sessions and invalid or tenant-selecting query parameters', async () => {
    expect((await list()).status).toBe(401);
    expect((await list('', 'stocksync_token=invalid')).status).toBe(401);
    for (const query of [
      '?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page=9007199254740992',
      '?limit=100', `?tenantId=${tenantB}`, '?zeroStock=yes', '?page=1&page=2',
      '?page[toString]=invalid',
    ]) {
      expect((await list(query, cookieA)).status).toBe(400);
    }
  });
});
