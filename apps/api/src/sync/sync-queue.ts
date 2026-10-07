import { Queue, createPostgresBackend, runMigrations } from 'bullmq';
import { Pool } from 'pg';
import { loadDatabaseOptions } from '../database/database-options.js';

export const SYNC_QUEUE_NAME = 'product-sync';
export const syncBatchJobId = (batchId: string): string => `batch-${batchId}`;

function connection(env: NodeJS.ProcessEnv) {
  const database = loadDatabaseOptions(env);
  if (database.type !== 'postgres') throw new Error('PostgreSQL is required for the sync queue');
  if (!database.host || !database.port || !database.username ||
      typeof database.password !== 'string' || !database.database) {
    throw new Error('PostgreSQL connection is incomplete');
  }
  return {
    host: database.host,
    port: database.port,
    user: database.username,
    password: database.password,
    database: database.database,
    max: 4,
    schema: 'bullmq',
  };
}

export function createSyncQueue(env: NodeJS.ProcessEnv) {
  return new Queue(SYNC_QUEUE_NAME, { connection: connection(env) }, createPostgresBackend);
}

export async function migrateSyncQueue(env: NodeJS.ProcessEnv): Promise<void> {
  const pool = new Pool(connection(env));
  try {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
