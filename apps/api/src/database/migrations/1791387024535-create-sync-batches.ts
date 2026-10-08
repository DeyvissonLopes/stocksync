import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSyncBatches1791387024535 implements MigrationInterface {
  name = 'CreateSyncBatches1791387024535';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'pending',
        attempts_started integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        queued_at timestamptz,
        sent_at timestamptz,
        failed_at timestamptz,
        CONSTRAINT sync_batches_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT sync_batches_status_check
          CHECK (status IN ('pending', 'queued', 'sent', 'failed')),
        CONSTRAINT sync_batches_attempts_nonnegative CHECK (attempts_started >= 0)
      )
    `);
    await queryRunner.query('ALTER TABLE outbox_events ADD COLUMN batch_id uuid');
    await queryRunner.query(`
      ALTER TABLE outbox_events
      ADD CONSTRAINT outbox_events_batch_tenant_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES sync_batches(tenant_id, id)
      ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_events_unbatched_idx
      ON outbox_events (tenant_id, created_at, id)
      WHERE status = 'pending' AND batch_id IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_events_batch_idx
      ON outbox_events (tenant_id, batch_id, id)
      WHERE batch_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX outbox_events_batch_idx');
    await queryRunner.query('DROP INDEX outbox_events_unbatched_idx');
    await queryRunner.query('ALTER TABLE outbox_events DROP COLUMN batch_id');
    await queryRunner.query('DROP TABLE sync_batches');
  }
}
