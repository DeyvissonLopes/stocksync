import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { DataSource, type QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CredentialVerifier } from '../src/auth/credential-verifier.js';
import { loadDatabaseOptions } from '../src/database/database-options.js';
import { UserEntity } from '../src/database/entities/user.entity.js';

let dataSource: DataSource;
let runner: QueryRunner;
let verifier: CredentialVerifier;
let tenantId: string;
let activeUserId: string;
const email = `MiXeD-${randomUUID()}@auth.stocksync.test`;
const inactiveEmail = `inactive-${randomUUID()}@auth.stocksync.test`;
const password = 'correct-password';

beforeAll(async () => {
  dataSource = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await dataSource.runMigrations();
  runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  const tenants: Array<{ id: string }> = await runner.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [`auth-${randomUUID().slice(0, 8)}`, 'Auth Test'],
  );
  tenantId = tenants[0]!.id;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const users: Array<{ id: string }> = await runner.query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'operator', $3) RETURNING id`,
    [tenantId, email, hash],
  );
  activeUserId = users[0]!.id;
  await runner.query(
    `INSERT INTO users (tenant_id, email, role, password_hash, is_active)
     VALUES ($1, $2, 'admin', $3, false)`,
    [tenantId, inactiveEmail, hash],
  );
  verifier = new CredentialVerifier(runner.manager.getRepository(UserEntity));
});

afterAll(async () => {
  if (runner?.isTransactionActive) await runner.rollbackTransaction();
  if (runner) await runner.release();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('credential verification', () => {
  it('returns only the identity for the exact email and a valid password', async () => {
    expect(await verifier.verify(email, password)).toEqual({
      userId: activeUserId,
      tenantId,
      role: 'operator',
    });
  });

  it('rejects wrong passwords, unknown or differently cased emails, and inactive users', async () => {
    expect(await verifier.verify(email, 'wrong-password')).toBeNull();
    expect(await verifier.verify('missing@auth.stocksync.test', password)).toBeNull();
    expect(await verifier.verify(email.toLowerCase(), password)).toBeNull();
    expect(await verifier.verify(inactiveEmail, password)).toBeNull();
  });

  it('performs Argon2id verification for unknown and inactive accounts too', async () => {
    const verify = vi.spyOn(argon2, 'verify');
    try {
      expect(await verifier.verify('another-missing@auth.stocksync.test', password)).toBeNull();
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await verifier.verify(inactiveEmail, password)).toBeNull();
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
    }
  });
});
