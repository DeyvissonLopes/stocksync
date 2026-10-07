import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStockMovementNote1791387024532 implements MigrationInterface {
  name = 'AddStockMovementNote1791387024532';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE stock_movements ADD COLUMN note text');
    await queryRunner.query(`
      ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_note_check CHECK (
        (reason = 'manual_adjustment' AND note IS NOT NULL AND
          length(note) BETWEEN 1 AND 500 AND note ~ '[^[:space:]]') OR
        (reason <> 'manual_adjustment' AND note IS NULL)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_note_check');
    await queryRunner.query('ALTER TABLE stock_movements DROP COLUMN note');
  }
}
