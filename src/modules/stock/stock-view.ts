import type { BalanceRow, MovementReadRow } from './stock-reads.repository.js';

// How stock leaves the API (docs/phase-c-design.md section 7). Times are UTC
// ISO strings; quantities are whole numbers.

export function balanceJson(b: BalanceRow) {
  return {
    location_id: b.locationId,
    location_name: b.locationName,
    product_id: b.productId,
    product_name: b.productName,
    pack_type_id: b.packTypeId,
    pack_type_name: b.packTypeName,
    units_per_pack: b.unitsPerPack,
    quantity: b.quantity,
    updated_at: b.updatedAt.toISOString(),
  };
}

/**
 * The unit_cost key is left out entirely (not null) unless the caller has
 * costs.view, as for cost_price in Phase B.
 */
export function movementJson(m: MovementReadRow, canSeeCosts: boolean) {
  return {
    id: m.id,
    movement_type: m.movementType,
    quantity_change: m.quantityChange,
    quantity_after: m.quantityAfter,
    occurred_at: m.occurredAt.toISOString(),
    reason: m.reason,
    note: m.note,
    reference: m.reference,
    expected_quantity: m.expectedQuantity,
    counted_quantity: m.countedQuantity,
    location_id: m.locationId,
    pack_type_id: m.packTypeId,
    product_name: m.productName,
    pack_type_name: m.packTypeName,
    created_by: m.createdByMembershipId
      ? { membership_id: m.createdByMembershipId, display_name: m.createdByName }
      : null,
    ...(canSeeCosts ? { unit_cost: m.unitCost } : {}),
  };
}
