import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';

const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1',
  appOrigin: 'http://localhost:5173',
  jwtSecret: 'sync-status-test-secret-with-at-least-thirty-two-bytes',
};

let db: DataSource;
let app: INestApplication;
let baseUrl: string;
const tenantIds: string[] = [];
const cookies: string[] = [];

async function addBatch(tenantId: string, status: 'pending' | 'queued' | 'sent' | 'failed',
  sentAt: string | null = null): Promise<string> {
  const rows: Array<{ id: string }> = await db.query(
    `INSERT INTO sync_batches (tenant_id, status, sent_at)
     VALUES ($1, $2, $3) RETURNING id`, [tenantId, status, sentAt],
  );
  return rows[0]!.id;
}

async function addEvent(tenantId: string, productId: string, version: number,
  status: 'pending' | 'sent' | 'failed', batchId: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO outbox_events
       (tenant_id, product_id, product_version, sku, stock, price_cents, status, batch_id)
     VALUES ($1, $2, $3, 'STATUS', 5, 1290, $4, $5)`,
    [tenantId, productId, version, status, batchId],
  );
}

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  const passwordHash = await argon2.hash('status-test-password', { type: argon2.argon2id });
  for (const role of ['admin', 'operator']) {
    const tenantId = (await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-status-${randomUUID()}`, 'Sync Status Test'],
    ) as Array<{ id: string }>)[0]!.id;
    tenantIds.push(tenantId);
    const userId = (await db.query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, `status-${randomUUID()}@stocksync.test`, role, passwordHash],
    ) as Array<{ id: string }>)[0]!.id;
    const productId = (await db.query(
      `INSERT INTO products (tenant_id, sku, name, stock, price_cents)
       VALUES ($1, 'STATUS', 'Status Product', 5, 1290) RETURNING id`,
      [tenantId],
    ) as Array<{ id: string }>)[0]!.id;

    if (role === 'admin') {
      await addEvent(tenantId, productId, 1, 'pending');
      const queued = await addBatch(tenantId, 'queued');
      await addEvent(tenantId, productId, 2, 'pending', queued);
      const oldSent = await addBatch(tenantId, 'sent', '2026-10-05T10:00:00.000Z');
      await addEvent(tenantId, productId, 3, 'sent', oldSent);
      const latestSent = await addBatch(tenantId, 'sent', '2026-10-06T12:34:56.000Z');
      await addEvent(tenantId, productId, 4, 'sent', latestSent);
      const failed = await addBatch(tenantId, 'failed');
      await addEvent(tenantId, productId, 5, 'failed', failed);
    } else {
      await addEvent(tenantId, productId, 1, 'pending');
    }
    cookies.push(userId);
  }

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(testConfig).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const tokens = app.get(AuthTokenService);
  for (let index = 0; index < cookies.length; index++) {
    cookies[index] = `stocksync_token=${tokens.issue(cookies[index]!)}`;
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (db?.isInitialized) {
    for (const tenantId of tenantIds) {
      await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await db.destroy();
  }
});

function status(cookie?: string, query = '') {
  return fetch(`${baseUrl}/sync/status${query}`,
    { headers: cookie ? { Cookie: cookie } : {} });
}

describe('GET /sync/status over HTTP and PostgreSQL', () => {
  it('counts events and the latest confirmed batch only for the admin tenant', async () => {
    const response = await status(cookies[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      pending: 2, sent: 2, failed: 1,
      lastSuccessfulSync: '2026-10-06T12:34:56.000Z',
    });
  });

  it('shows only the operator tenant and null when no batch was confirmed', async () => {
    const response = await status(cookies[1]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pending: 1, sent: 0, failed: 0, lastSuccessfulSync: null,
    });
  });

  it('requires a valid session and rejects a tenant filter', async () => {
    expect((await status()).status).toBe(401);
    expect((await status('stocksync_token=invalid')).status).toBe(401);
    const response = await status(cookies[1], `?tenantId=${tenantIds[0]}`);
    expect(response.status).toBe(400);
  });
});
