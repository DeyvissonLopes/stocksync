import { migrateSyncQueue } from './sync-queue.js';

migrateSyncQueue(process.env).catch(() => {
  console.error('Sync queue migration failed');
  process.exitCode = 1;
});
