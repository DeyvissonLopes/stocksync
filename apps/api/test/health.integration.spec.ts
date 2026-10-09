import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.js';

const testConfig = {
  nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1',
  appOrigin: 'http://127.0.0.1:5173',
  jwtSecret: 'health-test-secret-with-at-least-thirty-two-bytes',
};

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(testConfig).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('GET /health over HTTP', () => {
  it('reports API process health without requiring a session', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
