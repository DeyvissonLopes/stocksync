// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncStatusPage } from './SyncStatusPage';

const statusResponse = (pending: number, sent: number, failed: number,
  lastSuccessfulSync: string | null = null) => new Response(JSON.stringify({
  pending, sent, failed, lastSuccessfulSync,
}), { status: 200 });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sync status', () => {
  it('shows tenant event counts and the last successful sync from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(
      2, 5, 1, '2026-10-08T12:00:00.000Z',
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<SyncStatusPage onSessionExpired={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading sync status…');
    expect(await screen.findByText('Pending updates')).toBeInTheDocument();
    expect(screen.getByText('Pending updates').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Sent updates').parentElement).toHaveTextContent('5');
    expect(screen.getByText('Failed updates').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Last successful sync').parentElement)
      .toContainElement(screen.getByRole('time'));
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', '2026-10-08T12:00:00.000Z');
    expect(fetchMock).toHaveBeenCalledWith('/api/sync/status', {
      credentials: 'same-origin', signal: expect.any(AbortSignal),
    });
  });

  it('explains when there are no updates or confirmed batches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse(0, 0, 0)));

    render(<SyncStatusPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByText('No updates yet.')).toBeInTheDocument();
    expect(screen.getByText('No successful sync yet.')).toBeInTheDocument();
  });

  it('offers retry after a transient failure and expires the session on 401', async () => {
    const onSessionExpired = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(statusResponse(1, 0, 0))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SyncStatusPage onSessionExpired={onSessionExpired} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sync status.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pending updates')).toBeInTheDocument();
    expect(screen.getByText('Pending updates').parentElement).toHaveTextContent('1');
    expect(onSessionExpired).not.toHaveBeenCalled();

    // Retry by remounting to exercise an unauthorized response without waiting for a poll.
    cleanup();
    render(<SyncStatusPage onSessionExpired={onSessionExpired} />);
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
  });

  it('polls after each completed read and stops when the page closes', async () => {
    vi.useFakeTimers();
    let finishFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(() => Promise.resolve(statusResponse(0, 1, 0)));
    vi.stubGlobal('fetch', fetchMock);

    const page = render(<SyncStatusPage onSessionExpired={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { finishFirst(statusResponse(1, 0, 0)); });
    expect(screen.getByText('Pending updates').parentElement).toHaveTextContent('1');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Sent updates').parentElement).toHaveTextContent('1');

    page.unmount();
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
