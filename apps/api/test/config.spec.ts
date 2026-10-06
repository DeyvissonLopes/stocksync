import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigModule } from '../src/config/config.module.js';
import { APP_CONFIG, loadConfiguration } from '../src/config/app-config.js';
import type { AppConfig } from '../src/config/app-config.js';

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

  it('allows an explicit container listen address', () => {
    expect(loadConfiguration({ PORT: '3000', LISTEN_HOST: '0.0.0.0' }))
      .toMatchObject({ listenHost: '0.0.0.0' });
  });

  it.each(['development', 'test', 'production'] as const)(
    'accepts %s and supplies typed configuration through Nest',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('PORT', '3000');
      vi.stubEnv('LISTEN_HOST', '127.0.0.1');
      const module = await Test.createTestingModule({ imports: [ConfigModule] }).compile();
      try {
        expect(module.get<AppConfig>(APP_CONFIG)).toEqual({
          nodeEnv,
          port: 3000,
          listenHost: '127.0.0.1',
        });
      } finally {
        await module.close();
      }
    },
  );

  it('defaults to development and accepts the boundaries of valid ports', () => {
    expect(loadConfiguration({ PORT: '1' })).toEqual({
      nodeEnv: 'development',
      port: 1,
      listenHost: '127.0.0.1',
    });
    expect(loadConfiguration({ PORT: '65535' }).port).toBe(65535);
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
