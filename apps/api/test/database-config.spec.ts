import { describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';

const demoEnv = {
  DB_HOST: 'db',
  DB_PORT: '5432',
  DB_USER: 'demo',
  DB_PASSWORD: 'password',
  DB_NAME: 'stocksync',
};

const testEnv = {
  TEST_DB_HOST: 'db-test',
  TEST_DB_PORT: '5432',
  TEST_DB_USER: 'tester',
  TEST_DB_PASSWORD: 'test-password',
  TEST_DB_NAME: 'stocksync_test',
};

describe('database configuration', () => {
  it('accepts separate environment fields, including a password with URL characters', () => {
    expect(loadDatabaseOptions({
      NODE_ENV: 'development', ...demoEnv, DB_PASSWORD: 'p@ss/#word',
    })).toMatchObject({
      type: 'postgres',
      host: 'db',
      port: 5432,
      username: 'demo',
      password: 'p@ss/#word',
      database: 'stocksync',
    });
  });

  it('requires an explicit target for the application database', () => {
    expect(() => loadDatabaseOptions({ NODE_ENV: 'development' }))
      .toThrow(/^Invalid configuration: DB_HOST$/);
  });

  it('requires a separately named test database before running tests', () => {
    expect(() => loadDatabaseOptions({ NODE_ENV: 'test', ...demoEnv }))
      .toThrow(/^Invalid configuration: TEST_DB_HOST$/);
    expect(() => loadDatabaseOptions({
      NODE_ENV: 'test', ...demoEnv, ...testEnv, TEST_DB_NAME: 'stocksync',
    })).toThrow(/^Invalid configuration: TEST_DB_NAME$/);
    expect(() => loadDatabaseOptions({
      NODE_ENV: 'test', ...demoEnv, ...testEnv,
      TEST_DB_HOST: 'DB.',
      DB_NAME: 'stocksync_test',
    })).toThrow(/^Invalid configuration: TEST_DB_NAME$/);
  });

  it('rejects malformed targets without exposing the supplied values', () => {
    expect(() => loadDatabaseOptions({
      NODE_ENV: 'development', ...demoEnv, DB_PORT: 'private-input-sentinel',
    })).toThrow(/^Invalid configuration: DB_PORT$/);
    expect(() => loadDatabaseOptions({
      NODE_ENV: 'test', ...demoEnv, ...testEnv,
      TEST_DB_NAME: 'private-input-sentinel%',
    })).toThrow(/^Invalid configuration: TEST_DB_NAME$/);
  });

  it('selects the test target and never synchronizes or runs migrations on connection', () => {
    expect(loadDatabaseOptions({
      NODE_ENV: 'test', ...demoEnv, ...testEnv,
    })).toMatchObject({
      type: 'postgres',
      host: 'db-test',
      database: 'stocksync_test',
      username: 'tester',
      synchronize: false,
      migrationsRun: false,
      migrations: [expect.stringContaining('migrations')],
    });
  });

  it('selects the application target outside tests', () => {
    expect(loadDatabaseOptions({ NODE_ENV: 'production', ...demoEnv, ...testEnv }))
      .toMatchObject({ host: 'db', database: 'stocksync', synchronize: false, migrationsRun: false });
  });
});
