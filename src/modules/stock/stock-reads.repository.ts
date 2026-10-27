import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface BalanceRow {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  packTypeId: string;
  packTypeName: string;
  unitsPerPack: number;
  quantity: number;
  updatedAt: Date;
}

export interface MovementReadRow {
  id: string;
  movementType: string;
  quantityChange: number;
  quantityAfter: number;
  occurredAt: Date;
  // occurred_at as Postgres text, for the cursor: exact to the microsecond,
  // which a JavaScript Date is not.
  occurredKey: string;
  reason: string | null;
  note: string | null;
  reference: string | null;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  locationId: string;
  packTypeId: string;
  productName: string;
  packTypeName: string;
  createdByMembershipId: string | null;
  createdByName: string | null;
  // numeric::text ("120.50"), never a number.
  unitCost: string | null;
}

// The two stock reads (docs/phase-c-design.md section 7). The one approved
// exception to "a module never reads another module's tables" (Ian, C2):
// these read-only queries join product, pack_type, location and membership
// for names and for paging by product name. They never write those tables.
// Every value is a parameter; an optional filter is a null parameter. The
// business_id filters are in addition to RLS, never instead of it.
@Injectable()
export class StockReadsRepository {
  async balances(options: {
    // Phase T2: the member's allowed locations, or null for all.
    scopeIds: string[] | null;
    locationId: string | null;
    productId: string | null;
    includeZero: boolean;
    includeArchived: boolean;
    after: { productName: string; packTypeId: string; locationId: string } | null;
    limit: number;
  }): Promise<BalanceRow[]> {
    const { scopeIds, locationId, productId, includeZero, includeArchived, after, limit } = options;
    const rows = await currentTx().$queryRaw<
      {
        location_id: string;
        location_name: string;
        product_id: string;
        product_name: string;
        pack_type_id: string;
        pack_type_name: string;
        units_per_pack: number;
        quantity: number;
        updated_at: Date;
      }[]
    >`
      SELECT b.location_id, l.name AS location_name, p.id AS product_id, p.name AS product_name,
             b.pack_type_id, pt.name AS pack_type_name, pt.units_per_pack, b.quantity, b.updated_at
        FROM stock_balance b
        JOIN pack_type pt ON pt.business_id = b.business_id AND pt.id = b.pack_type_id
        JOIN product p ON p.business_id = pt.business_id AND p.id = pt.product_id
        JOIN location l ON l.business_id = b.business_id AND l.id = b.location_id
       WHERE b.business_id = ${currentBusinessId()}::uuid
         AND (${locationId}::uuid IS NULL OR b.location_id = ${locationId}::uuid)
         AND (${scopeIds}::uuid[] IS NULL OR b.location_id = ANY(${scopeIds}::uuid[]))
         AND (${productId}::uuid IS NULL OR p.id = ${productId}::uuid)
         AND (${includeZero}::boolean OR b.quantity <> 0)
         AND (${includeArchived}::boolean OR p.archived_at IS NULL)
         AND (${after?.productName ?? null}::text IS NULL
              OR (p.name, b.pack_type_id, b.location_id)
                 > (${after?.productName ?? null}::text, ${after?.packTypeId ?? null}::uuid, ${after?.locationId ?? null}::uuid))
       ORDER BY p.name, b.pack_type_id, b.location_id
       LIMIT ${limit}::int`;
    return rows.map((r) => ({
      locationId: r.location_id,
      locationName: r.location_name,
      productId: r.product_id,
      productName: r.product_name,
      packTypeId: r.pack_type_id,
      packTypeName: r.pack_type_name,
      unitsPerPack: r.units_per_pack,
      quantity: r.quantity,
      updatedAt: r.updated_at,
    }));
  }

  /** Newest first by (occurred_at, id), on the C2 index. */
  async movements(options: {
    // Phase T2: the member's allowed locations, or null for all.
    scopeIds: string[] | null;
    locationId: string | null;
    packTypeId: string | null;
    productId: string | null;
    type: string | null;
    from: string | null;
    to: string | null;
    after: { occurredKey: string; id: string } | null;
    limit: number;
  }): Promise<MovementReadRow[]> {
    const { scopeIds, locationId, packTypeId, productId, type, from, to, after, limit } = options;
    const rows = await currentTx().$queryRaw<
      {
        id: string;
        movement_type: string;
        quantity_change: number;
        quantity_after: number;
        occurred_at: Date;
        occurred_key: string;
        reason: string | null;
        note: string | null;
        reference: string | null;
        expected_quantity: number | null;
        counted_quantity: number | null;
        location_id: string;
        pack_type_id: string;
        product_name: string;
        pack_type_name: string;
        created_by_membership_id: string | null;
        created_by_name: string | null;
        unit_cost: string | null;
      }[]
    >`
      SELECT m.id, m.movement_type, m.quantity_change, m.quantity_after, m.occurred_at,
             m.occurred_at::text AS occurred_key, m.reason, m.note, m.reference,
             m.expected_quantity, m.counted_quantity, m.location_id, m.pack_type_id,
             p.name AS product_name, pt.name AS pack_type_name,
             m.created_by_membership_id, mem.display_name AS created_by_name,
             m.unit_cost::text AS unit_cost
        FROM stock_movement m
        JOIN pack_type pt ON pt.business_id = m.business_id AND pt.id = m.pack_type_id
        JOIN product p ON p.business_id = pt.business_id AND p.id = pt.product_id
        LEFT JOIN membership mem ON mem.business_id = m.business_id AND mem.id = m.created_by_membership_id
       WHERE m.business_id = ${currentBusinessId()}::uuid
         AND (${locationId}::uuid IS NULL OR m.location_id = ${locationId}::uuid)
         AND (${scopeIds}::uuid[] IS NULL OR m.location_id = ANY(${scopeIds}::uuid[]))
         AND (${packTypeId}::uuid IS NULL OR m.pack_type_id = ${packTypeId}::uuid)
         AND (${productId}::uuid IS NULL OR p.id = ${productId}::uuid)
         AND (${type}::text IS NULL OR m.movement_type = ${type}::text)
         AND (${from}::timestamptz IS NULL OR m.occurred_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR m.occurred_at < ${to}::timestamptz)
         AND (${after?.occurredKey ?? null}::timestamptz IS NULL
              OR (m.occurred_at, m.id) < (${after?.occurredKey ?? null}::timestamptz, ${after?.id ?? null}::uuid))
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT ${limit}::int`;
    return rows.map((r) => ({
      id: r.id,
      movementType: r.movement_type,
      quantityChange: r.quantity_change,
      quantityAfter: r.quantity_after,
      occurredAt: r.occurred_at,
      occurredKey: r.occurred_key,
      reason: r.reason,
      note: r.note,
      reference: r.reference,
      expectedQuantity: r.expected_quantity,
      countedQuantity: r.counted_quantity,
      locationId: r.location_id,
      packTypeId: r.pack_type_id,
      productName: r.product_name,
      packTypeName: r.pack_type_name,
      createdByMembershipId: r.created_by_membership_id,
      createdByName: r.created_by_name,
      unitCost: r.unit_cost,
    }));
  }
}
