import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigModule } from '../src/config/config.module.js';
import { APP_CONFIG, loadConfiguration } from '../src/config/app-config.js';
import type { AppConfig } from '../src/config/app-config.js';

const testJwtSecret = 'jwt-test-secret-with-at-least-thirty-two-bytes';

afterEach(() => vi.unstubAllEnvs());

describe('startup configuration', () => {
  it('prevents Nest initialization when PORT is invalid, without exposing its value', async () => {
    vi.stubEnv('PORT', 'private-input-sentinel');
    vi.stubEnv('NODE_ENV', 'test');

    const initialization = Test.createTestingModule({ imports: [ConfigModule] })
      .compile()
      .then(async (module) => {
        await module.close();
      });
    await expect(initialization).rejects.toThrow(/^Invalid configuration: PORT$/);
  });

  it.each([undefined, '', '0', '-1', '65536', '3.5', '3000abc', ' 3000 ', '1e3'])(
    'rejects a missing or invalid PORT (%s)',
    (port) => {
      expect(() => loadConfiguration({ PORT: port }))
        .toThrow(/^Invalid configuration: PORT$/);
    },
  );

  it('rejects an unsupported environment without exposing the supplied value', () => {
    expect(() => loadConfiguration({ PORT: '3000', NODE_ENV: 'private-input-sentinel' }))
      .toThrow(/^Invalid configuration: NODE_ENV$/);
  });

  it('rejects an unsupported listen address without exposing its value', () => {
    expect(() => loadConfiguration({ PORT: '3000', LISTEN_HOST: 'private-input-sentinel' }))
      .toThrow(/^Invalid configuration: LISTEN_HOST$/);
  });

  it.each([undefined, '', 'null', '*', 'https://app.example.test/',
    'https://app.example.test/path', 'https://app.example.test.attacker.test,https://app.example.test'])(
    'rejects an invalid APP_ORIGIN (%s) without exposing it', (appOrigin) => {
      expect(() => loadConfiguration({ PORT: '3000', APP_ORIGIN: appOrigin }))
        .toThrow(/^Invalid configuration: APP_ORIGIN$/);
    },
  );

  it('requires HTTPS origin in production', () => {
    expect(() => loadConfiguration({
      NODE_ENV: 'production', PORT: '3000', APP_ORIGIN: 'http://app.example.test',
    })).toThrow(/^Invalid configuration: APP_ORIGIN$/);
  });

  it.each([undefined, '', 'short', ' '.repeat(32)])(
    'rejects a missing or weak JWT_SECRET (%s) without exposing it', (jwtSecret) => {
      expect(() => loadConfiguration({
        PORT: '3000', APP_ORIGIN: 'http://127.0.0.1:5173', JWT_SECRET: jwtSecret,
      })).toThrow(/^Invalid configuration: JWT_SECRET$/);
    },
  );

  it('rejects the local example secret in production', () => {
    expect(() => loadConfiguration({
      NODE_ENV: 'production', PORT: '3000', APP_ORIGIN: 'https://app.example.test',
      JWT_SECRET: 'local-only-change-this-secret-32-bytes-minimum',
    })).toThrow(/^Invalid configuration: JWT_SECRET$/);
  });

  it('allows an explicit container listen address', () => {
    expect(loadConfiguration({ PORT: '3000', LISTEN_HOST: '0.0.0.0', APP_ORIGIN: 'http://127.0.0.1:5173',
      JWT_SECRET: testJwtSecret }))
      .toMatchObject({ listenHost: '0.0.0.0' });
  });

  it.each(['development', 'test', 'production'] as const)(
    'accepts %s and supplies typed configuration through Nest',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('PORT', '3000');
      vi.stubEnv('LISTEN_HOST', '127.0.0.1');
      vi.stubEnv('APP_ORIGIN', nodeEnv === 'production' ? 'https://app.example.test' : 'http://127.0.0.1:5173');
      vi.stubEnv('JWT_SECRET', testJwtSecret);
      const module = await Test.createTestingModule({ imports: [ConfigModule] }).compile();
      try {
        expect(module.get<AppConfig>(APP_CONFIG)).toEqual({
          nodeEnv,
          port: 3000,
          listenHost: '127.0.0.1',
          appOrigin: nodeEnv === 'production' ? 'https://app.example.test' : 'http://127.0.0.1:5173',
          jwtSecret: testJwtSecret,
        });
      } finally {
        await module.close();
      }
    },
  );

  it('defaults to development and accepts the boundaries of valid ports', () => {
    expect(loadConfiguration({ PORT: '1', APP_ORIGIN: 'http://127.0.0.1:5173',
      JWT_SECRET: testJwtSecret })).toEqual({
      nodeEnv: 'development',
      port: 1,
      listenHost: '127.0.0.1',
      appOrigin: 'http://127.0.0.1:5173',
      jwtSecret: testJwtSecret,
    });
    expect(loadConfiguration({ PORT: '65535', APP_ORIGIN: 'http://127.0.0.1:5173',
      JWT_SECRET: testJwtSecret }).port).toBe(65535);
  });

  it('exits with a sanitized error when the executable receives invalid configuration', () => {
    const executable = fileURLToPath(new URL('../src/main.js', import.meta.url));
    const result = spawnSync(process.execPath, [executable], {
      env: { NODE_ENV: 'test', PORT: 'private-input-sentinel' },
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Invalid configuration: PORT');
    expect(result.stderr).not.toContain('private-input-sentinel');
    expect(result.stderr).not.toContain('at ');
  });
});
