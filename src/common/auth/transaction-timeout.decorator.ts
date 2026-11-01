import { SetMetadata } from '@nestjs/common';

export const TRANSACTION_TIMEOUT = 'auth:transaction-timeout';

/**
 * A protected route whose tenant transaction may run longer than Prisma's
 * default of 5 seconds (Phase G1, approved by Ian). TenantInterceptor passes
 * the value to TenantRunner.run(). Only the report routes use it, so that
 * their 8 second statement timeout can fire inside the transaction.
 * A test fails if any other route uses it.
 */
export const TransactionTimeout = (ms: number) => SetMetadata(TRANSACTION_TIMEOUT, ms);
