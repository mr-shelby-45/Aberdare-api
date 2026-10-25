import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export const REQUIRED_PERMISSIONS = 'auth:permissions';

/**
 * The permissions a route needs. Checked by the TenantInterceptor inside the
 * request's tenant transaction, against the live membership (never in a
 * guard: guards run before that transaction exists).
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
