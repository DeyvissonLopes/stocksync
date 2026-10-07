import type { EntityManager } from 'typeorm';
import { IdentitySeeder } from './identity-seeder.js';

export interface Seeder {
  run(manager: EntityManager): Promise<void>;
}

export class DatabaseSeeder {
  constructor(
    private readonly manager: EntityManager,
    private readonly seeders: readonly Seeder[] = [new IdentitySeeder()],
  ) {}

  async run(): Promise<void> {
    await this.manager.transaction(async (manager) => {
      for (const seeder of this.seeders) {
        await seeder.run(manager);
      }
    });
  }
}
