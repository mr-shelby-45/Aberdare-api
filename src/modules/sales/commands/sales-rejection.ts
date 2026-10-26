import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { SalesError } from '../sales.error.js';

/** A SalesError as the command's rejection, with every bad line or payment in its result; other errors unchanged. */
export function salesRejection(err: unknown): unknown {
  if (!(err instanceof SalesError)) return err;
  if (err.invalidLines) {
    return new CommandRejectedError(err.code, err.message, { invalid_lines: err.invalidLines.map((l) => ({ line: l.line, reason: l.reason })) });
  }
  if (err.invalidPayments) {
    return new CommandRejectedError(err.code, err.message, { invalid_payments: err.invalidPayments.map((p) => ({ payment: p.payment, reason: p.reason })) });
  }
  return new CommandRejectedError(err.code, err.message);
}
