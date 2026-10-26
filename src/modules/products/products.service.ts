import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { normalizeMoney } from '../../common/validation/money.js';
import { Clock } from '../../common/time/clock.js';
import { uniqueViolationConstraint } from '../../database/db-errors.js';
import { type AuditMetadata, AuditService } from '../audit/audit.service.js';
import { StockService } from '../stock/stock.service.js';
import { normalizeBarcode } from './barcode.js';
import { BarcodesRepository } from './barcodes.repository.js';
import { CatalogueError } from './catalogue.error.js';
import type { AddBarcodeDto } from './dto/add-barcode.dto.js';
import type { CreateProductDto } from './dto/create-product.dto.js';
import type { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import type { RemoveBarcodeDto } from './dto/remove-barcode.dto.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';
import type { UpsertPackTypeDto } from './dto/upsert-pack-type.dto.js';
import { type PackTypeRow, PackTypesRepository } from './pack-types.repository.js';
import type { ProductView } from './product-view.js';
import { ProductsRepository } from './products.repository.js';

// Catalogue rules (docs/phase-b-design.md section 4).
const MAX_PACK_TYPES = 6; // active pack types per product (decided in B2)
const PRODUCT_NAME_MAX = 120;
const PACK_NAME_MAX = 40;
const SKU_MAX = 64;
// Reads (docs/phase-b-design.md section 6).
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SEARCH_MIN = 2;
const SEARCH_MAX = 100;
const PRODUCT_CURSOR = 'products';
// Control characters, NUL included: Postgres text cannot hold a NUL, so it
// would otherwise become a 500.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The catalogue commands' rules. Every method runs inside the command's
// tenant transaction (a savepoint of it); a CatalogueError or a database
// conflict undoes all of the command's writes. Rules are checked here first
// so the reason is clear; the database constraints are the backstop and are
// mapped to the same reasons by constraint name.
@Injectable()
export class ProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly packTypes: PackTypesRepository,
    private readonly barcodes: BarcodesRepository,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly cursor: SignedCursor,
  ) {}

  /** product.create: the product, its pack types and its barcodes, or nothing. */
  async createProduct(dto: CreateProductDto, actorMembershipId: string): Promise<void> {
    const name = text(dto.name, PRODUCT_NAME_MAX, 'name');
    const sku = dto.sku === undefined || dto.sku === null ? null : text(dto.sku, SKU_MAX, 'sku');

    if (dto.pack_types.length > MAX_PACK_TYPES) {
      throw new CatalogueError('PACK_LIMIT_REACHED', `A product has at most ${MAX_PACK_TYPES} pack types.`);
    }
    const packs = dto.pack_types.map((p) => ({
      id: p.pack_type_id,
      name: text(p.name, PACK_NAME_MAX, 'pack type name'),
      unitsPerPack: p.units_per_pack,
      sellPrice: normalizeMoney(p.sell_price),
      costPrice: p.cost_price === undefined || p.cost_price === null ? null : normalizeMoney(p.cost_price),
    }));
    if (new Set(packs.map((p) => p.id)).size !== packs.length) {
      throw invalid('Each pack type needs its own id.');
    }
    if (packs.filter((p) => p.unitsPerPack === 1).length > 1) {
      throw baseUnitDuplicate();
    }
    if (new Set(packs.map((p) => p.unitsPerPack)).size !== packs.length) {
      throw unitsDuplicate();
    }
    if (new Set(packs.map((p) => p.name)).size !== packs.length) {
      throw nameDuplicate();
    }
    const packIds = new Set(packs.map((p) => p.id));
    const barcodes = (dto.barcodes ?? []).map((b) => {
      const code = normalizeBarcode(b.barcode);
      if (!code) throw invalid('A barcode is not valid.');
      if (!packIds.has(b.pack_type_id)) {
        throw new CatalogueError('PACK_TYPE_NOT_FOUND', 'A barcode refers to a pack type that is not in this product.');
      }
      return { barcode: code, packTypeId: b.pack_type_id };
    });
    if (new Set(barcodes.map((b) => b.barcode)).size !== barcodes.length) {
      throw invalid('The same barcode is listed twice.');
    }

    await mapConflicts(() => this.products.insert({ id: dto.product_id, name, sku }));
    for (const p of packs) {
      await mapConflicts(() => this.packTypes.insert({ ...p, productId: dto.product_id }), p.unitsPerPack);
    }
    for (const b of barcodes) {
      await mapConflicts(() =>
        this.barcodes.insert({ ...b, productId: dto.product_id, createdByMembershipId: actorMembershipId }),
      );
    }

    await this.audit.record({
      action: 'product.created',
      targetType: 'product',
      targetId: dto.product_id,
      metadata: { name, sku },
      actorMembershipId,
    });
    for (const p of packs) {
      await this.audit.record({
        action: 'pack_type.created',
        targetType: 'pack_type',
        targetId: p.id,
        metadata: packMetadata(dto.product_id, p),
        actorMembershipId,
      });
    }
    for (const b of barcodes) {
      await this.audit.record({
        action: 'barcode.added',
        targetType: 'product',
        targetId: dto.product_id,
        metadata: { barcode: b.barcode, pack_type_id: b.packTypeId },
        actorMembershipId,
      });
    }
  }

  /** product.update: name, SKU and archived, each only when sent. */
  async updateProduct(dto: UpdateProductDto, actorMembershipId: string): Promise<void> {
    if (dto.name === undefined && dto.sku === undefined && dto.archived === undefined) {
      throw invalid('Send at least one of name, sku or archived.');
    }
    const product = await this.products.lock(dto.product_id);
    if (!product) throw productNotFound();

    const name = dto.name === undefined ? product.name : text(dto.name, PRODUCT_NAME_MAX, 'name');
    const sku = dto.sku === undefined ? product.sku : dto.sku === null ? null : text(dto.sku, SKU_MAX, 'sku');
    const wasArchived = product.archivedAt !== null;
    const archive = dto.archived === true && !wasArchived;
    const restore = dto.archived === false && wasArchived;

    const changed: string[] = [];
    const metadata: AuditMetadata = {};
    if (name !== product.name) {
      changed.push('name');
      metadata.name_before = product.name;
      metadata.name_after = name;
    }
    if (sku !== product.sku) {
      changed.push('sku');
      metadata.sku_before = product.sku;
      metadata.sku_after = sku;
    }
    if (changed.length === 0 && !archive && !restore) return; // nothing to do: accepted as is

    await mapConflicts(() =>
      this.products.update(product.id, {
        ...(changed.includes('name') ? { name } : {}),
        ...(changed.includes('sku') ? { sku } : {}),
        ...(archive ? { archivedAt: this.clock.now() } : {}),
        ...(restore ? { archivedAt: null } : {}),
      }),
    );
    if (changed.length > 0) {
      await this.audit.record({
        action: 'product.updated',
        targetType: 'product',
        targetId: product.id,
        metadata: { changed, ...metadata },
        actorMembershipId,
      });
    }
    if (archive || restore) {
      // Archiving leaves the barcodes in place, so their codes stay reserved.
      await this.audit.record({
        action: archive ? 'product.archived' : 'product.restored',
        targetType: 'product',
        targetId: product.id,
        actorMembershipId,
      });
    }
  }

  /** pack_type.upsert: create the pack type, or change it. */
  async upsertPackType(dto: UpsertPackTypeDto, actorMembershipId: string): Promise<void> {
    // The product lock first: commands on one product run one at a time.
    const product = await this.products.lock(dto.product_id);
    if (!product) throw productNotFound();

    const wanted = {
      name: text(dto.name, PACK_NAME_MAX, 'pack type name'),
      unitsPerPack: dto.units_per_pack,
      sellPrice: normalizeMoney(dto.sell_price),
    };
    const existing = await this.packTypes.lock(dto.pack_type_id);

    if (!existing) {
      const archived = dto.archived === true;
      if (!archived && (await this.packTypes.countActive(product.id)) >= MAX_PACK_TYPES) {
        throw packLimit();
      }
      const costPrice = dto.cost_price === undefined || dto.cost_price === null ? null : normalizeMoney(dto.cost_price);
      await mapConflicts(
        () =>
          this.packTypes.insert({
            id: dto.pack_type_id,
            productId: product.id,
            ...wanted,
            costPrice,
            archivedAt: archived ? this.clock.now() : null,
          }),
        wanted.unitsPerPack,
      );
      await this.audit.record({
        action: 'pack_type.created',
        targetType: 'pack_type',
        targetId: dto.pack_type_id,
        metadata: { ...packMetadata(product.id, { ...wanted, costPrice }), archived },
        actorMembershipId,
      });
      return;
    }

    // A pack type never moves to another product.
    if (existing.productId !== product.id) throw packTypeNotFound();
    await this.changePackType(existing, dto, wanted, actorMembershipId);
  }

  /**
   * barcode.add: one code to one pack type. The same code on the same pack
   * type again is an accepted no-op; anywhere else it is BARCODE_TAKEN.
   * Allowed on an archived product or pack type (decided in B3).
   */
  async addBarcode(dto: AddBarcodeDto, actorMembershipId: string): Promise<void> {
    const code = normalizeBarcode(dto.barcode);
    if (!code) throw invalid('The barcode is not valid.');
    const product = await this.products.lock(dto.product_id);
    if (!product) throw productNotFound();
    const pack = await this.packTypes.lock(dto.pack_type_id);
    if (!pack || pack.productId !== product.id) throw packTypeNotFound();

    const stored = await this.barcodes.insertIfAbsent({
      barcode: code,
      productId: product.id,
      packTypeId: pack.id,
      createdByMembershipId: actorMembershipId,
    });
    if (!stored) {
      // A new statement, so it sees the row that won (even a concurrent one).
      const existing = await this.barcodes.findByCode(code);
      if (existing && existing.packTypeId === pack.id) return;
      throw barcodeTaken();
    }
    await this.audit.record({
      action: 'barcode.added',
      targetType: 'product',
      targetId: product.id,
      metadata: { barcode: code, pack_type_id: pack.id },
      actorMembershipId,
    });
  }

  /** barcode.remove: removing a code that is not there is an accepted no-op. */
  async removeBarcode(dto: RemoveBarcodeDto, actorMembershipId: string): Promise<void> {
    const code = normalizeBarcode(dto.barcode);
    if (!code) throw invalid('The barcode is not valid.');
    // The change_log trigger records the delete, with the code in row_key.
    const removed = await this.barcodes.remove(code);
    if (!removed) return;
    await this.audit.record({
      action: 'barcode.removed',
      targetType: 'product',
      targetId: removed.productId,
      metadata: { barcode: removed.barcode, pack_type_id: removed.packTypeId },
      actorMembershipId,
    });
  }

  /**
   * GET /products/by-barcode/:code: the product and the exact pack type the
   * code belongs to. Unknown, malformed and another business's codes all get
   * the same 404 (decided in B3).
   */
  async findByBarcode(raw: string): Promise<{ packTypeId: string; product: ProductView }> {
    const code = normalizeBarcode(raw);
    const found = code ? await this.barcodes.findByCode(code) : null;
    const [product] = found ? await this.views([found.productId]) : [];
    if (!found || !product) throw new ApiError(404, 'BARCODE_NOT_FOUND', 'No product has this barcode.');
    return { packTypeId: found.packTypeId, product };
  }

  /**
   * For the stock commands (Phase C2): which of these pack types exist in
   * this business, and whether each can take new stock. A pack type counts as
   * archived when it or its product is archived (decided in C2). Ids of
   * another business are simply missing, like ids that do not exist.
   */
  async packTypesForStock(ids: string[]): Promise<Map<string, { productId: string; unitsPerPack: number; archived: boolean }>> {
    const rows = await this.packTypes.stockStatus(ids);
    return new Map(rows.map((r) => [r.id, { productId: r.productId, unitsPerPack: r.unitsPerPack, archived: r.archived }]));
  }

  /** GET /products/:id. Another business's id, a missing one and a non-UUID: the same 404. */
  async findById(id: string): Promise<ProductView> {
    const [product] = UUID.test(id) ? await this.views([id]) : [];
    if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    return product;
  }

  /**
   * GET /products: a search when q is given (no paging, at most 50), otherwise
   * a keyset-paged listing in name order with a signed cursor.
   */
  async listOrSearch(query: ListProductsQueryDto): Promise<{ products: ProductView[]; nextCursor?: string | null }> {
    const includeArchived = query.include_archived === 'true';
    const limit = pageLimit(query.limit);

    if (query.q !== undefined) {
      if (query.cursor !== undefined) throw readInvalid('A search has no pages; leave out cursor.');
      const text = query.q.trim();
      if (text.length < SEARCH_MIN || text.length > SEARCH_MAX || CONTROL_CHARS.test(text)) {
        throw readInvalid(`Search for ${SEARCH_MIN} to ${SEARCH_MAX} characters.`);
      }
      const escaped = escapeLike(text);
      const ids = await this.products.search({
        text,
        barcode: normalizeBarcode(text),
        contains: `%${escaped}%`,
        prefix: `${escaped}%`,
        includeArchived,
        limit,
      });
      return { products: await this.views(ids) };
    }

    const after = query.cursor === undefined ? null : this.readCursor(query.cursor, includeArchived);
    if (query.cursor !== undefined && !after) throw readInvalid('The cursor is not valid.');
    // One row more than asked tells whether there is a next page.
    const rows = await this.products.page({ includeArchived, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      products: await this.views(page.map((r) => r.id)),
      nextCursor:
        rows.length > limit && last
          ? this.cursor.sign(PRODUCT_CURSOR, { name: last.name, id: last.id, include_archived: includeArchived })
          : null,
    };
  }

  /** The last row's name and id, if the cursor is genuine and was issued for this include_archived. */
  private readCursor(raw: string, includeArchived: boolean): { name: string; id: string } | null {
    const v = this.cursor.read(PRODUCT_CURSOR, raw);
    const id = cursorUuid(v?.id);
    if (!v || typeof v.name !== 'string' || !id || v.include_archived !== includeArchived) return null;
    return { name: v.name, id };
  }

  /**
   * Full products for reads, in the order of ids; ids not visible to this
   * tenant are left out. Three queries for any number of products, one at a
   * time (queries on one transaction cannot run in parallel).
   */
  private async views(ids: string[]): Promise<ProductView[]> {
    const products = await this.products.findManyByIds(ids);
    const visible = products.map((p) => p.id);
    const packTypes = await this.packTypes.listForProducts(visible);
    const barcodes = await this.barcodes.listForProducts(visible);
    const byId = new Map(products.map((p) => [p.id, p]));
    return ids.flatMap((id) => {
      const product = byId.get(id);
      if (!product) return [];
      return [
        {
          id: product.id,
          name: product.name,
          sku: product.sku,
          archived: product.archivedAt !== null,
          packTypes: packTypes
            .filter((t) => t.productId === id)
            .map((t) => ({
              id: t.id,
              name: t.name,
              unitsPerPack: t.unitsPerPack,
              sellPrice: t.sellPrice,
              costPrice: t.costPrice,
              archived: t.archivedAt !== null,
            })),
          barcodes: barcodes.filter((b) => b.productId === id).map((b) => ({ barcode: b.barcode, packTypeId: b.packTypeId })),
        },
      ];
    });
  }

  private async changePackType(
    existing: PackTypeRow,
    dto: UpsertPackTypeDto,
    wanted: { name: string; unitsPerPack: number; sellPrice: string },
    actorMembershipId: string,
  ): Promise<void> {
    const costPrice =
      dto.cost_price === undefined ? existing.costPrice : dto.cost_price === null ? null : normalizeMoney(dto.cost_price);
    const wasArchived = existing.archivedAt !== null;
    const archived = dto.archived ?? wasArchived;

    const before: AuditMetadata = {};
    const after: AuditMetadata = {};
    const note = (field: string, from: string | number | boolean | null, to: string | number | boolean | null) => {
      if (from !== to) {
        before[`${field}_before`] = from;
        after[`${field}_after`] = to;
      }
    };
    note('name', existing.name, wanted.name);
    note('units_per_pack', existing.unitsPerPack, wanted.unitsPerPack);
    note('sell_price', existing.sellPrice, wanted.sellPrice);
    note('cost_price', existing.costPrice, costPrice);
    note('archived', wasArchived, archived);
    if (Object.keys(after).length === 0) return; // nothing to do: accepted as is

    if (wanted.unitsPerPack !== existing.unitsPerPack && (await this.stock.hasMovements(existing.id))) {
      throw new CatalogueError(
        'UNITS_LOCKED',
        'Stock has already moved for this pack type, so its units cannot change. Create a new pack type instead.',
      );
    }
    if (archived && !wasArchived && (await this.packTypes.countActive(existing.productId, existing.id)) === 0) {
      throw new CatalogueError('LAST_ACTIVE_PACK', 'A product needs at least one active pack type.');
    }
    if (!archived && wasArchived && (await this.packTypes.countActive(existing.productId)) >= MAX_PACK_TYPES) {
      throw packLimit();
    }

    await mapConflicts(
      () =>
        this.packTypes.update(existing.id, {
          ...wanted,
          costPrice,
          archivedAt: archived === wasArchived ? existing.archivedAt : archived ? this.clock.now() : null,
        }),
      wanted.unitsPerPack,
    );
    await this.audit.record({
      action: 'pack_type.updated',
      targetType: 'pack_type',
      targetId: existing.id,
      metadata: { product_id: existing.productId, ...before, ...after },
      actorMembershipId,
    });
  }
}

/**
 * Makes the user's text match literally inside a LIKE pattern: %, _ and the
 * escape character itself (backslash, declared with ESCAPE '\' in the SQL).
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** limit: default 20; above 50 is quietly capped at 50; 0 is refused. */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw readInvalid('limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}

function readInvalid(message: string): ApiError {
  return new ApiError(422, 'VALIDATION_FAILED', message);
}

/** Trimmed text of 1 to max characters, or VALIDATION_FAILED. */
function text(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw invalid(`The ${field} must be 1 to ${max} characters.`);
  }
  return trimmed;
}

function packMetadata(
  productId: string,
  p: { name: string; unitsPerPack: number; sellPrice: string; costPrice: string | null },
): AuditMetadata {
  // Cost prices are business data only costs.view may see; a future audit
  // read endpoint must hide them (docs/phase-b-design.md section 8).
  return { product_id: productId, name: p.name, units_per_pack: p.unitsPerPack, sell_price: p.sellPrice, cost_price: p.costPrice };
}

/**
 * Runs one write and turns a unique violation into its reason, by constraint
 * name. Anything else is rethrown (a crash: the command FAILS and is retried).
 * After a failed statement the transaction is unusable until the savepoint is
 * rolled back, which the dispatcher does; so nothing else runs after this throws.
 */
async function mapConflicts(write: () => Promise<void>, unitsPerPack?: number): Promise<void> {
  try {
    await write();
  } catch (err) {
    switch (uniqueViolationConstraint(err)) {
      case 'product_business_id_sku_key':
        throw new CatalogueError('SKU_TAKEN', 'Another product already has this SKU.');
      case 'product_barcode_business_id_barcode_key':
        throw barcodeTaken();
      case 'product_pkey':
      case 'pack_type_pkey':
        throw new CatalogueError('ALREADY_EXISTS', 'This item already exists.');
      case 'pack_type_one_base_unit_per_product':
        throw baseUnitDuplicate();
      // Also refuses a second base unit (units 1), depending on which index
      // Postgres checks first; both mean the same thing then.
      case 'pack_type_business_id_product_id_units_per_pack_key':
        throw unitsPerPack === 1 ? baseUnitDuplicate() : unitsDuplicate();
      case 'pack_type_business_id_product_id_name_key':
        throw nameDuplicate();
      default:
        throw err;
    }
  }
}

function barcodeTaken(): CatalogueError {
  return new CatalogueError('BARCODE_TAKEN', 'This barcode is already registered to a product.');
}
function invalid(message: string): CatalogueError {
  return new CatalogueError('VALIDATION_FAILED', message);
}
function productNotFound(): CatalogueError {
  // The same for another business's product and one that does not exist.
  return new CatalogueError('PRODUCT_NOT_FOUND', 'Product not found.');
}
function packTypeNotFound(): CatalogueError {
  return new CatalogueError('PACK_TYPE_NOT_FOUND', 'Pack type not found.');
}
function packLimit(): CatalogueError {
  return new CatalogueError('PACK_LIMIT_REACHED', `A product has at most ${MAX_PACK_TYPES} active pack types.`);
}
function baseUnitDuplicate(): CatalogueError {
  return new CatalogueError('BASE_UNIT_DUPLICATE', 'A product has at most one pack type of 1 unit.');
}
function unitsDuplicate(): CatalogueError {
  return new CatalogueError('PACK_UNITS_DUPLICATE', 'Another pack type of this product has the same number of units.');
}
function nameDuplicate(): CatalogueError {
  return new CatalogueError('PACK_NAME_DUPLICATE', 'Another pack type of this product has this name.');
}
