import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { parseMockBatch } from './mock-sync-contract.js';
import { MockSyncStore, MockVersionConflictError } from './mock-sync-store.js';

export type MockOutcome = 'success' | 'error' | 'timeout-before' | 'timeout-after';

type Options = {
  decideOutcome?: () => MockOutcome;
  failureMode?: 'off' | 'demo';
  random?: () => number;
  timeoutDelayMs?: number;
  now?: () => number;
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, status: number, body: object,
  headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function demoOutcome(random: () => number): MockOutcome {
  const draw = random();
  if (draw < 0.1) return 'error';
  if (draw < 0.15) return 'timeout-before';
  if (draw < 0.2) return 'timeout-after';
  return 'success';
}

export function createMockSyncServer(db: DataSource, options: Options = {}) {
  const store = new MockSyncStore(db);
  const now = options.now ?? (() => performance.now());
  const timeoutDelayMs = options.timeoutDelayMs ?? 2500;
  const decideOutcome = options.decideOutcome ?? (options.failureMode === 'demo'
    ? () => demoOutcome(options.random ?? Math.random) : () => 'success');
  let callTimes: number[] = [];

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/batches') {
      json(response, 404, { error: 'Not found' });
      return;
    }

    const timestamp = now();
    callTimes = callTimes.filter((time) => time > timestamp - 1000);
    if (callTimes.length >= 5) {
      const seconds = Math.max(1, Math.ceil((callTimes[0]! + 1000 - timestamp) / 1000));
      json(response, 429, { error: 'Rate limit exceeded' },
        { 'retry-after': String(seconds) });
      return;
    }
    callTimes.push(timestamp);

    try {
      const batch = parseMockBatch(await readJson(request));
      if (!batch) {
        json(response, 400, { error: 'Invalid batch' });
        return;
      }

      const outcome = decideOutcome();
      if (outcome === 'error') {
        json(response, 503, { error: 'Simulated upstream failure' });
        return;
      }
      if (outcome !== 'timeout-before') await store.apply(batch);
      if (outcome === 'timeout-before' || outcome === 'timeout-after') {
        await delay(timeoutDelayMs);
        json(response, 504, { error: 'Simulated timeout' });
        return;
      }
      json(response, 200, { batchId: batch.batchId,
        acknowledgedEventIds: batch.updates.map((item) => item.eventId) });
    } catch (error) {
      if (error instanceof MockVersionConflictError) {
        json(response, 409, { error: 'Conflicting values for product version' });
      } else if (error instanceof SyntaxError) {
        json(response, 400, { error: 'Invalid JSON' });
      } else {
        console.error('Mock sync request failed');
        json(response, 500, { error: 'Mock sync failure' });
      }
    }
  });
}
