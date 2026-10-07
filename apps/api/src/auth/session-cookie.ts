import type { AppConfig } from '../config/app-config.js';

export function sessionCookie(token: string, environment: AppConfig['nodeEnv']): string {
  const secure = environment === 'production' ? '; Secure' : '';
  return `stocksync_token=${token}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
