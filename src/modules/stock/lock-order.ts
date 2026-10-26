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
