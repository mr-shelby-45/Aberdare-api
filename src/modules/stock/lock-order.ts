/**
 * Lines in the lock order of every multi-balance operation: larger pack
 * first, then by pack type id (docs/architecture.md section 6). Stock
 * commands (Phase C) and sales (Phase E) use it, so two operations on the
 * same pools can never lock them in opposite orders. Equal keys keep their
 * order (two sale lines of one pack type are both applied).
 */
export function inLockOrder<T extends { pack_type_id: string }>(lines: T[], packs: ReadonlyMap<string, { unitsPerPack: number }>): T[] {
  return [...lines].sort((a, b) => {
    const byUnits = packs.get(b.pack_type_id)!.unitsPerPack - packs.get(a.pack_type_id)!.unitsPerPack;
    if (byUnits !== 0) return byUnits;
    return a.pack_type_id < b.pack_type_id ? -1 : a.pack_type_id > b.pack_type_id ? 1 : 0;
  });
}

/**
 * Phase T3: the global lock order of a statement on several locations (a
 * transfer): by location id, then the shared pack order inside a location
 * (larger units_per_pack first, then pack type id). An issue from S to V and
 * a return from V to S lock the same pools in the same order, so they cannot
 * deadlock each other; within one location it matches sales, counts and
 * conversions.
 */
export function inTransferLockOrder<T extends { locationId: string; packTypeId: string; unitsPerPack: number }>(steps: T[]): T[] {
  return [...steps].sort((a, b) => {
    if (a.locationId !== b.locationId) return a.locationId < b.locationId ? -1 : 1;
    if (a.unitsPerPack !== b.unitsPerPack) return b.unitsPerPack - a.unitsPerPack;
    return a.packTypeId < b.packTypeId ? -1 : a.packTypeId > b.packTypeId ? 1 : 0;
  });
}
