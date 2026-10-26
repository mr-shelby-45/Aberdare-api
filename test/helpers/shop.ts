import { randomInt } from 'node:crypto';
import { type TenantRunner, currentTx } from '../../src/database/tenant.js';
import { asAdmin, createBusiness } from './db.js';

export interface Shop {
  biz: string;
  loc: string;
  piece: string;
  carton: string;
  // A manager of this business (Phase C1: movements and conversions name a
  // real member; a manager, so tests may still add their own owner).
  member: string;
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
  // A person can only be written as the superuser (identity path, Phase A).
  const phone = `+2547${String(randomInt(10_000_000, 99_999_999))}`;
  const personId = await asAdmin(
    async (c) => (await c.query<{ id: string }>('INSERT INTO person (phone) VALUES ($1) RETURNING id', [phone])).rows[0].id,
  );
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
    const member = await tx.membership.create({
      data: { businessId: biz, personId, displayName: 'Manager', rolePreset: 'MANAGER', status: 'ACTIVE' },
      select: { id: true },
    });
    return { biz, loc: loc.id, piece: piece.id, carton: carton.id, member: member.id };
  });
}
