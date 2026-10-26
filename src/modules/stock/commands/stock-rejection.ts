import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { StockError } from '../stock.error.js';

/**
 * A StockError becomes a stored rejection (INVALID_LINES carries the bad
 * lines as `result`); anything else is returned unchanged, so it stays a crash.
 */
export function rejectionFor(err: unknown): unknown {
  if (!(err instanceof StockError)) return err;
  return new CommandRejectedError(
    err.code,
    err.message,
    err.invalidLines ? { invalid_lines: err.invalidLines.map((l) => ({ line: l.line, reason: l.reason })) } : undefined,
  );
}
