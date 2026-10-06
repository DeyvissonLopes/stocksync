import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { ConfigurationError } from '../config/app-config.js';

type Prefix = 'DB' | 'TEST_DB';
type Field = `${Prefix}_${'HOST' | 'PORT' | 'USER' | 'PASSWORD' | 'NAME'}`;

function required(env: NodeJS.ProcessEnv, field: Field): string {
  const value = env[field];
  if (!value) throw new ConfigurationError(field);
  return value;
}

function target(env: NodeJS.ProcessEnv, prefix: Prefix) {
  const host = required(env, `${prefix}_HOST`);
  if (/\s|\//.test(host)) throw new ConfigurationError(`${prefix}_HOST`);

  const portInput = required(env, `${prefix}_PORT`);
  const port = Number(portInput);
  if (!/^\d+$/.test(portInput) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`${prefix}_PORT`);
  }

  const username = required(env, `${prefix}_USER`);
  const password = required(env, `${prefix}_PASSWORD`);
  const database = required(env, `${prefix}_NAME`);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(database)) {
    throw new ConfigurationError(`${prefix}_NAME`);
  }

  return { host, port, username, password, database };
}

export function loadDatabaseOptions(env: NodeJS.ProcessEnv): DataSourceOptions {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new ConfigurationError('NODE_ENV');
  }

  const demo = target(env, 'DB');
  let selected = demo;
  if (nodeEnv === 'test') {
    selected = target(env, 'TEST_DB');
    const sameTarget = selected.host.toLowerCase().replace(/\.$/, '') ===
      demo.host.toLowerCase().replace(/\.$/, '') &&
      selected.port === demo.port && selected.database === demo.database;
    if (!selected.database.endsWith('_test') || sameTarget) {
      throw new ConfigurationError('TEST_DB_NAME');
    }
  }

  return {
    type: 'postgres',
    ...selected,
    synchronize: false,
    migrationsRun: false,
    entities: [],
    migrations: [join(fileURLToPath(new URL('.', import.meta.url)), 'migrations', '*.js')],
  };
}
