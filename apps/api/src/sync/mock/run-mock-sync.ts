import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadDatabaseOptions } from '../../database/database-options.js';
import { createMockSyncServer } from './mock-sync-server.js';

async function main() {
  const mode = process.env.MOCK_SYNC_FAILURE_MODE ?? 'off';
  if (mode !== 'off' && mode !== 'demo') throw new Error('Invalid MOCK_SYNC_FAILURE_MODE');
  const db = new DataSource(loadDatabaseOptions(process.env));
  await db.initialize();
  const server = createMockSyncServer(db, { failureMode: mode });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3001, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    console.log(`Mock sync listening on port 3001 (${mode} mode)`);
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', () => resolve());
      process.once('SIGINT', () => resolve());
    });
  } finally {
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      await db.destroy();
    }
  }
}

main().catch(() => {
  console.error('Mock sync startup or shutdown failed');
  process.exitCode = 1;
});
