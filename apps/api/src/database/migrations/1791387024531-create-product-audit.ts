import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductAudit1791387024531 implements MigrationInterface {
  name = 'CreateProductAudit1791387024531';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD CONSTRAINT products_tenant_id_id_unique UNIQUE (tenant_id, id)
    `);
    await queryRunner.query(`
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        product_id uuid NOT NULL,
        user_id uuid NOT NULL,
        reason text NOT NULL,
        quantity_delta integer NOT NULL,
        stock_before integer NOT NULL,
        stock_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stock_movements_product_tenant_fk
          FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT stock_movements_actor_tenant_fk
          FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT stock_movements_reason_check
          CHECK (reason IN ('seed_baseline', 'initial_stock', 'manual_adjustment', 'sale')),
        CONSTRAINT stock_movements_quantity_check CHECK (quantity_delta <> 0),
        CONSTRAINT stock_movements_balance_check
          CHECK (stock_before >= 0 AND stock_after >= 0 AND
            stock_before::bigint + quantity_delta::bigint = stock_after::bigint)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX stock_movements_seed_baseline_unique
      ON stock_movements (tenant_id, product_id) WHERE reason = 'seed_baseline'
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        product_id uuid NOT NULL,
        product_version bigint NOT NULL,
        sku text NOT NULL,
        stock integer NOT NULL,
        price_cents bigint NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT outbox_events_product_tenant_fk
          FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT outbox_events_product_version_unique
          UNIQUE (tenant_id, product_id, product_version),
        CONSTRAINT outbox_events_version_positive CHECK (product_version > 0),
        CONSTRAINT outbox_events_stock_nonnegative CHECK (stock >= 0),
        CONSTRAINT outbox_events_price_nonnegative CHECK (price_cents >= 0),
        CONSTRAINT outbox_events_status_check
          CHECK (status IN ('pending', 'sent', 'failed'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_events');
    await queryRunner.query('DROP TABLE stock_movements');
    await queryRunner.query('ALTER TABLE products DROP CONSTRAINT products_tenant_id_id_unique');
  }
}
