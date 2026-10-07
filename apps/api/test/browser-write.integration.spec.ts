import 'reflect-metadata';
import { Controller, Get, Patch, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config/app-config.js';
import { BrowserSecurityModule } from '../src/security/browser-security.module.js';

const allowedOrigin = 'http://localhost:5173';
let writes = 0;
let app: INestApplication;
let baseUrl: string;

@Controller('test-browser-write')
class TestWriteController {
  @Post()
  write() {
    writes += 1;
    return { writes };
  }

  @Get()
  read() {
    return { writes };
  }

  @Patch()
  patch() {
    writes += 1;
    return { writes };
  }
}

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [BrowserSecurityModule],
    controllers: [TestWriteController],
  }).overrideProvider(APP_CONFIG).useValue({
    nodeEnv: 'test', port: 3000, listenHost: '127.0.0.1', appOrigin: allowedOrigin,
  }).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  if (app) await app.close();
});

function post(headers: Record<string, string>) {
  return fetch(`${baseUrl}/test-browser-write`, {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('browser write protection over HTTP', () => {
  it('allows a same-origin JSON write with the browser marker', async () => {
    const response = await post({
      Origin: allowedOrigin,
      'X-StockSync-Request': '1',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(response.status).toBe(201);
  });

  it.each([
    ['external origin', { Origin: 'https://attacker.test', 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }],
    ['deceptive prefix', { Origin: `${allowedOrigin}.attacker.test`, 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }],
    ['null origin', { Origin: 'null', 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }],
    ['missing origin', { 'X-StockSync-Request': '1', 'Content-Type': 'application/json' }],
    ['missing marker', { Origin: allowedOrigin, 'Content-Type': 'application/json' }],
    ['wrong marker', { Origin: allowedOrigin, 'X-StockSync-Request': '0', 'Content-Type': 'application/json' }],
  ])('rejects %s without running the handler', async (_case, headers) => {
    const before = writes;
    const response = await post(headers);
    expect(response.status).toBe(403);
    expect(writes).toBe(before);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data',
    'application/jsonp'])('rejects %s even when origin and marker are valid', async (contentType) => {
    const before = writes;
    const response = await post({
      Origin: allowedOrigin,
      'X-StockSync-Request': '1',
      'Content-Type': contentType,
    });
    expect(response.status).toBe(415);
    expect(writes).toBe(before);
  });

  it('protects PATCH as well as POST', async () => {
    const before = writes;
    const response = await fetch(`${baseUrl}/test-browser-write`, {
      method: 'PATCH',
      headers: { Origin: 'https://attacker.test', 'X-StockSync-Request': '1',
        'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(writes).toBe(before);
  });

  it('allows a read without write headers', async () => {
    const response = await fetch(`${baseUrl}/test-browser-write`);
    expect(response.status).toBe(200);
  });

  it('does not authorize an external browser preflight', async () => {
    const response = await fetch(`${baseUrl}/test-browser-write`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-stocksync-request,content-type',
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
