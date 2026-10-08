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
const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'product-read-test-secret-with-at-least-thirty-two-bytes',
};

let dataSource: DataSource;
let app: INestApplication;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let operatorB: string;
let productA: string;
let productB: string;
let archivedA: string;
let highPriceA: string;
let cookieA: string;
let cookieB: string;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();

  const tenant = async () => {
    const rows: Array<{ id: string }> = await dataSource.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`product-read-${randomUUID()}`, 'Product Read Test'],
    );
    return rows[0]!.id;
  };
  tenantA = await tenant();
  tenantB = await tenant();

  const user = async (tenantId: string, role: 'admin' | 'operator') => {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, '$argon2id$test-hash') RETURNING id`,
      [tenantId, `${randomUUID()}@product-read.test`, role],
    );
    return rows[0]!.id;
  };
  adminA = await user(tenantA, 'admin');
  operatorB = await user(tenantB, 'operator');

  const product = async (tenantId: string, sku: string, stock: number, priceCents = '1990') => {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
       VALUES ($1, $2, 'Shared product', $3, $4) RETURNING id`,
      [tenantId, sku, priceCents, stock],
    );
    return rows[0]!.id;
  };
  productA = await product(tenantA, 'SHARED', 3);
  productB = await product(tenantB, 'SHARED', 7);
  archivedA = await product(tenantA, 'ARCHIVED', 2);
  highPriceA = await product(tenantA, 'HIGH-PRICE', 0, '9007199254740993');
  await dataSource.query(
    'UPDATE products SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
    [adminA, archivedA],
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

function read(id: string, cookie?: string) {
  return fetch(`${baseUrl}/products/${id}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe('GET /products/:id over HTTP and PostgreSQL', () => {
  it('lets admin and operator read only their own active product', async () => {
    const ownA = await read(productA, cookieA);
    expect(ownA.status).toBe(200);
    expect(await ownA.json()).toEqual({
      product: { id: productA, sku: 'SHARED', name: 'Shared product', price: '19.90',
        stock: 3, version: '1' },
    });
    expect(ownA.headers.get('cache-control')).toBe('no-store');

    const ownB = await read(productB, cookieB);
    expect(ownB.status).toBe(200);
    expect(await ownB.json()).toEqual({
      product: { id: productB, sku: 'SHARED', name: 'Shared product', price: '19.90',
        stock: 7, version: '1' },
    });
  });

  it('preserves a bigint price above JavaScript number precision', async () => {
    const response = await read(highPriceA, cookieA);
    expect(response.status).toBe(200);
    expect((await response.json()).product.price).toBe('90071992547409.93');
  });

  it('hides foreign, archived and absent products behind the same 404', async () => {
    for (const id of [productB, archivedA, randomUUID()]) {
      const response = await read(id, cookieA);
      expect(response.status).toBe(404);
    }
    expect((await read(productA, cookieB)).status).toBe(404);
  });

  it('ignores client attempts to select another tenant', async () => {
    const response = await fetch(`${baseUrl}/products/${productB}?tenantId=${tenantB}`, {
      headers: { Cookie: cookieA, 'X-Tenant-Id': tenantB },
    });
    expect(response.status).toBe(404);
  });

  it('requires a valid session cookie', async () => {
    expect((await read(productA)).status).toBe(401);
    expect((await read(productA, 'stocksync_token=invalid')).status).toBe(401);
  });
});
