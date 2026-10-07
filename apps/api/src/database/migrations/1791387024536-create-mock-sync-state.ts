import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMockSyncState1791387024536 implements MigrationInterface {
  name = 'CreateMockSyncState1791387024536';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE SCHEMA mock_sync');
    await queryRunner.query(`
      CREATE TABLE mock_sync.products (
        tenant_id uuid NOT NULL,
        product_id uuid NOT NULL,
        sku text NOT NULL,
        stock integer NOT NULL,
        price_cents bigint NOT NULL,
        version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mock_sync_products_pk PRIMARY KEY (tenant_id, product_id),
        CONSTRAINT mock_sync_products_stock_nonnegative CHECK (stock >= 0),
        CONSTRAINT mock_sync_products_price_nonnegative CHECK (price_cents >= 0),
        CONSTRAINT mock_sync_products_version_positive CHECK (version > 0)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE mock_sync.products');
    await queryRunner.query('DROP SCHEMA mock_sync');
  }
}
