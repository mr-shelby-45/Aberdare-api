export type StockErrorCode =
  | 'STOCK_INSUFFICIENT'
  | 'STOCK_QUANTITY_INVALID'
  // A balance would leave -MAX_BALANCE..MAX_BALANCE, or text the database cannot hold
  // (docs/phase-c-design.md section 4).
  | 'VALIDATION_FAILED'
  // Command reasons (docs/phase-c-design.md section 5).
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_ARCHIVED'
  | 'PACK_TYPE_NOT_FOUND'
  | 'REASON_SIGN_MISMATCH'
  | 'INVALID_LINES'
  // stock.convert (C4; replaced the spike's STOCK_CONVERSION_INVALID).
  | 'PACK_TYPES_NOT_CONVERTIBLE'
  | 'CONVERSION_RATIO_INVALID'
  // C5: the same for a missing, used, expired, foreign or rebound approval.
  | 'APPROVAL_INVALID';

export type StockLineReason =
  | 'DUPLICATE_LINE'
  | 'PACK_TYPE_NOT_FOUND'
  | 'PACK_TYPE_ARCHIVED'
  | 'QUANTITY_INVALID'
  | 'COST_INVALID';

/** One bad line of a command; line is 1-based. */
export interface InvalidLine {
  line: number;
  reason: StockLineReason;
}

// A stock rule was broken. The message is safe to show to a user. For
// INVALID_LINES, invalidLines lists every bad line.
export class StockError extends Error {
  constructor(
    readonly code: StockErrorCode,
    message: string,
    readonly invalidLines?: InvalidLine[],
  ) {
    super(message);
    this.name = 'StockError';
  }
}
