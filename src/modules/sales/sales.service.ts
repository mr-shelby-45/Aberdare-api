import { Injectable } from '@nestjs/common';
import { MAX_CENTS, fromCents, toCents } from '../../common/money/cents.js';
import { isNumericOverflow, uniqueViolationConstraint } from '../../database/db-errors.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FieldSettlementsService } from '../field-settlements/field-settlements.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { NotificationEvents } from '../notifications/notification-events.js';
import { PaymentsService, type ValidPayment, paymentsTotal } from '../payments/payments.service.js';
import type { PackTypeForSale } from '../products/pack-types.repository.js';
import { ProductsService } from '../products/products.service.js';
import { inLockOrder } from '../stock/lock-order.js';
import { StockError } from '../stock/stock.error.js';
import { StockService } from '../stock/stock.service.js';
import type { AttachPaymentDto } from './dto/attach-payment.dto.js';
import type { CreateSaleDto, SaleLineDto } from './dto/create-sale.dto.js';
import type { VoidSaleDto } from './dto/void-sale.dto.js';
import { type InvalidSaleLine, type SaleLineReason, SalesError } from './sales.error.js';
import { SalesRepository } from './sales.repository.js';

const MAX_LINE_QUANTITY = 100_000;
// Control characters other than tab and line breaks: Postgres text cannot
// hold a NUL, so it would otherwise end as a crash instead of a rejection.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Flags in the order that picks the command's reason (docs/phase-e-design.md section 4). */
// AFTER_SETTLEMENT since Phase T4, last in the order.
export type SaleFlag = 'TOTAL_MISMATCH' | 'STOCK_NEGATIVE' | 'DUPLICATE_MPESA_CODE' | 'OVERPAYMENT' | 'AFTER_SETTLEMENT';
const FLAG_ORDER: SaleFlag[] = ['TOTAL_MISMATCH', 'STOCK_NEGATIVE', 'DUPLICATE_MPESA_CODE', 'OVERPAYMENT', 'AFTER_SETTLEMENT'];

/** Who sold, where from, when, and which command. */
export interface SaleActor {
  membershipId: string;
  deviceId: string;
  occurredAt: Date;
  receivedAt: Date;
  syncCommandId: string;
}

/** Who attaches payments: attendants (no sales.void) only to their own sales. */
export interface PaymentActor {
  membershipId: string;
  // Phase T6: the device the payments are recorded on.
  deviceId: string;
  seesAllSales: boolean;
  occurredAt: Date;
}

export interface PaymentsAttached {
  paidTotal: string;
  balanceDue: string;
  flags: SaleFlag[];
}

/** Who voids: canVoid when the member holds sales.void; otherwise an approval is needed. */
export interface VoidActor {
  membershipId: string;
  deviceId: string;
  canVoid: boolean;
  occurredAt: Date;
  receivedAt: Date;
  syncCommandId: string;
}

export interface SaleVoided {
  saleId: string;
  voidedAt: Date;
  approvedByMembershipId: string;
}

export interface SaleCreated {
  saleId: string;
  saleNumber: number;
  total: string;
  paidTotal: string;
  balanceDue: string;
  flags: SaleFlag[];
}

// Sales (Phase E). A sale that really happened is never refused: only invalid
// or unauthorised input is. Short stock, a price below list and a wrong phone
// total are saved and flagged. Runs inside the command's tenant transaction
// (a savepoint of it), so a SalesError or a crash undoes every write,
// including the counter increment.
@Injectable()
export class SalesService {
  constructor(
    private readonly repo: SalesRepository,
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly locations: LocationsService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly approvals: ApprovalsService,
    private readonly fieldSettlements: FieldSettlementsService,
    private readonly events: NotificationEvents,
  ) {}

  /**
   * sale.create. Write order (decided in E2): every check first, then the
   * sale-mode balance statements in the lock order (they take the stock
   * locks), then the counter (the shortest hold on it, and always after the
   * stock locks, so no cycle), then the sale and its items, then the SALE
   * movements (they need the sale row), then the audit row. All in one
   * transaction.
   */
  async create(dto: CreateSaleDto, actor: SaleActor): Promise<SaleCreated> {
    const localRef = cleanText(dto.local_ref);
    if (!localRef) throw new SalesError('VALIDATION_FAILED', 'The local reference must be 1 to 30 characters.');
    const note = cleanText(dto.note);
    const location = await this.locations.findInScope(dto.location_id, actor.membershipId);
    if (!location) {
      // The same for another business's location, one that does not exist, and
      // one outside a field attendant's scope (Phase T2).
      throw new SalesError('LOCATION_NOT_FOUND', 'Location not found.');
    }

    // Archived products and pack types are allowed: the sale already happened.
    const packs = await this.products.packTypesForSale([...new Set(dto.lines.map((l) => l.pack_type_id))]);
    const invalid: InvalidSaleLine[] = [];
    dto.lines.forEach((line, i) => {
      const reason = lineProblem(line, packs);
      if (reason) invalid.push({ line: i + 1, reason });
    });
    if (invalid.length > 0) {
      throw new SalesError('INVALID_LINES', 'Some lines of this sale are not valid. Nothing was saved.', invalid);
    }
    const payments = this.validPayments(dto.payments ?? []);
    if (await this.repo.exists(dto.sale_id)) {
      throw new SalesError('SALE_ALREADY_EXISTS', 'This sale was already recorded.');
    }

    // Exact money, in whole cents (never a JavaScript number).
    const lines = dto.lines.map((line, i) => {
      const unitCents = toCents(line.unit_price)!;
      const lineCents = unitCents * BigInt(line.quantity);
      if (lineCents > MAX_CENTS) throw tooLarge();
      return { lineNo: i + 1, line, pack: packs.get(line.pack_type_id)!, unitCents, lineCents };
    });
    const totalCents = lines.reduce((sum, l) => sum + l.lineCents, 0n);
    if (totalCents > MAX_CENTS) throw tooLarge();
    const total = fromCents(totalCents);
    const totalMismatch = dto.total !== undefined && toCents(dto.total) !== totalCents;
    const paidCents = paymentsTotal(payments);
    if (paidCents > MAX_CENTS) throw tooLarge();
    const paidTotal = fromCents(paidCents);
    const balanceDue = fromCents(paidCents >= totalCents ? 0n : totalCents - paidCents);

    // Stock: the sale-mode statement per line, larger pack first.
    const ordered = inLockOrder(
      lines.map((l) => ({ ...l, pack_type_id: l.line.pack_type_id })),
      packs,
    );
    const after = await this.stock.saleDecreases(
      dto.location_id,
      ordered.map((l) => ({ packTypeId: l.pack_type_id, quantity: l.line.quantity })),
    );

    // The number, after every stock statement.
    const saleNumber = await this.repo.nextSaleNumber();
    await mapConflicts(() =>
      this.repo.insertSale({
        id: dto.sale_id,
        saleNumber,
        localRef,
        locationId: dto.location_id,
        deviceId: actor.deviceId,
        createdByMembershipId: actor.membershipId,
        occurredAt: actor.occurredAt,
        receivedAt: actor.receivedAt,
        total,
        paidTotal,
        balanceDue,
        totalMismatch,
        note,
      }),
    );
    await this.repo.insertItems(
      dto.sale_id,
      lines.map((l) => ({
        lineNo: l.lineNo,
        packTypeId: l.line.pack_type_id,
        productName: l.pack.productName,
        packTypeName: l.pack.name,
        quantity: l.line.quantity,
        unitPrice: fromCents(l.unitCents),
        listPrice: l.pack.sellPrice,
        costPrice: l.pack.costPrice,
        lineTotal: fromCents(l.lineCents),
      })),
    );
    await this.stock.recordSaleMovements(
      dto.sale_id,
      dto.location_id,
      ordered.map((l, i) => ({ packTypeId: l.pack_type_id, quantity: l.line.quantity, quantityAfter: after[i] })),
      { occurredAt: actor.occurredAt, createdByMembershipId: actor.membershipId, syncCommandId: actor.syncCommandId },
    );

    const { duplicates } = await this.payments.record(dto.sale_id, payments, {
      occurredAt: actor.occurredAt,
      createdByMembershipId: actor.membershipId,
      locationId: dto.location_id,
      recordedByDeviceId: actor.deviceId,
    });

    const flags = inFlagOrder({
      TOTAL_MISMATCH: totalMismatch,
      STOCK_NEGATIVE: after.some((q) => q < 0),
      DUPLICATE_MPESA_CODE: duplicates > 0,
      OVERPAYMENT: paidCents > totalCents,
      AFTER_SETTLEMENT: await this.afterSettlement(location, actor.occurredAt),
    });

    // Ids, numbers, totals and flags: never the note, names, prices, codes or single amounts.
    // Payments inside sale.create are part of this row, not a payment.attached row (design section 9).
    await this.audit.record({
      action: 'sale.created',
      targetType: 'sale',
      targetId: dto.sale_id,
      metadata: {
        sale_id: dto.sale_id,
        sale_number: saleNumber,
        location_id: dto.location_id,
        total,
        line_count: lines.length,
        payment_count: payments.length,
        paid_total: paidTotal,
        flags,
      },
      actorMembershipId: actor.membershipId,
    });
    // Phase F4: owners are told of a flagged sale, in this transaction.
    await this.events.saleFlagged({ saleId: dto.sale_id, saleNumber, flags }, actor.membershipId);
    return { saleId: dto.sale_id, saleNumber, total, paidTotal, balanceDue, flags };
  }

  /**
   * payment.attach. The sale is read first only to choose the answer (another
   * member's sale is SALE_NOT_FOUND for an attendant, the same as a missing
   * one). Then one conditional UPDATE adds the amount and takes the sale's row
   * lock before any payment row is written, then the payments, then the audit.
   */
  async attachPayments(dto: AttachPaymentDto, actor: PaymentActor): Promise<PaymentsAttached> {
    const payments = this.validPayments(dto.payments);
    const sale = await this.repo.findState(dto.sale_id);
    if (!sale || (!actor.seesAllSales && sale.createdByMembershipId !== actor.membershipId) || !(await this.inScope(sale.locationId, actor.membershipId))) {
      throw new SalesError('SALE_NOT_FOUND', 'Sale not found.');
    }
    if (sale.status !== 'COMPLETED') throw voided();

    const amountCents = paymentsTotal(payments);
    if (amountCents > MAX_CENTS) throw tooLarge();
    const amountTotal = fromCents(amountCents);
    let paid: { total: string; paidTotal: string; balanceDue: string } | null;
    try {
      paid = await this.repo.addPaid(dto.sale_id, amountTotal);
    } catch (err) {
      // The sale's paid_total would leave NUMERIC(14,2).
      if (isNumericOverflow(err)) throw tooLarge();
      throw err;
    }
    // A void committed between the read and the update.
    if (!paid) throw voided();

    const { duplicates } = await this.payments.record(dto.sale_id, payments, {
      occurredAt: actor.occurredAt,
      createdByMembershipId: actor.membershipId,
      locationId: sale.locationId,
      recordedByDeviceId: actor.deviceId,
    });
    const flags = inFlagOrder({
      DUPLICATE_MPESA_CODE: duplicates > 0,
      OVERPAYMENT: toCents(paid.paidTotal)! > toCents(paid.total)!,
    });
    await this.audit.record({
      action: 'payment.attached',
      targetType: 'sale',
      targetId: dto.sale_id,
      metadata: { sale_id: dto.sale_id, payment_count: payments.length, amount_total: amountTotal, flags },
      actorMembershipId: actor.membershipId,
    });
    return { paidTotal: paid.paidTotal, balanceDue: paid.balanceDue, flags };
  }

  /**
   * sale.void (docs/phase-e-design.md section 5; order decided in E5): the
   * permission rule, then the sale (another member's is SALE_NOT_FOUND for a
   * member without sales.void, even with an approval), then the approval, then
   * one conditional UPDATE, the stock put back in the lock order, the
   * payments reversed (after the stock since E6), and the audit row. All in
   * the command's savepoint: any
   * failure undoes everything, including the use of the approval.
   */
  async void(dto: VoidSaleDto, actor: VoidActor): Promise<SaleVoided> {
    if (!actor.canVoid && dto.approval_id === undefined) {
      // The dispatcher's own wording for a missing permission.
      throw new SalesError('PERMISSION_DENIED', 'You are not allowed to do this');
    }
    const note = cleanText(dto.note);
    const sale = await this.repo.findState(dto.sale_id);
    if (!sale || (!actor.canVoid && sale.createdByMembershipId !== actor.membershipId) || !(await this.inScope(sale.locationId, actor.membershipId))) {
      throw new SalesError('SALE_NOT_FOUND', 'Sale not found.');
    }
    if (sale.status !== 'COMPLETED') throw alreadyVoided();

    // A member with sales.void approves their own void; any approval_id is ignored and stays unused.
    let approvedBy = actor.membershipId;
    let approvalId: string | null = null;
    if (!actor.canVoid) {
      const approver = await this.approvals.use('SALE_VOID', {
        approvalId: dto.approval_id!,
        requesterMembershipId: actor.membershipId,
        deviceId: actor.deviceId,
        syncCommandId: actor.syncCommandId,
        occurredAt: actor.occurredAt,
        receivedAt: actor.receivedAt,
      });
      if (!approver) throw new SalesError('APPROVAL_INVALID', 'This approval cannot be used. Ask for a new one.');
      approvedBy = approver;
      approvalId = dto.approval_id!;
    }

    // voided_at is the phone's time of the void, like the sale's own occurred_at (decided in E5).
    const voided = await this.repo.markVoided(dto.sale_id, {
      voidedAt: actor.occurredAt,
      voidedByMembershipId: actor.membershipId,
      reason: dto.reason,
      note,
      approvalId,
      approvedByMembershipId: approvedBy,
    });
    // A concurrent void committed between the read and the update.
    if (!voided) throw alreadyVoided();

    // Lock order: the sale row, then the stock pools (in the shared order),
    // then the payments. Payments must come last (found by the E6 workload): a
    // reversed payment holding a code makes a concurrent sale that reuses the
    // code wait for this void; if this void still needed a pool that sale
    // holds, the two would deadlock (40P01).
    const lines = await this.repo.lines(dto.sale_id);
    const packs = await this.products.packTypesForSale([...new Set(lines.map((l) => l.packTypeId))]);
    const ordered = inLockOrder(lines.map((l) => ({ ...l, pack_type_id: l.packTypeId })), packs);
    try {
      await this.stock.returnForVoid(dto.sale_id, sale.locationId, ordered, {
        occurredAt: actor.occurredAt,
        createdByMembershipId: actor.membershipId,
        syncCommandId: actor.syncCommandId,
      });
    } catch (err) {
      // Only the MAX_BALANCE cap can stop an increase.
      if (err instanceof StockError) throw new SalesError('VALIDATION_FAILED', err.message);
      throw err;
    }
    await this.payments.reverseForSale(dto.sale_id);

    // Ids, the number and the reason enum: never the note.
    await this.audit.record({
      action: 'sale.voided',
      targetType: 'sale',
      targetId: dto.sale_id,
      metadata: { sale_id: dto.sale_id, sale_number: sale.saleNumber, reason: dto.reason, approver_membership_id: approvedBy, approval_id: approvalId },
      actorMembershipId: actor.membershipId,
    });
    // Phase F4: a PIN approval was used for this void.
    if (approvalId) {
      await this.events.approvalUsed({ approvalId, purpose: 'SALE_VOID', requesterMembershipId: actor.membershipId, approverMembershipId: approvedBy, targetId: dto.sale_id });
    }
    return { saleId: dto.sale_id, voidedAt: actor.occurredAt, approvedByMembershipId: approvedBy };
  }

  /**
   * Phase T4: a sale at a field location whose latest settlement's period_end
   * is at or after the sale's occurred_at reached the server after the
   * attendant's day was closed (docs/phase-t-design.md section 6). It is saved
   * as usual; the flag tells the owner to look at that settlement.
   */
  private async afterSettlement(location: { id: string; kind: string }, occurredAt: Date): Promise<boolean> {
    if (location.kind !== 'FIELD') return false;
    const latest = await this.fieldSettlements.latest(location.id);
    return latest !== null && latest.periodEnd.getTime() >= occurredAt.getTime();
  }

  /** Phase T2: a sale at a location outside the member's scope is the same as a missing sale. */
  private async inScope(locationId: string, membershipId: string): Promise<boolean> {
    return (await this.locations.scopeOf(membershipId)).allows(locationId);
  }

  private validPayments(payments: Parameters<PaymentsService['validate']>[0]): ValidPayment[] {
    const { valid, invalid } = this.payments.validate(payments);
    if (invalid.length > 0) {
      throw new SalesError('INVALID_PAYMENTS', 'Some payments are not valid. Nothing was saved.', undefined, invalid);
    }
    return valid;
  }
}

/** The first problem of one line, or null: the pack type, then the quantity, then the price. */
function lineProblem(line: SaleLineDto, packs: ReadonlyMap<string, PackTypeForSale>): SaleLineReason | null {
  if (!packs.has(line.pack_type_id)) return 'PACK_TYPE_NOT_FOUND';
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) return 'QUANTITY_INVALID';
  if (toCents(line.unit_price) === null) return 'PRICE_INVALID';
  return null;
}

/** Trimmed text, or null when absent or blank. Control characters are refused. */
function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (CONTROL_CHARS.test(value)) throw new SalesError('VALIDATION_FAILED', 'The text contains characters that are not allowed.');
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The flags that apply, in the design's order (the first is the command's reason). */
function inFlagOrder(raised: Partial<Record<SaleFlag, boolean>>): SaleFlag[] {
  return FLAG_ORDER.filter((f) => raised[f] === true);
}

function alreadyVoided(): SalesError {
  return new SalesError('SALE_ALREADY_VOIDED', 'This sale was already voided.');
}

function voided(): SalesError {
  return new SalesError('SALE_VOIDED', 'This sale was voided. Payments cannot be added.');
}

function tooLarge(): SalesError {
  return new SalesError('VALIDATION_FAILED', 'This sale is larger than the system can record.');
}

/**
 * Two commands with the same sale id at the same moment: both pass the
 * early check, the second insert hits the primary key. Mapped by constraint
 * name (Phase B pattern); the savepoint then undoes this command's stock and
 * counter writes.
 */
async function mapConflicts(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (uniqueViolationConstraint(err) === 'sale_pkey') throw new SalesError('SALE_ALREADY_EXISTS', 'This sale was already recorded.');
    throw err;
  }
}
