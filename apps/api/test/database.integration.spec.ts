import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('application database', () => {
  it('connects to the dedicated test database and closes its pool', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    let dataSource: DataSource | undefined;
    try {
      const connection = module.get(DataSource);
      dataSource = connection;
      expect(connection.isInitialized).toBe(true);
      expect(connection.options.synchronize).toBe(false);
      expect(connection.options.migrationsRun).toBe(false);
      const rows: Array<{ database: string }> = await connection.query(
        'SELECT current_database() AS database',
      );
      expect(rows).toEqual([{ database: process.env.TEST_DB_NAME }]);
    } finally {
      await module.close();
    }
    expect(dataSource?.isInitialized).toBe(false);
  });
});
