import 'reflect-metadata';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { SyncBatcher } from '../src/sync/dispatch/sync-batcher.js';
import { SyncJobPublisher } from '../src/sync/dispatch/sync-job-publisher.js';
import { createSyncQueue, migrateSyncQueue, syncBatchJobId } from '../src/sync/queue/sync-queue.js';

let db: DataSource;
let queue: ReturnType<typeof createSyncQueue>;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
  await migrateSyncQueue(process.env);
  queue = createSyncQueue(process.env);
});

afterAll(async () => {
  if (queue) await queue.close();
  if (db?.isInitialized) await db.destroy();
});

describe('continuous sync worker process', () => {
  it('rejects an invalid destination URL without exposing its value', () => {
    const executable = fileURLToPath(new URL('../src/sync/worker/run-worker.js', import.meta.url));
    const result = spawnSync(process.execPath, [executable], {
      env: { ...process.env, SYNC_DESTINATION_URL: 'file://private-sentinel' },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Invalid configuration: SYNC_DESTINATION_URL');
    expect(result.stderr).not.toContain('private-sentinel');
  });

  it('finishes an active HTTP batch before exiting on SIGTERM', async () => {
    const tenantId = (await db.query(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [`sync-process-${randomUUID()}`, 'Sync Process Test'],
    ) as Array<{ id: string }>)[0]!.id;
    const productId = (await db.query(
      `INSERT INTO products (tenant_id, sku, name, stock, price_cents)
       VALUES ($1, 'PROCESS-1', 'Process Product', 3, 799) RETURNING id`,
      [tenantId],
    ) as Array<{ id: string }>)[0]!.id;
    const eventId = (await db.query(
      `INSERT INTO outbox_events
       (tenant_id, product_id, product_version, sku, stock, price_cents)
       VALUES ($1, $2, 1, 'PROCESS-1', 3, 799) RETURNING id`,
      [tenantId, productId],
    ) as Array<{ id: string }>)[0]!.id;
    const batchId = (await new SyncBatcher(db).createForTenant(tenantId))!.id;
    await new SyncJobPublisher(db, queue).publish(batchId);

    let receiveRequest!: () => void;
    const requestReceived = new Promise<void>((resolve) => { receiveRequest = resolve; });
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let calls = 0;
    const server = createServer(async (_request, response) => {
      calls++;
      receiveRequest();
      await responseReleased;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ batchId, acknowledgedEventIds: [eventId] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');

    const executable = fileURLToPath(new URL('../src/sync/worker/run-worker.js', import.meta.url));
    const child = spawn(process.execPath, [executable], {
      env: { ...process.env,
        SYNC_DESTINATION_URL: `http://127.0.0.1:${address.port}/batches` },
      stdio: 'ignore',
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      await Promise.race([
        requestReceived,
        exited.then(() => { throw new Error('Sync worker exited before HTTP'); }),
      ]);
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      releaseResponse();
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(calls).toBe(1);
      expect(await db.query('SELECT status FROM sync_batches WHERE id = $1',
        [batchId])).toEqual([{ status: 'sent' }]);
      expect(await db.query('SELECT status FROM outbox_events WHERE id = $1',
        [eventId])).toEqual([{ status: 'sent' }]);
    } finally {
      releaseResponse();
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await (await queue.getJob(syncBatchJobId(batchId)))?.remove();
      await db.query('DELETE FROM outbox_events WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM sync_batches WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }, 10000);
});
