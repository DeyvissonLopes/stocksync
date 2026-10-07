import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProducts1791377340000 implements MigrationInterface {
  name = 'CreateProducts1791377340000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        sku text NOT NULL,
        name text NOT NULL,
        price_cents bigint NOT NULL,
        stock integer NOT NULL,
        version bigint NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        deleted_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT products_tenant_sku_unique UNIQUE (tenant_id, sku),
        CONSTRAINT products_price_nonnegative CHECK (price_cents >= 0),
        CONSTRAINT products_stock_nonnegative CHECK (stock >= 0),
        CONSTRAINT products_version_positive CHECK (version > 0),
        CONSTRAINT products_archive_actor_check
          CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
        CONSTRAINT products_deleted_by_tenant_fk
          FOREIGN KEY (tenant_id, deleted_by) REFERENCES users(tenant_id, id)
          ON DELETE RESTRICT
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE products');
  }
}
