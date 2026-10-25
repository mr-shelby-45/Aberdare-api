// How a product leaves the API (docs/phase-b-design.md section 6). Built by
// ProductsService for by-barcode (B3) and, later, by-id, list and search (B4).
// Prices are canonical strings with two decimals.

export interface ProductView {
  id: string;
  name: string;
  sku: string | null;
  archived: boolean;
  packTypes: {
    id: string;
    name: string;
    unitsPerPack: number;
    sellPrice: string;
    costPrice: string | null;
    archived: boolean;
  }[];
  barcodes: { barcode: string; packTypeId: string }[];
}

/**
 * The JSON shape. The cost_price key is left out entirely (not null) unless
 * the caller has costs.view: an absent key says "not yours to see", while
 * null would say "not set".
 */
export function productJson(p: ProductView, canSeeCosts: boolean) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    archived: p.archived,
    pack_types: p.packTypes.map((t) => ({
      id: t.id,
      name: t.name,
      units_per_pack: t.unitsPerPack,
      sell_price: t.sellPrice,
      ...(canSeeCosts ? { cost_price: t.costPrice } : {}),
      archived: t.archived,
    })),
    barcodes: p.barcodes.map((b) => ({ barcode: b.barcode, pack_type_id: b.packTypeId })),
  };
}
