import { useEffect, useState } from 'react';
import { getSyncStatus, SyncStatusError } from './sync-status';
import type { SyncStatus } from './sync-status';

type StatusState =
  | { kind: 'loading' | 'error' }
  | { kind: 'ready'; data: SyncStatus; refreshFailed: boolean };

export function SyncStatusPage({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [status, setStatus] = useState<StatusState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function refresh() {
      controller = new AbortController();
      try {
        const data = await getSyncStatus(controller.signal);
        if (active) setStatus({ kind: 'ready', data, refreshFailed: false });
      } catch (error) {
        if (!active) return;
        if (error instanceof SyncStatusError && error.kind === 'unauthorized') {
          active = false;
          onSessionExpired();
          return;
        }
        setStatus((previous) => previous.kind === 'ready'
          ? { ...previous, refreshFailed: true } : { kind: 'error' });
      } finally {
        if (active) timer = setTimeout(() => { void refresh(); }, 5000);
      }
    }

    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [attempt, onSessionExpired]);

  return (
    <section aria-labelledby="sync-status-heading">
      <h1 id="sync-status-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">Sync status</h1>
      <p className="mt-2 text-sm text-slate-600">Delivery of inventory updates for this account.</p>

      {status.kind === 'loading' && <p role="status" className="mt-8 text-sm text-slate-600">Loading sync status…</p>}
      {status.kind === 'error' && (
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 p-5">
          <p role="alert" className="text-sm text-rose-800">Could not load sync status.</p>
          <button type="button" onClick={() => { setStatus({ kind: 'loading' }); setAttempt((value) => value + 1); }}
            className="mt-3 rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-700">
            Try again
          </button>
        </div>
      )}
      {status.kind === 'ready' && (
        <>
          {status.refreshFailed && (
            <p role="alert" className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              Could not refresh sync status. Showing the last available counts.
            </p>
          )}
          {status.data.pending + status.data.sent + status.data.failed === 0 && (
            <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600">No updates yet.</p>
          )}
          <dl className="mt-6 grid gap-4 sm:grid-cols-3">
            {([
              ['Pending updates', status.data.pending],
              ['Sent updates', status.data.sent],
              ['Failed updates', status.data.failed],
            ] as const).map(([label, count]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-5">
                <dt className="text-sm font-medium text-slate-600">{label}</dt>
                <dd className="mt-2 text-3xl font-semibold tabular-nums text-slate-950">{count}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-600">Last successful sync</p>
            {status.data.lastSuccessfulSync ? (
              <time role="time" dateTime={status.data.lastSuccessfulSync} className="mt-2 block font-semibold text-slate-950">
                {new Date(status.data.lastSuccessfulSync).toLocaleString()}
              </time>
            ) : (
              <p className="mt-2 font-semibold text-slate-950">No successful sync yet.</p>
            )}
          </div>
          {status.data.failed > 0 && (
            <p className="mt-4 text-sm text-amber-900">
              Confirmation failed; the external update may have been applied. Investigate before retrying.
            </p>
          )}
        </>
      )}
    </section>
  );
}
