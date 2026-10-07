import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatcherLoop } from '../src/sync/sync-dispatcher-loop.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sync dispatcher process loop', () => {
  it('never overlaps rounds and waits for the active round on shutdown', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finishRound!: () => void;
    const firstRound = new Promise<void>((resolve) => { finishRound = resolve; });
    const runOnce = vi.fn().mockReturnValueOnce(firstRound);
    const reportError = vi.fn();
    const loop = runDispatcherLoop({ runOnce }, controller.signal, reportError);

    try {
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(runOnce).toHaveBeenCalledTimes(1);
      controller.abort();
      let stopped = false;
      void loop.then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finishRound();
      await loop;
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      finishRound();
    }
  });

  it('reports a failed round and retries after the interval until stopped', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const failure = new Error('database unavailable');
    const runOnce = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const reportError = vi.fn();
    const loop = runDispatcherLoop({ runOnce }, controller.signal, reportError);

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
      await vi.advanceTimersByTimeAsync(999);
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runOnce).toHaveBeenCalledTimes(2);
      controller.abort();
      await loop;
    } finally {
      controller.abort();
    }
  });
});
