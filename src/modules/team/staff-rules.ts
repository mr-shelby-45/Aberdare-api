import { PERMISSIONS, type Permission } from '../../common/auth/permissions.js';
import type { RequestSession } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/errors/api.error.js';

// Who may change whose access (docs/phase-a-design.md section 9, decided in A4).

// Only the owner may grant these, even to someone who has staff.manage.
const OWNER_ONLY: ReadonlySet<Permission> = new Set([
  'costs.view',
  'staff.manage',
  'devices.manage',
  'subscription.manage',
  'shopkey.manage',
  'locations.manage',
]);
const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

/**
 * Checks extra permissions for a MANAGER or ATTENDANT. Unknown strings and
 * stock.convert on an attendant are invalid (422); owner-only permissions
 * granted by someone who is not the owner are refused (403).
 */
export function checkExtraPermissions(
  preset: 'MANAGER' | 'ATTENDANT',
  extras: readonly string[],
  actor: RequestSession,
): void {
  for (const p of extras) {
    if (!KNOWN.has(p)) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Unknown permission: ${p}`);
    }
    if (preset === 'ATTENDANT' && p === 'stock.convert') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'An attendant cannot be given stock.convert.');
    }
    if (OWNER_ONLY.has(p as Permission) && actor.membership.rolePreset !== 'OWNER') {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Only the owner can grant this permission.');
    }
  }
}

/** Nobody changes their own access through the staff endpoints. */
export function refuseSelf(targetId: string, actor: RequestSession): void {
  if (targetId === actor.membership.id) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'You cannot change your own access.');
  }
}

export function ownerProtected(): ApiError {
  return new ApiError(403, 'OWNER_PROTECTED', 'The owner cannot be suspended, removed, demoted or reset.');
}

export function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Not found');
}
