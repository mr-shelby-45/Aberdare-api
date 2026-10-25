import { type TenantRunner, currentTx } from '../../src/database/tenant.js';
import { createBusiness } from './db.js';

export interface Shop {
  biz: string;
  loc: string;
  piece: string;
  carton: string;
}

/**
 * A business with one location and a product sold as pieces and cartons of
 * 24. Created the real way: as app_user, inside a tenant transaction.
 */
export async function seedShop(
  tenants: TenantRunner,
  name = 'Shop A',
): Promise<Shop> {
  const biz = await createBusiness(name);
  return tenants.run(biz, async () => {
    const tx = currentTx();
    const loc = await tx.location.create({
      data: { businessId: biz, name: 'Main shop' },
    });
    const product = await tx.product.create({
      data: { businessId: biz, name: 'Soda 300ml' },
    });
    const piece = await tx.packType.create({
      data: {
        businessId: biz,
        productId: product.id,
        name: 'piece',
        unitsPerPack: 1,
        sellPrice: '50.00',
      },
    });
    const carton = await tx.packType.create({
      data: {
        businessId: biz,
        productId: product.id,
        name: 'carton of 24',
        unitsPerPack: 24,
        sellPrice: '1100.00',
      },
    });
    return { biz, loc: loc.id, piece: piece.id, carton: carton.id };
  });
}
