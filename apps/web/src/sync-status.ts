export type SyncStatus = {
  pending: number;
  sent: number;
  failed: number;
  lastSuccessfulSync: string | null;
};

export class SyncStatusError extends Error {
  constructor(readonly kind: 'unauthorized' | 'unavailable') {
    super(kind);
  }
}

function isSyncStatus(value: unknown): value is SyncStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    !('pending' in value) || !('sent' in value) || !('failed' in value) ||
    !('lastSuccessfulSync' in value)) return false;
  return [value.pending, value.sent, value.failed].every((count) =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) &&
    (value.lastSuccessfulSync === null ||
      (typeof value.lastSuccessfulSync === 'string' &&
        !Number.isNaN(Date.parse(value.lastSuccessfulSync))));
}

export async function getSyncStatus(signal: AbortSignal): Promise<SyncStatus> {
  const response = await fetch('/api/sync/status', { credentials: 'same-origin', signal });
  if (response.status === 401) throw new SyncStatusError('unauthorized');
  if (!response.ok) throw new SyncStatusError('unavailable');
  try {
    const body: unknown = await response.json();
    if (isSyncStatus(body)) return body;
  } catch { /* A malformed response is unavailable to the UI. */ }
  throw new SyncStatusError('unavailable');
}
