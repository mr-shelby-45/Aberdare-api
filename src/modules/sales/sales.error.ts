export type SalesErrorCode = 'VALIDATION_FAILED' | 'LOCATION_NOT_FOUND' | 'SALE_ALREADY_EXISTS' | 'INVALID_LINES';

export type SaleLineReason = 'PACK_TYPE_NOT_FOUND' | 'QUANTITY_INVALID' | 'PRICE_INVALID';

/** One bad line of a sale; line is 1-based. */
export interface InvalidSaleLine {
  line: number;
  reason: SaleLineReason;
}

// A sale that cannot be saved because its input is invalid (never because of
// stock, price or totals: those are saved and flagged). The message is safe
// to show to a user. For INVALID_LINES, invalidLines lists every bad line.
export class SalesError extends Error {
  constructor(
    readonly code: SalesErrorCode,
    message: string,
    readonly invalidLines?: InvalidSaleLine[],
  ) {
    super(message);
    this.name = 'SalesError';
  }
}
