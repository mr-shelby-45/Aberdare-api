export type StockErrorCode =
  | 'STOCK_INSUFFICIENT'
  | 'STOCK_QUANTITY_INVALID'
  | 'STOCK_CONVERSION_INVALID';

// A stock rule was broken. The message is safe to show to a user.
export class StockError extends Error {
  constructor(
    readonly code: StockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StockError';
  }
}
