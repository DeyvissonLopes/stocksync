import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('identity schema', () => {
  it('requires a real tenant, one allowed role, and a globally unique email', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const manager = runner.manager;
      const rows: Array<{ id: string }> = await manager.query(
        "INSERT INTO tenants (slug, name) VALUES ('schema-test', 'Schema Test') RETURNING id",
      );
      const tenantId = rows[0]?.id;
      expect(tenantId).toBeDefined();
      if (!tenantId) throw new Error('Tenant insert returned no ID');
      const otherRows: Array<{ id: string }> = await manager.query(
        "INSERT INTO tenants (slug, name) VALUES ('other-schema-test', 'Other Schema Test') RETURNING id",
      );
      const otherTenantId = otherRows[0]?.id;
      if (!otherTenantId) throw new Error('Other tenant insert returned no ID');

      const insertUser = (tenant: string, email: string, role: string) => manager.query(
        'INSERT INTO users (tenant_id, email, role, password_hash) VALUES ($1, $2, $3, $4)',
        [tenant, email, role, '$argon2id$test-hash'],
      );

      await insertUser(tenantId, 'admin@schema.test', 'admin');
      await insertUser(tenantId, 'Case@schema.test', 'operator');
      const caseRows: Array<{ email: string }> = await manager.query(
        'SELECT email FROM users WHERE tenant_id = $1 AND email = $2',
        [tenantId, 'Case@schema.test'],
      );
      expect(caseRows).toEqual([{ email: 'Case@schema.test' }]);

      async function rejected(operation: () => Promise<unknown>): Promise<void> {
        await manager.query('SAVEPOINT invalid_identity');
        try {
          await expect(operation()).rejects.toThrow();
        } finally {
          await manager.query('ROLLBACK TO SAVEPOINT invalid_identity');
          await manager.query('RELEASE SAVEPOINT invalid_identity');
        }
      }

      await rejected(() => insertUser('00000000-0000-0000-0000-000000000000', 'orphan@schema.test', 'admin'));
      await rejected(() => insertUser(tenantId, 'invalid-role@schema.test', 'owner'));
      await rejected(() => insertUser(otherTenantId, 'admin@schema.test', 'operator'));
      await rejected(() => manager.query(
        'INSERT INTO users (email, role, password_hash) VALUES ($1, $2, $3)',
        ['missing-tenant@schema.test', 'operator', '$argon2id$test-hash'],
      ));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
