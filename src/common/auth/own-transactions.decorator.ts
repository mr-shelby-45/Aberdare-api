import { SetMetadata } from '@nestjs/common';

export const OWN_TRANSACTIONS = 'auth:own-transactions';

/**
 * A protected route whose handler opens its own tenant transactions
 * (docs/phase-b-design.md section 5). TenantInterceptor still checks the token,
 * loads the live membership and device in a short transaction and refuses an
 * inactive one, but then runs the handler outside any transaction.
 *
 * For POST /v1/sync/commands only, which needs one transaction per command.
 * A test fails if any other route uses it.
 */
export const OwnTransactions = () => SetMetadata(OWN_TRANSACTIONS, true);
