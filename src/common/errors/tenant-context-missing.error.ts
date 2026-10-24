// Thrown when tenant-scoped data is touched outside TenantRunner.run().
// It is always a programming mistake, never a user error.
export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor() {
    super(
      'No tenant transaction is active. Tenant data may only be accessed inside TenantRunner.run().',
    );
    this.name = 'TenantContextMissingError';
  }
}
