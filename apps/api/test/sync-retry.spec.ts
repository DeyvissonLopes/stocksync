import { describe, expect, it, vi } from 'vitest';
import { syncRetryDelay } from '../src/sync/sync-retry.js';

describe('sync retry backoff', () => {
  it('doubles the retry delay after each transient failure with a controlled jitter draw', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect([1, 2, 3].map((attempt) => syncRetryDelay(attempt)))
        .toEqual([750, 1500, 3000]);
    } finally {
      random.mockRestore();
    }
  });
});
