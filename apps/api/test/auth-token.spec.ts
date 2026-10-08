import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AuthTokenModule } from '../src/auth/auth-token.module.js';
import { AuthTokenService } from '../src/auth/auth-token.service.js';
import { APP_CONFIG } from '../src/config/app-config.js';

const secret = 'jwt-test-secret-with-at-least-thirty-two-bytes';
const otherSecret = 'another-jwt-test-secret-with-thirty-two-bytes';
const userId = '10000000-0000-4000-8000-000000000001';
const issuer = 'stocksync-api';
const audience = 'stocksync-browser';

function makeService() {
  return new AuthTokenService(new JwtService({ secret }));
}

function makeVerifiedService() {
  const service = makeService();
  expect(service.verify(service.issue(userId))).toBe(userId);
  return service;
}

function externallySigned(payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return new JwtService({ secret }).sign(payload, {
    algorithm: 'HS256', issuer, audience, ...options,
  });
}

describe('JWT identity token', () => {
  it('uses the configured secret when the Nest module issues and verifies tokens', async () => {
    const module = await Test.createTestingModule({ imports: [AuthTokenModule] })
      .overrideProvider(APP_CONFIG).useValue({
        nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1',
        appOrigin: 'http://127.0.0.1:5173', jwtSecret: secret,
      }).compile();
    try {
      const token = module.get(AuthTokenService).issue(userId);
      expect(new JwtService({ secret }).verify<Record<string, unknown>>(token, {
        algorithms: ['HS256'], issuer, audience,
      }).sub).toBe(userId);
      expect(module.get(AuthTokenService).verify(token)).toBe(userId);
    } finally {
      await module.close();
    }
  });

  it('issues a signed one-hour token with only the user subject and standard claims', () => {
    const token = makeService().issue(userId);
    const claims = new JwtService({ secret }).verify<Record<string, unknown>>(token, {
      algorithms: ['HS256'], issuer, audience,
    });

    expect(claims.sub).toBe(userId);
    expect(claims.iss).toBe(issuer);
    expect(claims.aud).toBe(audience);
    expect(claims.iat).toEqual(expect.any(Number));
    expect(claims.exp).toBe((claims.iat as number) + 3600);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
    expect(makeService().verify(token)).toBe(userId);
  });

  it('rejects malformed, unsigned and tampered tokens', () => {
    const service = makeVerifiedService();
    const token = service.issue(userId);
    const [header, payload, signature] = token.split('.');
    const changedPayload = Buffer.from(JSON.stringify({ sub: '20000000-0000-4000-8000-000000000002' }))
      .toString('base64url');
    expect(service.verify('not-a-jwt')).toBeNull();
    expect(service.verify(`${header}.${payload}.`)).toBeNull();
    expect(service.verify(`${header}.${changedPayload}.${signature}`)).toBeNull();
    expect(service.verify(new JwtService({ secret: otherSecret }).sign({ sub: userId }))).toBeNull();
  });

  it('rejects an expired token and a token without expiration', () => {
    const service = makeVerifiedService();
    expect(service.verify(externallySigned({ sub: userId }, { expiresIn: -1 }))).toBeNull();
    expect(service.verify(externallySigned({ sub: userId }))).toBeNull();
  });

  it('rejects an unsupported algorithm, issuer or audience', () => {
    const service = makeVerifiedService();
    const payload = { sub: userId };
    expect(service.verify(externallySigned(payload, { algorithm: 'HS384', expiresIn: 3600 }))).toBeNull();
    expect(service.verify(externallySigned(payload, { issuer: 'attacker', expiresIn: 3600 }))).toBeNull();
    expect(service.verify(externallySigned(payload, { audience: 'other-app', expiresIn: 3600 }))).toBeNull();
  });

  it('rejects missing or malformed subjects and missing issue time', () => {
    const service = makeVerifiedService();
    expect(service.verify(externallySigned({}, { expiresIn: 3600 }))).toBeNull();
    expect(service.verify(externallySigned({ sub: 'not-a-uuid' }, { expiresIn: 3600 }))).toBeNull();
    expect(service.verify(externallySigned({ sub: userId }, { expiresIn: 3600, noTimestamp: true }))).toBeNull();
  });

  it('does not accept tenant or role claims as identity', () => {
    const service = makeVerifiedService();
    expect(service.verify(externallySigned({ sub: userId, tenantId: 'attacker', role: 'admin' },
      { expiresIn: 3600 }))).toBeNull();
  });

  it('refuses to issue a token for a malformed user ID', () => {
    expect(() => makeService().issue('not-a-uuid')).toThrow();
  });
});
