import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';

const origin = 'http://localhost:5173';
const email = `session-${randomUUID()}@auth.stocksync.test`;
const password = 'correct-password';
const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'session-test-secret-with-at-least-thirty-two-bytes',
};

let dataSource: DataSource;
let app: INestApplication;
let baseUrl: string;
let tenantId: string;
let userId: string;
let cookie: string;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
  const tenants: Array<{ id: string }> = await dataSource.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`me-${randomUUID().slice(0, 8)}`, 'Session Test'],
  );
  tenantId = tenants[0]!.id;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const users: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'operator', $3) RETURNING id`,
    [tenantId, email, hash],
  );
  userId = users[0]!.id;

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(testConfig).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-StockSync-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  expect(cookie).toMatch(/^stocksync_token=.+/);
});

afterAll(async () => {
  if (app) await app.close();
  if (dataSource?.isInitialized && tenantId) {
    await dataSource.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function me(headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/auth/me`, { headers });
}

describe('GET /auth/me over HTTP and PostgreSQL', () => {
  it('restores the current identity from the login cookie without exposing a token', async () => {
    const response = await me({ Cookie: cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { userId, tenantId, role: 'operator' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a missing cookie even when a bearer token is supplied', async () => {
    const token = app.get(AuthTokenService).issue(userId);
    const response = await me({ Authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects altered, expired and duplicate session cookies', async () => {
    const token = cookie.slice('stocksync_token='.length);
    const expired = new JwtService({ secret: testConfig.jwtSecret }).sign({ sub: userId }, {
      algorithm: 'HS256', issuer: 'stocksync-api', audience: 'stocksync-browser', expiresIn: -1,
    });
    for (const badCookie of [
      `stocksync_token=${token}tampered`,
      `stocksync_token=${expired}`,
      `${cookie}; ${cookie}`,
    ]) {
      const response = await me({ Cookie: badCookie });
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('reads the current tenant and role from the database and rejects an inactive user', async () => {
    try {
      await dataSource.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
      const response = await fetch(`${baseUrl}/auth/me?tenantId=${randomUUID()}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user: { userId, tenantId, role: 'admin' } });

      await dataSource.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
      const inactive = await me({ Cookie: cookie });
      expect(inactive.status).toBe(401);
      expect(inactive.headers.get('set-cookie')).toBeNull();
    } finally {
      await dataSource.query("UPDATE users SET role = 'operator', is_active = true WHERE id = $1", [userId]);
    }
  });

  it('rejects a valid token for an unknown user', async () => {
    const token = app.get(AuthTokenService).issue(randomUUID());
    expect((await me({ Cookie: `stocksync_token=${token}` })).status).toBe(401);
  });
});

describe('POST /auth/logout over HTTP', () => {
  function logout(headers: Record<string, string> = {
    Origin: origin, 'X-StockSync-Request': '1',
  }) {
    return fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers });
  }

  it('clears the browser cookie without claiming to revoke the JWT', async () => {
    const response = await logout({
      Origin: origin, 'X-StockSync-Request': '1', Cookie: cookie,
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBe(
      'stocksync_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect((await me({ Cookie: 'stocksync_token=' })).status).toBe(401);
    expect((await me({ Cookie: cookie })).status).toBe(200);
  });

  it('also clears an absent or invalid session cookie', async () => {
    for (const headers of [
      { Origin: origin, 'X-StockSync-Request': '1' },
      { Origin: origin, 'X-StockSync-Request': '1', Cookie: 'stocksync_token=invalid' },
    ]) {
      const response = await logout(headers);
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toContain('stocksync_token=; Max-Age=0; Path=/');
    }
  });

  it.each([
    ['missing Origin', { 'X-StockSync-Request': '1' }],
    ['missing marker', { Origin: origin }],
    ['wrong Origin', { Origin: 'https://attacker.test', 'X-StockSync-Request': '1' }],
  ])('rejects %s before clearing the cookie', async (_case, headers) => {
    const response = await logout(headers);
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
