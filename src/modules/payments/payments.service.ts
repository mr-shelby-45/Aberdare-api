import { Injectable } from '@nestjs/common';
import { MAX_CENTS, fromCents, toCents } from '../../common/money/cents.js';
import type { PaymentDto } from './dto/payment.dto.js';
import { type PaymentReadRow, PaymentsRepository } from './payments.repository.js';

export type PaymentReason = 'AMOUNT_INVALID' | 'METHOD_INVALID' | 'MPESA_CODE_MISSING' | 'MPESA_CODE_INVALID' | 'MPESA_CODE_NOT_ALLOWED';

/** One bad payment of a command; payment is 1-based. */
export interface InvalidPayment {
  payment: number;
  reason: PaymentReason;
}

/** A payment that passed every check: exact cents and a normalised code. */
export interface ValidPayment {
  method: 'CASH' | 'MPESA';
  cents: bigint;
  mpesaCode: string | null;
}

// TODO(verify): the real M-Pesa code format (docs/phase-e-design.md open
// item 2). This is the design's placeholder: letters and digits, 8 to 12
// characters, after trimming and upper-casing. Do not tighten it without Ian.
const MPESA_CODE = /^[A-Z0-9]{8,12}$/;

// Payments (Phase E). A data module: it owns the payment table and imports no
// other feature module. Sales decide when payments are recorded and keep the
// sale's paid_total and balance_due. Nothing is verified until Phase M.
@Injectable()
export class PaymentsService {
  constructor(private readonly repo: PaymentsRepository) {}

  /** Checks every payment and lists every bad one (the first problem of each). */
  validate(payments: readonly PaymentDto[]): { valid: ValidPayment[]; invalid: InvalidPayment[] } {
    const valid: ValidPayment[] = [];
    const invalid: InvalidPayment[] = [];
    payments.forEach((p, i) => {
      const result = check(p);
      if ('reason' in result) invalid.push({ payment: i + 1, reason: result.reason });
      else valid.push(result);
    });
    return { valid, invalid };
  }

  /**
   * Saves the payments of a sale, in the order given, in the current
   * transaction. A code this business already used is saved as a duplicate of
   * the original payment (the sale is never refused). Returns how many were
   * duplicates.
   */
  async record(saleId: string, payments: readonly ValidPayment[], ctx: { occurredAt: Date; createdByMembershipId: string }): Promise<{ duplicates: number }> {
    let duplicates = 0;
    // One after another: queries on one transaction cannot run in parallel.
    for (const p of payments) {
      const row = { saleId, method: p.method, amount: fromCents(p.cents), mpesaCode: p.mpesaCode, ...ctx };
      if ((await this.repo.insertOriginal(row)) !== null) continue;
      const original = await this.repo.originalOf(p.mpesaCode!);
      if (original === null) throw new Error('payment_mpesa_code_unique conflict without an original payment');
      await this.repo.insertDuplicate(row, original);
      duplicates++;
    }
    return { duplicates };
  }

  // Reads (Phase E4). The sales module decides which sales a reader may see;
  // these only fetch the payments of the sales it names, or by id.

  async forSales(saleIds: string[]): Promise<PaymentReadRow[]> {
    return this.repo.forSales(saleIds);
  }

  async byIdsForSync(ids: string[]): Promise<PaymentReadRow[]> {
    return this.repo.byIds(ids);
  }

  async pageForSync(afterId: string | null, limit: number, saleIds: string[]): Promise<PaymentReadRow[]> {
    return this.repo.pageForSync(afterId, limit, saleIds);
  }
}

/** The sum of the payments in cents (each is at most MAX_CENTS, ten at most, so no overflow in BigInt). */
export function paymentsTotal(payments: readonly ValidPayment[]): bigint {
  return payments.reduce((sum, p) => sum + p.cents, 0n);
}

function check(p: PaymentDto): ValidPayment | { reason: PaymentReason } {
  if (p.method !== 'CASH' && p.method !== 'MPESA') return { reason: 'METHOD_INVALID' };
  const cents = toCents(p.amount);
  if (cents === null || cents === 0n || cents > MAX_CENTS) return { reason: 'AMOUNT_INVALID' };
  const hasCode = p.mpesa_code !== undefined && p.mpesa_code !== null;
  if (p.method === 'CASH') {
    return hasCode ? { reason: 'MPESA_CODE_NOT_ALLOWED' } : { method: 'CASH', cents, mpesaCode: null };
  }
  if (!hasCode) return { reason: 'MPESA_CODE_MISSING' };
  const code = p.mpesa_code!.trim().toUpperCase();
  return MPESA_CODE.test(code) ? { method: 'MPESA', cents, mpesaCode: code } : { reason: 'MPESA_CODE_INVALID' };
}
