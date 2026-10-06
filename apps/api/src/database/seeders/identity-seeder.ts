import argon2 from 'argon2';
import type { EntityManager } from 'typeorm';
import type { Seeder } from './database-seeder.js';

const demoPassword = 'StockSyncDemo123!';
const tenants = [
  { slug: 'alpha', name: 'Alpha Store' },
  { slug: 'beta', name: 'Beta Store' },
] as const;
const roles = ['admin', 'operator'] as const;

export class IdentitySeeder implements Seeder {
  async run(manager: EntityManager): Promise<void> {
    for (const tenant of tenants) {
      const tenantRows: Array<{ id: string }> = await manager.query(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
        [tenant.slug, tenant.name],
      );
      const tenantId = tenantRows[0]?.id;
      if (!tenantId) throw new Error('Seed tenant could not be resolved');

      for (const role of roles) {
        const email = `${role}@${tenant.slug}.stocksync.test`;
        const existing: Array<{ tenant_id: string; role: string }> = await manager.query(
          'SELECT tenant_id, role FROM users WHERE email = $1',
          [email],
        );
        if (existing[0]) {
          if (existing[0].tenant_id !== tenantId || existing[0].role !== role) {
            throw new Error('Seed email belongs to another identity');
          }
          continue;
        }

        const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
        await manager.query(
          `INSERT INTO users (tenant_id, email, role, password_hash)
           VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
          [tenantId, email, role, passwordHash],
        );
        const inserted: Array<{ tenant_id: string; role: string }> = await manager.query(
          'SELECT tenant_id, role FROM users WHERE email = $1',
          [email],
        );
        if (inserted[0]?.tenant_id !== tenantId || inserted[0]?.role !== role) {
          throw new Error('Seed email belongs to another identity');
        }
      }
    }
  }
}
