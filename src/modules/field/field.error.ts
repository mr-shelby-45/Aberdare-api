export type FieldErrorCode =
  | 'VALIDATION_FAILED'
  | 'LOCATION_NOT_FOUND'
  | 'SETTLEMENT_ALREADY_EXISTS'
  | 'ATTENDANT_NOT_SYNCED'
  | 'INVALID_LINES';

export type SettlementLineReason = 'DUPLICATE_LINE' | 'PACK_TYPE_NOT_FOUND' | 'QUANTITY_INVALID' | 'LINE_MISSING';

/**
 * One bad line of a settlement: a payload line (1-based), or a pack type that
 * has stock or movements at the location but no line (LINE_MISSING).
 */
export type InvalidSettlementLine = { line: number; reason: SettlementLineReason } | { pack_type_id: string; reason: 'LINE_MISSING' };

// A settlement that cannot be closed. The message is safe to show to a user.
// For INVALID_LINES, invalidLines lists every bad and missing line.
export class FieldError extends Error {
  constructor(
    readonly code: FieldErrorCode,
    message: string,
    readonly invalidLines?: InvalidSettlementLine[],
  ) {
    super(message);
    this.name = 'FieldError';
  }
}
