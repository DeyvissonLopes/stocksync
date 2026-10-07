import type { EntityManager } from 'typeorm';
import type { Seeder } from './database-seeder.js';

const demoProducts = [
  {
    tenantSlug: 'alpha',
    products: [
      { sku: 'DEMO-CAN', name: 'Blue Mug', priceCents: 2990, stock: 12 },
      { sku: 'DEMO-NOTE', name: 'A5 Notebook', priceCents: 1590, stock: 8 },
      { sku: 'DEMO-PEN', name: 'Black Pen', priceCents: 490, stock: 0 },
    ],
  },
  {
    tenantSlug: 'beta',
    products: [
      { sku: 'DEMO-BAG', name: 'Tote Bag', priceCents: 2490, stock: 7 },
      { sku: 'DEMO-CAN', name: 'Red Mug', priceCents: 3190, stock: 5 },
      { sku: 'DEMO-PEN', name: 'Blue Pen', priceCents: 550, stock: 0 },
    ],
  },
] as const;

export class ProductSeeder implements Seeder {
  async run(manager: EntityManager): Promise<void> {
    for (const tenant of demoProducts) {
      const tenantRows: Array<{ id: string }> = await manager.query(
        'SELECT id FROM tenants WHERE slug = $1',
        [tenant.tenantSlug],
      );
      const tenantId = tenantRows[0]?.id;
      if (!tenantId) throw new Error('Seed tenant could not be resolved');

      for (const product of tenant.products) {
        await manager.query(
          `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, sku) DO NOTHING`,
          [tenantId, product.sku, product.name, product.priceCents, product.stock],
        );
      }
    }
  }
}
