export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly listenHost: '127.0.0.1' | '0.0.0.0';
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type DatabaseConfigurationField =
  `${'DB' | 'TEST_DB'}_${'HOST' | 'PORT' | 'USER' | 'PASSWORD' | 'NAME'}`;

export class ConfigurationError extends Error {
  constructor(field: 'NODE_ENV' | 'PORT' | 'LISTEN_HOST' | DatabaseConfigurationField) {
    super(`Invalid configuration: ${field}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfiguration(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new ConfigurationError('NODE_ENV');
  }

  const portInput = env.PORT ?? '';
  const port = Number(portInput);
  if (!/^\d+$/.test(portInput) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT');
  }

  const listenHost = env.LISTEN_HOST ?? '127.0.0.1';
  if (listenHost !== '127.0.0.1' && listenHost !== '0.0.0.0') {
    throw new ConfigurationError('LISTEN_HOST');
  }

  return {
    nodeEnv,
    port,
    listenHost,
  };
}
