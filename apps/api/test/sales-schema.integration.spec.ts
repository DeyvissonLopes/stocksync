import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseOptions } from '../src/database/database-options.js';

let db: DataSource;

beforeAll(async () => {
  db = await new DataSource(loadDatabaseOptions(process.env)).initialize();
  await db.runMigrations();
});

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
});

type Fixture = {
  tenantA: string;
  tenantB: string;
  actorA: string;
  actorB: string;
  productA: string;
  otherProductA: string;
  productB: string;
};

async function withFixture(check: (runner: QueryRunner, fixture: Fixture) => Promise<void>) {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const tenant = async () => {
      const rows: Array<{ id: string }> = await runner.query(
        'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
        [`sale-${randomUUID()}`, 'Sales Schema Test'],
      );
      return rows[0]!.id;
    };
    const tenantA = await tenant();
    const tenantB = await tenant();
    const user = async (tenantId: string) => {
      const rows: Array<{ id: string }> = await runner.query(
        `INSERT INTO users (tenant_id, email, role, password_hash)
         VALUES ($1, $2, 'operator', '$argon2id$test-hash') RETURNING id`,
        [tenantId, `${randomUUID()}@sales-schema.test`],
      );
      return rows[0]!.id;
    };
    const actorA = await user(tenantA);
    const actorB = await user(tenantB);
    const product = async (tenantId: string) => {
      const rows: Array<{ id: string }> = await runner.query(
        `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
         VALUES ($1, $2, 'Sale Product', 1290, 5) RETURNING id`,
        [tenantId, `SALE-${randomUUID()}`],
      );
      return rows[0]!.id;
    };
    const productA = await product(tenantA);
    const otherProductA = await product(tenantA);
    const productB = await product(tenantB);
    await check(runner, { tenantA, tenantB, actorA, actorB,
      productA, otherProductA, productB });
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

async function rejected(runner: QueryRunner, operation: () => Promise<unknown>) {
  await runner.query('SAVEPOINT invalid_sale');
  try {
    await expect(operation()).rejects.toThrow();
  } finally {
    await runner.query('ROLLBACK TO SAVEPOINT invalid_sale');
    await runner.query('RELEASE SAVEPOINT invalid_sale');
  }
}

function sale(runner: QueryRunner, tenantId: string, actorId: string,
  key: string, hash = 'a'.repeat(64)) {
  return runner.query(
    `INSERT INTO sales (tenant_id, user_id, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4) RETURNING id, request_hash`,
    [tenantId, actorId, key, hash],
  ) as Promise<Array<{ id: string; request_hash: string }>>;
}

function item(runner: QueryRunner, tenantId: string, saleId: string,
  productId: string, quantity = 2, unitPrice = '1290') {
  return runner.query(
    `INSERT INTO sale_items
      (tenant_id, sale_id, product_id, quantity, unit_price_cents)
     VALUES ($1, $2, $3, $4, $5) RETURNING product_id`,
    [tenantId, saleId, productId, quantity, unitPrice],
  ) as Promise<Array<{ product_id: string }>>;
}

function saleMovement(runner: QueryRunner, tenantId: string, productId: string,
  actorId: string, saleId: string | null, reason = 'sale') {
  return runner.query(
    `INSERT INTO stock_movements
      (tenant_id, product_id, user_id, sale_id, reason,
       quantity_delta, stock_before, stock_after)
     VALUES ($1, $2, $3, $4, $5, -2, 5, 3) RETURNING id`,
    [tenantId, productId, actorId, saleId, reason],
  ) as Promise<Array<{ id: string }>>;
}

describe('sales schema over PostgreSQL', () => {
  it('keeps idempotency keys unique per tenant and binds the actor to that tenant',
    async () => withFixture(async (runner, f) => {
      const key = randomUUID();
      const first = (await sale(runner, f.tenantA, f.actorA, key))[0];
      expect(first).toMatchObject({ request_hash: 'a'.repeat(64) });
      expect(first?.id).toBeDefined();
      expect((await sale(runner, f.tenantB, f.actorB, key))[0]?.id).toBeDefined();
      await rejected(runner, () => sale(runner, f.tenantA, f.actorA, key));
      await rejected(runner, () => sale(runner, f.tenantA, f.actorB, randomUUID()));
      await rejected(runner, () => sale(runner, f.tenantA, f.actorA,
        randomUUID(), 'invalid-hash'));
    }));

  it('keeps items and sale movements on the same tenant, sale and product',
    async () => withFixture(async (runner, f) => {
      const saleA = (await sale(runner, f.tenantA, f.actorA, randomUUID()))[0]!.id;
      const saleB = (await sale(runner, f.tenantB, f.actorB, randomUUID()))[0]!.id;
      expect((await item(runner, f.tenantA, saleA, f.productA))[0])
        .toEqual({ product_id: f.productA });
      expect((await item(runner, f.tenantB, saleB, f.productB))[0])
        .toEqual({ product_id: f.productB });
      await rejected(runner, () => item(runner, f.tenantA, saleA, f.productB));
      await rejected(runner, () => item(runner, f.tenantA, saleB, f.productA));
      await rejected(runner, () => item(runner, f.tenantA, saleA, f.productA));
      await rejected(runner, () => item(runner, f.tenantA, saleA,
        f.otherProductA, 0));
      await rejected(runner, () => item(runner, f.tenantA, saleA,
        f.otherProductA, 1, '-1'));

      expect((await saleMovement(runner, f.tenantA, f.productA,
        f.actorA, saleA))[0]?.id).toBeDefined();
      await rejected(runner, () => saleMovement(runner, f.tenantA,
        f.productA, f.actorA, saleA));
      await rejected(runner, () => saleMovement(runner, f.tenantA,
        f.productA, f.actorA, null));
      await rejected(runner, () => saleMovement(runner, f.tenantA,
        f.otherProductA, f.actorA, saleA));
      await rejected(runner, () => saleMovement(runner, f.tenantA,
        f.productA, f.actorA, saleB));
      await rejected(runner, () => saleMovement(runner, f.tenantA,
        f.productA, f.actorA, saleA, 'initial_stock'));
    }));
});
