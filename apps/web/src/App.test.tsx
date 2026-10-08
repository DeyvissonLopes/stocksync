// @vitest-environment jsdom
import { StrictMode } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const identity = {
  userId: '9b8ef3e1-a27c-4410-8463-74c9f8a68738',
  tenantId: '0562aa57-3d45-42e6-8549-28549fdb3aa3',
  role: 'admin',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'admin@example.com');
  await user.type(screen.getByLabelText('Password'), 'secret-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('login screen', () => {
  it('sends credentials through the same-origin API and shows the returned identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: identity }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-StockSync-Request': '1' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'secret-password' }),
    }));
    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows a generic error for invalid credentials without exposing the API response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: 'Internal credential detail' }), { status: 401 },
      ));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(screen.queryByText('Internal credential detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains when the API limits sign-in attempts', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 })));

    render(<App />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many sign-in attempts. Try again shortly.',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows a retryable error when the request cannot reach the API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in. Try again.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('prevents a second submission while the first request is pending', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveRequest(new Response(JSON.stringify({ user: identity }), { status: 200 }));
    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
  });
});

describe('session lifecycle', () => {
  it('restores the identity from the existing browser cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ user: identity }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    }));
  });

  it('shows the login form after the API confirms there is no valid session', async () => {
    let resolveRequest!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));

    render(<App />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking session…');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    resolveRequest(new Response(null, { status: 401 }));
    expect(await screen.findByRole('heading', { name: 'Sign in to StockSync' })).toBeInTheDocument();
  });

  it('allows retrying a failed session check without assuming the user is signed out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your session.');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to StockSync' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale session response after StrictMode restarts the check', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);

    await act(async () => { resolveSecond(new Response(null, { status: 401 })); });
    expect(screen.getByRole('heading', { name: 'Sign in to StockSync' })).toBeInTheDocument();
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ user: identity }), { status: 200 }));
    });
    expect(screen.getByRole('heading', { name: 'Sign in to StockSync' })).toBeInTheDocument();
  });

  it('clears the visible session after the logout endpoint succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: identity }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByRole('heading', { name: 'Signed in' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-StockSync-Request': '1' },
    });
    expect(await screen.findByRole('heading', { name: 'Sign in to StockSync' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Signed in' })).not.toBeInTheDocument();
  });

  it('keeps the user signed in when logout fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: identity }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })));

    render(<App />);
    await screen.findByRole('heading', { name: 'Signed in' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out. Try again.');
    expect(screen.getByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});
