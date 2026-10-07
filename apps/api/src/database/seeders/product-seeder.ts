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
      const adminRows: Array<{ id: string }> = await manager.query(
        'SELECT id FROM users WHERE tenant_id = $1 AND email = $2 AND role = $3',
        [tenantId, `admin@${tenant.tenantSlug}.stocksync.test`, 'admin'],
      );
      const adminId = adminRows[0]?.id;
      if (!adminId) throw new Error('Seed admin could not be resolved');

      for (const product of tenant.products) {
        await manager.query(
          `INSERT INTO products (tenant_id, sku, name, price_cents, stock)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, sku) DO NOTHING`,
          [tenantId, product.sku, product.name, product.priceCents, product.stock],
        );
        const productRows: Array<{ id: string; stock: number }> = await manager.query(
          'SELECT id, stock FROM products WHERE tenant_id = $1 AND sku = $2',
          [tenantId, product.sku],
        );
        const current = productRows[0];
        if (!current) throw new Error('Seed product could not be resolved');

        if (current.stock > 0) {
          await manager.query(
            `INSERT INTO stock_movements
              (tenant_id, product_id, user_id, reason, quantity_delta, stock_before, stock_after)
             SELECT $1, $2, $3, 'seed_baseline', $4, 0, $4
             WHERE NOT EXISTS (
               SELECT 1 FROM stock_movements WHERE tenant_id = $1 AND product_id = $2
             ) ON CONFLICT DO NOTHING`,
            [tenantId, current.id, adminId, current.stock],
          );
        }

        await manager.query(
          `INSERT INTO outbox_events
            (tenant_id, product_id, product_version, sku, stock, price_cents)
           SELECT p.tenant_id, p.id, p.version, p.sku,
                  CASE WHEN p.deleted_at IS NULL THEN p.stock ELSE 0 END,
                  p.price_cents
           FROM products p
           WHERE p.tenant_id = $1 AND p.id = $2
             AND NOT EXISTS (
               SELECT 1 FROM outbox_events e
               WHERE e.tenant_id = p.tenant_id AND e.product_id = p.id
             ) ON CONFLICT DO NOTHING`,
          [tenantId, current.id],
        );
      }
    }
  }
}
