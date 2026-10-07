import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSalesSchema1791387024534 implements MigrationInterface {
  name = 'CreateSalesSchema1791387024534';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sales (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        user_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        request_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sales_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT sales_tenant_idempotency_key_unique UNIQUE (tenant_id, idempotency_key),
        CONSTRAINT sales_actor_tenant_fk
          FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sales_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sale_items (
        tenant_id uuid NOT NULL,
        sale_id uuid NOT NULL,
        product_id uuid NOT NULL,
        quantity integer NOT NULL,
        unit_price_cents bigint NOT NULL,
        CONSTRAINT sale_items_pk PRIMARY KEY (tenant_id, sale_id, product_id),
        CONSTRAINT sale_items_sale_tenant_fk
          FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sale_items_product_tenant_fk
          FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sale_items_quantity_check CHECK (quantity > 0),
        CONSTRAINT sale_items_price_check CHECK (unit_price_cents >= 0)
      )
    `);
    await queryRunner.query('ALTER TABLE stock_movements ADD COLUMN sale_id uuid');
    await queryRunner.query(`
      ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_sale_reason_check
      CHECK ((reason = 'sale') = (sale_id IS NOT NULL))
    `);
    await queryRunner.query(`
      ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_sale_item_fk
      FOREIGN KEY (tenant_id, sale_id, product_id)
      REFERENCES sale_items(tenant_id, sale_id, product_id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX stock_movements_sale_item_unique
      ON stock_movements (tenant_id, sale_id, product_id)
      WHERE sale_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX stock_movements_sale_item_unique');
    await queryRunner.query('ALTER TABLE stock_movements DROP COLUMN sale_id');
    await queryRunner.query('DROP TABLE sale_items');
    await queryRunner.query('DROP TABLE sales');
  }
}
