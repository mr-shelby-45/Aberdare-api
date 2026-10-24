import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { TenantContextMissingError } from '../common/errors/tenant-context-missing.error.js';
import { PrismaService } from './prisma.service.js';

// The only client repositories ever see: a Prisma transaction client whose
// connection already has app.business_id set for this transaction.
export type TenantTx = Prisma.TransactionClient;

interface TenantContext {
  businessId: string;
  tx: TenantTx;
}

// Deliberately not exported. Only TenantRunner.run() can put a client in here,
// so code elsewhere cannot fake a tenant context with the global client.
const storage = new AsyncLocalStorage<TenantContext>();

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tenant transaction client for the current call chain. Throws if there is none. */
export function currentTx(): TenantTx {
  const ctx = storage.getStore();
  if (!ctx) throw new TenantContextMissingError();
  return ctx.tx;
}

/** The business of the current tenant transaction. Throws if there is none. */
export function currentBusinessId(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new TenantContextMissingError();
  return ctx.businessId;
}

@Injectable()
export class TenantRunner {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs fn inside one database transaction scoped to businessId.
   * The first statement sets app.business_id transaction-locally (third
   * argument true), so the setting disappears at commit or rollback and can
   * never leak to the next user of the pooled connection.
   * If fn throws, everything it wrote is rolled back.
   */
  async run<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
    if (!UUID.test(businessId)) {
      throw new Error('TenantRunner.run: businessId must be a UUID');
    }
    if (storage.getStore()) {
      // Nesting would open a second transaction on another connection, and
      // could silently switch tenants mid-request. Refuse instead.
      throw new Error('TenantRunner.run: already inside a tenant transaction');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.business_id', ${businessId}, true)`;
      return storage.run({ businessId, tx }, fn);
    });
  }
}
