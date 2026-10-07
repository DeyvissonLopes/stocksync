export class SyncRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Sync destination returned 429');
  }
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? seconds * 1000 : undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function syncRetryDelay(attemptsMade: number, _type?: string, error?: Error): number {
  const base = 1000 * 2 ** Math.max(0, attemptsMade - 1);
  const jittered = Math.floor(base * (0.5 + Math.random() * 0.5));
  return Math.max(jittered, error instanceof SyncRateLimitedError ? error.retryAfterMs : 0);
}
