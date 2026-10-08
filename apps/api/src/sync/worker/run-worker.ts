import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ConfigurationError } from '../../config/app-config.js';
import { loadDatabaseOptions } from '../../database/database-options.js';
import { SyncBatchProcessor } from './sync-batch-processor.js';
import { createSyncWorker } from '../queue/sync-queue.js';

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

function destinationUrl(env: NodeJS.ProcessEnv): string {
  const value = env.SYNC_DESTINATION_URL;
  if (!value || value !== value.trim()) throw new ConfigurationError('SYNC_DESTINATION_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('SYNC_DESTINATION_URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname || url.username || url.password || url.hash) {
    throw new ConfigurationError('SYNC_DESTINATION_URL');
  }
  return url.href;
}

async function main(): Promise<void> {
  let dataSource: DataSource | undefined;
  let worker: ReturnType<typeof createSyncWorker> | undefined;
  try {
    const endpoint = destinationUrl(process.env);
    dataSource = new DataSource(loadDatabaseOptions(process.env));
    await dataSource.initialize();
    worker = createSyncWorker(process.env, new SyncBatchProcessor(dataSource, endpoint));
    worker.on('error', () => console.error('Sync worker queue error'));
    await worker.waitUntilReady();
    console.log('Sync worker ready');
    if (!shutdown.signal.aborted) {
      await new Promise<void>((resolve) =>
        shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
  } catch (error) {
    console.error(error instanceof ConfigurationError
      ? error.message : 'Sync worker startup failed');
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    try {
      await worker?.close();
    } catch {
      console.error('Sync worker queue shutdown failed');
      process.exitCode = 1;
    }
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } catch {
      console.error('Sync worker database shutdown failed');
      process.exitCode = 1;
    }
  }
}

void main();
