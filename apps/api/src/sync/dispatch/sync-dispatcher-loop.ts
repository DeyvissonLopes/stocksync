export type DispatcherRound = { runOnce(): Promise<unknown> };

function waitForNextRound(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runDispatcherLoop(
  dispatcher: DispatcherRound,
  signal: AbortSignal,
  reportError: (error: unknown) => void,
  intervalMs = 1000,
): Promise<void> {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('Dispatcher interval must be a positive integer');
  }
  while (!signal.aborted) {
    try {
      await dispatcher.runOnce();
    } catch (error) {
      reportError(error);
    }
    if (signal.aborted) return;
    await waitForNextRound(intervalMs, signal);
  }
}
