export type Identity = {
  userId: string;
  tenantId: string;
  role: 'admin' | 'operator';
};

export class LoginError extends Error {
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

export async function login(email: string, password: string): Promise<Identity> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-StockSync-Request': '1' },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 401) throw new LoginError('invalid');
  if (response.status === 429) throw new LoginError('rate-limited');
  if (!response.ok) throw new LoginError('unavailable');

  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('user' in body) ||
    !isIdentity(body.user)) throw new LoginError('unavailable');
  return body.user;
}
