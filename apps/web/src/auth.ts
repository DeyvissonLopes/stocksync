export type Identity = {
  userId: string;
  tenantId: string;
  role: 'admin' | 'operator';
};

export class AuthRequestError extends Error {
  constructor(readonly kind: 'invalid' | 'rate-limited' | 'unavailable') {
    super(kind);
  }
}

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== 'object' || value === null || !('userId' in value) ||
    !('tenantId' in value) || !('role' in value)) return false;
  return typeof value.userId === 'string' && typeof value.tenantId === 'string' &&
    (value.role === 'admin' || value.role === 'operator');
}

async function readIdentity(response: Response): Promise<Identity> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('user' in body) ||
    !isIdentity(body.user)) throw new AuthRequestError('unavailable');
  return body.user;
}

export async function currentSession(signal: AbortSignal): Promise<Identity | null> {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin', signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new AuthRequestError('unavailable');
  return readIdentity(response);
}

export async function login(email: string, password: string): Promise<Identity> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-StockSync-Request': '1' },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 401) throw new AuthRequestError('invalid');
  if (response.status === 429) throw new AuthRequestError('rate-limited');
  if (!response.ok) throw new AuthRequestError('unavailable');

  return readIdentity(response);
}

export async function logout(): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-StockSync-Request': '1' },
  });
  if (!response.ok) throw new AuthRequestError('unavailable');
}
