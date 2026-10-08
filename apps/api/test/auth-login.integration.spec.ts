import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { CredentialVerifier } from '../src/auth/credential-verifier.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';

const origin = 'http://127.0.0.1:5173';
const password = 'correct-password';
const email = `MiXeD-${randomUUID()}@auth.stocksync.test`;
const inactiveEmail = `inactive-${randomUUID()}@auth.stocksync.test`;
const unknownEmail = `unknown-${randomUUID()}@auth.stocksync.test`;
const rateEmail = `limited-${randomUUID()}@auth.stocksync.test`;
const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: origin,
  jwtSecret: 'login-test-secret-with-at-least-thirty-two-bytes',
};

let dataSource: DataSource;
let app: INestApplication;
let baseUrl: string;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
  const tenants: Array<{ id: string }> = await dataSource.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`login-${randomUUID().slice(0, 8)}`, 'Login Test'],
  );
  tenantId = tenants[0]!.id;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const users: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'operator', $3) RETURNING id`,
    [tenantId, email, hash],
  );
  userId = users[0]!.id;
  await dataSource.query(
    `INSERT INTO users (tenant_id, email, role, password_hash, is_active)
     VALUES ($1, $2, 'admin', $3, false)`,
    [tenantId, inactiveEmail, hash],
  );

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(testConfig).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  if (app) await app.close();
  if (dataSource?.isInitialized && tenantId) {
    await dataSource.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function login(email: string, password: string) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-StockSync-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: email, password: password }),
  });
}

describe('POST /auth/login over HTTP and PostgreSQL', () => {
  it('issues an HttpOnly cookie with a valid JWT and returns the current identity', async () => {
    const response = await login(email, password);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { userId, tenantId, role: 'operator' },
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toMatch(/^stocksync_token=[^;]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).not.toContain('Domain=');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const token = cookie?.match(/^stocksync_token=([^;]+)/)?.[1];
    expect(token).toBeDefined();
    expect(app.get(AuthTokenService).verify(token!)).toBe(userId);
  });

  it('does not authenticate a differently cased email', async () => {
    const response = await login(email.toLowerCase(), password);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('uses the same generic response for a wrong password, unknown email and inactive user', async () => {
    const responses = await Promise.all([
      login(email, 'wrong-password'),
      login(unknownEmail, password),
      login(inactiveEmail, password),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    for (const response of responses) {
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-ratelimit-remaining-email')).toBeNull();
      expect(response.headers.get('x-ratelimit-remaining-ip')).toBeNull();
    }
  });

  it('returns a short pause after five requests for one email', async () => {
    const verify = vi.spyOn(app.get(CredentialVerifier), 'verify');
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(rateEmail, 'wrong-password')).status).toBe(401);
      }
      const response = await login(rateEmail, 'wrong-password');
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(30);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(verify).toHaveBeenCalledTimes(5);
    } finally {
      verify.mockRestore();
    }
  });

  it('counts successful login requests in the email limit', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(testConfig)
      .overrideProvider(CredentialVerifier).useValue({
        verify: async () => ({ userId, tenantId, role: 'operator' }),
      })
      .compile();
    const isolatedApp = module.createNestApplication({ logger: false });
    try {
      await isolatedApp.listen(0, '127.0.0.1');
      const isolatedUrl = await isolatedApp.getUrl();
      const attempt = () => fetch(`${isolatedUrl}/auth/login`, {
        method: 'POST',
        headers: {
          Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'successful-limit@auth.stocksync.test', password }),
      });
      for (let index = 0; index < 5; index += 1) {
        expect((await attempt()).status).toBe(200);
      }
      const response = await attempt();
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(30);
    } finally {
      await isolatedApp.close();
    }
  });

  it.each([
    ['external origin', { Origin: 'https://attacker.test', 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }, 403],
    ['missing origin', { 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }, 403],
    ['missing marker', { Origin: origin, 'Content-Type': 'application/json' }, 403],
    ['form submission', { Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
  ])('rejects %s before login can issue a cookie', async (_case, headers, status) => {
    const verify = vi.spyOn(app.get(CredentialVerifier), 'verify');
    try {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST', headers, body: JSON.stringify({ email, password }),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  it('does not authorize an external browser preflight for login', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-stocksync-request,content-type',
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects malformed login input without issuing a cookie or exposing the input', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: { secret: 'private-input-sentinel' } }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('private-input-sentinel');
  });

  it('rejects a null byte in email before querying PostgreSQL', async () => {
    const response = await login(`invalid\u0000@auth.stocksync.test`, password);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not let X-Forwarded-For spoofing bypass the IP limit', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(testConfig)
      .overrideProvider(CredentialVerifier).useValue({ verify: async () => null })
      .compile();
    const isolatedApp = module.createNestApplication({ logger: false });
    try {
      await isolatedApp.listen(0, '127.0.0.1');
      const isolatedUrl = await isolatedApp.getUrl();
      const attempt = (index: number) => fetch(`${isolatedUrl}/auth/login`, {
        method: 'POST',
        headers: {
          Origin: origin, 'X-StockSync-Request': '1', 'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${index}`,
        },
        body: JSON.stringify({ email: `ip-${index}@auth.stocksync.test`, password }),
      });
      for (let index = 0; index < 30; index += 1) {
        expect((await attempt(index)).status).toBe(401);
      }
      const response = await attempt(30);
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(900);
    } finally {
      await isolatedApp.close();
    }
  });
});
