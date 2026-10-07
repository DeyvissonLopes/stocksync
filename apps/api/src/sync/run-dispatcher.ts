import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ConfigurationError } from '../config/app-config.js';
import { loadDatabaseOptions } from '../database/database-options.js';
import { runDispatcherLoop } from './sync-dispatcher-loop.js';
import { SyncDispatcher } from './sync-dispatcher.js';
import { createSyncQueue } from './sync-queue.js';

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function main(): Promise<void> {
  let dataSource: DataSource | undefined;
  let queue: ReturnType<typeof createSyncQueue> | undefined;
  try {
    dataSource = new DataSource(loadDatabaseOptions(process.env));
    await dataSource.initialize();
    queue = createSyncQueue(process.env);
    await runDispatcherLoop(new SyncDispatcher(dataSource, queue), shutdown.signal,
      () => console.error('Sync dispatcher round failed'));
  } catch (error) {
    console.error(error instanceof ConfigurationError
      ? error.message : 'Sync dispatcher startup failed');
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    try {
      await queue?.close();
    } catch {
      console.error('Sync dispatcher queue shutdown failed');
      process.exitCode = 1;
    }
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } catch {
      console.error('Sync dispatcher database shutdown failed');
      process.exitCode = 1;
    }
  }
}

void main();
