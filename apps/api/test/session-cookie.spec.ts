import { describe, expect, it } from 'vitest';
import { clearSessionCookie, sessionCookie } from '../src/auth/session-cookie.js';

describe('browser session cookie', () => {
  it('sets a host-only HttpOnly cookie matching the one-hour JWT lifetime', () => {
    expect(sessionCookie('a.b.c', 'test')).toBe(
      'stocksync_token=a.b.c; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('requires HTTPS transport in production', () => {
    expect(sessionCookie('a.b.c', 'production')).toBe(
      'stocksync_token=a.b.c; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('expires the same host-only cookie, preserving Secure in production', () => {
    expect(clearSessionCookie('production')).toBe(
      'stocksync_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
  });
});
