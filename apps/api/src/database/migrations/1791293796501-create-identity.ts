import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdentity1791293796501 implements MigrationInterface {
  name = 'CreateIdentity1791293796501';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{1,49}$'),
        CONSTRAINT tenants_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        email text NOT NULL UNIQUE,
        role text NOT NULL,
        password_hash text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator')),
        CONSTRAINT users_password_hash_check CHECK (password_hash LIKE '$argon2id$%')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE users');
    await queryRunner.query('DROP TABLE tenants');
  }
}
