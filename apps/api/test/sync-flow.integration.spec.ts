import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatchProcessor } from '../src/sync/worker/sync-batch-processor.js';
import { SyncBatcher } from '../src/sync/dispatch/sync-batcher.js';
import { SyncJobPublisher } from '../src/sync/dispatch/sync-job-publisher.js';
import { createSyncQueue, createSyncWorker, migrateSyncQueue,
  syncBatchJobId } from '../src/sync/queue/sync-queue.js';
import { createMockSyncServer } from '../src/sync/mock/mock-sync-server.js';

const origin = 'http://127.0.0.1:5173';
const config = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'sync-flow-test-secret-with-at-least-thirty-two-bytes',
};

let db: DataSource;
let mockDb: DataSource;
let app: INestApplication;
let server: Server;
let queue: ReturnType<typeof createSyncQueue>;
let worker: ReturnType<typeof createSyncWorker> | undefined;
let url: string;
let tenantId: string;
let cookie: string;
let batchId: string | undefined;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  await migrateSyncQueue(process.env);
  mockDb = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  queue = createSyncQueue(process.env);
  tenantId = (await db.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`sync-flow-${randomUUID()}`, 'Sync Flow Test'],
  ) as Array<{ id: string }>)[0]!.id;
  const userId = (await db.query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'admin', '$argon2id$test-hash') RETURNING id`,
    [tenantId, `sync-flow-${randomUUID()}@stocksync.test`],
  ) as Array<{ id: string }>)[0]!.id;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  cookie = `stocksync_token=${app.get(AuthTokenService).issue(userId)}`;
});

afterAll(async () => {
  if (worker) await worker.close();
  if (server) await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  if (batchId) await (await queue.getJob(syncBatchJobId(batchId)))?.remove();
  if (queue) await queue.close();
  if (app) await app.close();
  if (db?.isInitialized && tenantId) {
    await db.query('DELETE FROM mock_sync.products WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM stock_movements WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM sale_items WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM sales WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
  if (mockDb?.isInitialized) await mockDb.destroy();
  if (db?.isInitialized) await db.destroy();
});

function status() {
  return fetch(`${url}/sync/status`, { headers: { Cookie: cookie } });
}

function write(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-StockSync-Request': '1',
      'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function waitForSent(id: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(syncBatchJobId(id)))?.getState();
    if (state === 'completed') return;
    if (state === 'failed') throw new Error('Sync job failed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for sync job');
}

describe('product and sale sync flow', () => {
  it('moves committed snapshots from API through PostgreSQL queue to mock and status', async () => {
    const create = await write('/products',
      { sku: 'FLOW-1', name: 'Flow Product', stock: 5, price: '12.90' });
    expect(create.status).toBe(201);
    const productId = (await create.json()).product.id as string;
    const sale = await write('/sales', { items: [{ productId, quantity: 2 }] },
      { 'Idempotency-Key': randomUUID() });
    expect(sale.status).toBe(201);
    expect(await status().then((response) => response.json())).toEqual({
      pending: 2, sent: 0, failed: 0, lastSuccessfulSync: null,
    });

    batchId = (await new SyncBatcher(db).createForTenant(tenantId))?.id;
    expect(batchId).toEqual(expect.any(String));
    await new SyncJobPublisher(db, queue).publish(batchId!);
    expect(await status().then((response) => response.json())).toEqual({
      pending: 2, sent: 0, failed: 0, lastSuccessfulSync: null,
    });

    server = createMockSyncServer(mockDb);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing mock address');
    worker = createSyncWorker(process.env,
      new SyncBatchProcessor(db, `http://127.0.0.1:${address.port}/batches`));
    await waitForSent(batchId!);

    const result = await status();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      pending: 0, sent: 2, failed: 0, lastSuccessfulSync: expect.any(String),
    });
    expect(await mockDb.query(
      'SELECT stock, price_cents, version FROM mock_sync.products WHERE tenant_id = $1',
      [tenantId],
    )).toEqual([{ stock: 3, price_cents: '1290', version: '2' }]);
    expect(await db.query(
      'SELECT status, product_version FROM outbox_events WHERE tenant_id = $1 ORDER BY product_version',
      [tenantId],
    )).toEqual([
      { status: 'sent', product_version: '1' },
      { status: 'sent', product_version: '2' },
    ]);
  }, 15000);
});
