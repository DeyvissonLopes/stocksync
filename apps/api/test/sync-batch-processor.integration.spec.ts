import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { createMockSyncServer } from '../src/sync/mock/mock-sync-server.js';
import { SyncBatchProcessor } from '../src/sync/sync-batch-processor.js';
import { SyncBatchReconciler } from '../src/sync/sync-batch-reconciler.js';
import { SyncBatcher } from '../src/sync/sync-batcher.js';
import { SyncJobPublisher } from '../src/sync/sync-job-publisher.js';
import { createSyncQueue, createSyncWorker, migrateSyncQueue,
  syncBatchJobId } from '../src/sync/sync-queue.js';

let db: DataSource;
let mockDb: DataSource;
let queue: ReturnType<typeof createSyncQueue>;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  mockDb = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await migrateSyncQueue(process.env);
  queue = createSyncQueue(process.env);
});

afterAll(async () => {
  if (queue) await queue.close();
  if (mockDb?.isInitialized) await mockDb.destroy();
  if (db?.isInitialized) await db.destroy();
});

async function withBatch(check: (batchId: string, tenantId: string,
  productId: string, eventId: string) => Promise<void>) {
  const tenantId = (await db.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`sync-worker-${randomUUID()}`, 'Sync Worker Test'],
  ) as Array<{ id: string }>)[0]!.id;
  const productId = (await db.query(
    `INSERT INTO products (tenant_id, sku, name, stock, price_cents)
     VALUES ($1, 'WORKER-1', 'Worker Product', 5, 1290) RETURNING id`, [tenantId],
  ) as Array<{ id: string }>)[0]!.id;
  const eventId = (await db.query(
    `INSERT INTO outbox_events
       (tenant_id, product_id, product_version, sku, stock, price_cents)
     VALUES ($1, $2, 1, 'WORKER-1', 5, 1290) RETURNING id`,
    [tenantId, productId],
  ) as Array<{ id: string }>)[0]!.id;
  const batchId = (await new SyncBatcher(db).createForTenant(tenantId))!.id;
  await new SyncJobPublisher(db, queue).publish(batchId);
  try {
    await check(batchId, tenantId, productId, eventId);
  } finally {
    await (await queue.getJob(syncBatchJobId(batchId)))?.remove();
    await db.query('DELETE FROM mock_sync.products WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
    await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
}

async function withServer(server: Server, check: (endpoint: string) => Promise<void>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  try {
    await check(`http://127.0.0.1:${address.port}/batches`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

async function waitForCompletion(batchId: string) {
  const deadline = Date.now() + 10000;
  const jobId = syncBatchJobId(batchId);
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed') return;
    if (state === 'failed') throw new Error('Sync job failed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for sync job');
}

describe('sync batch processing over BullMQ, HTTP and PostgreSQL', () => {
  it('consumes one job, sends the stored snapshot and atomically records ACK', async () => {
    await withBatch(async (batchId, tenantId, productId, eventId) => {
      let calls = 0;
      const mock = createMockSyncServer(mockDb, {
        decideOutcome: () => { calls++; return 'success'; },
      });
      await withServer(mock, async (endpoint) => {
        await db.query('UPDATE products SET stock = 99 WHERE id = $1', [productId]);
        const processor = new SyncBatchProcessor(db, endpoint);
        const worker = createSyncWorker(process.env, processor);
        try {
          await waitForCompletion(batchId);
          expect(await db.query(
            'SELECT status, attempts_started, sent_at FROM sync_batches WHERE id = $1',
            [batchId],
          )).toEqual([{ status: 'sent', attempts_started: 1, sent_at: expect.any(Date) }]);
          expect(await db.query('SELECT id, status FROM outbox_events WHERE batch_id = $1',
            [batchId])).toEqual([{ id: eventId, status: 'sent' }]);
          expect(await mockDb.query(
            'SELECT stock, price_cents, version FROM mock_sync.products WHERE tenant_id = $1',
            [tenantId],
          )).toEqual([{ stock: 5, price_cents: '1290', version: '1' }]);
          await processor.process({ batchId, tenantId });
          expect(calls).toBe(1);
          expect(await db.query('SELECT attempts_started FROM sync_batches WHERE id = $1',
            [batchId])).toEqual([{ attempts_started: 1 }]);
        } finally {
          await worker.close();
        }
      });
    });
  });

  it('refuses a tenant mismatched with the batch before any HTTP call', async () => {
    await withBatch(async (batchId, tenantId) => {
      const processor = new SyncBatchProcessor(db, 'http://127.0.0.1:1/batches');
      await expect(processor.process({ batchId, tenantId: randomUUID() }))
        .rejects.toThrow();
      expect(await db.query('SELECT status, attempts_started FROM sync_batches WHERE id = $1',
        [batchId])).toEqual([{ status: 'queued', attempts_started: 0 }]);
      expect(await db.query('SELECT count(*)::integer AS count FROM outbox_events WHERE tenant_id = $1',
        [tenantId])).toEqual([{ count: 1 }]);
    });
  });

  it('retries a transient HTTP failure and confirms the next successful attempt', async () => {
    await withBatch(async (batchId, tenantId, _productId, eventId) => {
      let calls = 0;
      const fake = createServer((_request, response) => {
        calls++;
        response.writeHead(calls === 1 ? 503 : 200,
          { 'content-type': 'application/json' });
        response.end(JSON.stringify({ batchId, acknowledgedEventIds: [eventId] }));
      });
      await withServer(fake, async (endpoint) => {
        const worker = createSyncWorker(process.env, new SyncBatchProcessor(db, endpoint));
        try {
          await waitForCompletion(batchId);
          expect(calls).toBe(2);
          expect(await db.query(
            'SELECT status, attempts_started, last_error FROM sync_batches WHERE id = $1',
            [batchId],
          )).toEqual([{ status: 'sent', attempts_started: 2, last_error: null }]);
          expect(await db.query('SELECT status FROM outbox_events WHERE id = $1',
            [eventId])).toEqual([{ status: 'sent' }]);
        } finally {
          await worker.close();
        }
      });
    });
  });

  it('fails a permanent HTTP error without another call', async () => {
    await withBatch(async (batchId, tenantId, _productId, eventId) => {
      let calls = 0;
      const fake = createServer((_request, response) => {
        calls++;
        response.writeHead(400).end();
      });
      await withServer(fake, async (endpoint) => {
        const worker = createSyncWorker(process.env, new SyncBatchProcessor(db, endpoint));
        try {
          const job = await queue.getJob(syncBatchJobId(batchId));
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && await job?.getState() !== 'failed') {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(await job?.getState()).toBe('failed');
          expect(calls).toBe(1);
          expect(await db.query(
            'SELECT status, attempts_started, failed_at, last_error FROM sync_batches WHERE id = $1',
            [batchId],
          )).toEqual([{ status: 'failed', attempts_started: 1,
            failed_at: expect.any(Date), last_error: 'HTTP_400' }]);
          expect(await db.query('SELECT status FROM outbox_events WHERE id = $1',
            [eventId])).toEqual([{ status: 'failed' }]);
        } finally {
          await worker.close();
        }
      });
    });
  });

  it('retains a permanent failed job for reconciliation when the terminal DB write fails',
    async () => {
      await withBatch(async (batchId, tenantId, _productId, eventId) => {
        let calls = 0;
        const fake = createServer((_request, response) => {
          calls++;
          vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('DB write unavailable'));
          response.writeHead(400).end();
        });
        try {
          await withServer(fake, async (endpoint) => {
            const worker = createSyncWorker(process.env, new SyncBatchProcessor(db, endpoint));
            try {
              const job = await queue.getJob(syncBatchJobId(batchId));
              const deadline = Date.now() + 5000;
              while (Date.now() < deadline && await job?.getState() !== 'failed') {
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              expect(await job?.getState()).toBe('failed');
              expect(calls).toBe(1);
              expect(await db.query('SELECT status FROM sync_batches WHERE id = $1',
                [batchId])).toEqual([{ status: 'queued' }]);
            } finally {
              await worker.close();
            }
          });
        } finally {
          vi.restoreAllMocks();
        }
        expect(await new SyncBatchReconciler(db, queue).reconcile())
          .toEqual({ publicationAttempts: 0, unresolved: [] });
        expect(await db.query('SELECT status, last_error FROM sync_batches WHERE id = $1',
          [batchId])).toEqual([{ status: 'failed', last_error: 'JOB_FAILED' }]);
        expect(await db.query('SELECT status FROM outbox_events WHERE id = $1',
          [eventId])).toEqual([{ status: 'failed' }]);
      });
    });

  it('closes an exhausted reservation after restart without a sixth HTTP call', async () => {
    await withBatch(async (batchId, tenantId, _productId, eventId) => {
      await db.query('UPDATE sync_batches SET attempts_started = 5 WHERE id = $1', [batchId]);
      const processor = new SyncBatchProcessor(db, 'http://127.0.0.1:1/batches');
      await expect(processor.process({ batchId, tenantId }))
        .rejects.toThrow('Sync attempt budget exhausted');
      expect(await db.query(
        'SELECT status, attempts_started, last_error FROM sync_batches WHERE id = $1',
        [batchId],
      )).toEqual([{ status: 'failed', attempts_started: 5,
        last_error: 'ATTEMPT_BUDGET_EXHAUSTED' }]);
      expect(await db.query('SELECT status FROM outbox_events WHERE id = $1',
        [eventId])).toEqual([{ status: 'failed' }]);
    });
  });

  it('fails the batch and events after five invalid ACKs without a sixth call', async () => {
    await withBatch(async (batchId, tenantId, _productId, eventId) => {
      const responses = [
        { batchId, acknowledgedEventIds: [] },
        { batchId: randomUUID(), acknowledgedEventIds: [eventId] },
        { batchId, acknowledgedEventIds: [eventId, eventId] },
        { batchId, acknowledgedEventIds: [randomUUID()] },
        { batchId, acknowledgedEventIds: [eventId, randomUUID()] },
      ];
      let calls = 0;
      const fake = createServer((_request, response) => {
        calls++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responses.shift()));
      });
      await withServer(fake, async (endpoint) => {
        const processor = new SyncBatchProcessor(db, endpoint);
        for (let index = 0; index < 5; index++) {
          await expect(processor.process({ batchId, tenantId }))
            .rejects.toThrow('Invalid sync acknowledgement');
        }
        await expect(processor.process({ batchId, tenantId }))
          .rejects.toThrow('Sync batch failed');
        expect(calls).toBe(5);
        expect(await db.query(
          'SELECT status, attempts_started, sent_at FROM sync_batches WHERE id = $1',
          [batchId],
        )).toEqual([{ status: 'failed', attempts_started: 5, sent_at: null }]);
        expect(await db.query('SELECT status FROM outbox_events WHERE batch_id = $1',
          [batchId])).toEqual([{ status: 'failed' }]);
      });
    });
  });
});
