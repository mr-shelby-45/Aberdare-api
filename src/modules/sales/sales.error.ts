import type { InvalidPayment } from '../payments/payments.service.js';

export type SalesErrorCode =
  | 'VALIDATION_FAILED'
  | 'LOCATION_NOT_FOUND'
  | 'SALE_ALREADY_EXISTS'
  | 'INVALID_LINES'
  | 'INVALID_PAYMENTS'
  | 'SALE_NOT_FOUND'
  | 'SALE_VOIDED';

export type SaleLineReason = 'PACK_TYPE_NOT_FOUND' | 'QUANTITY_INVALID' | 'PRICE_INVALID';

/** One bad line of a sale; line is 1-based. */
export interface InvalidSaleLine {
  line: number;
  reason: SaleLineReason;
}

// A sale or payment that cannot be saved because its input is invalid (never
// because of stock, price, totals or a reused code: those are saved and
// flagged). The message is safe to show to a user. For INVALID_LINES,
// invalidLines lists every bad line; for INVALID_PAYMENTS, invalidPayments
// lists every bad payment.
export class SalesError extends Error {
  constructor(
    readonly code: SalesErrorCode,
    message: string,
    readonly invalidLines?: InvalidSaleLine[],
    readonly invalidPayments?: InvalidPayment[],
  ) {
    super(message);
    this.name = 'SalesError';
  }
}
