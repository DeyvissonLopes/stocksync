import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexStockMovementHistory1791387024533 implements MigrationInterface {
  name = 'IndexStockMovementHistory1791387024533';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX stock_movements_history_idx
      ON stock_movements (tenant_id, product_id, created_at DESC, id DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX stock_movements_history_idx');
  }
}
