// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  await user.type(screen.getByRole('textbox', { name: 'Email' }), 'admin@example.com');
  await user.type(screen.getByLabelText('Password'), 'secret-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('login screen', () => {
  it('sends credentials through the same-origin API and shows the returned identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ user: identity }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })));

    render(<App />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many sign-in attempts. Try again shortly.',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows a retryable error when the request cannot reach the API', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in. Try again.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('prevents a second submission while the first request is pending', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await submitLogin();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRequest(new Response(JSON.stringify({ user: identity }), { status: 200 }));
    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
  });
});
