// Permissions and role presets (docs/phase-a-design.md section 9). Effective
// permissions are computed on every request from the live membership row;
// they are never stored in a token.

export const PERMISSIONS = [
  'sales.create',
  'payments.confirm',
  'stock.view',
  'orders.manage',
  'products.edit',
  'stock.receive',
  'stock.adjust',
  'stock.convert',
  'stock.count',
  'sales.void',
  'payments.approve',
  'reports.view',
  'costs.view',
  'staff.manage',
  'devices.manage',
  'subscription.manage',
  'shopkey.manage',
  // Phase B: add, rename, archive and restore locations.
  'locations.manage',
  // Phase T: issue stock to and return it from field locations; close field settlements.
  'stock.transfer',
  'field.settle',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RolePreset = 'OWNER' | 'MANAGER' | 'ATTENDANT' | 'FIELD_ATTENDANT';

const ATTENDANT: Permission[] = ['sales.create', 'payments.confirm', 'stock.view', 'orders.manage'];
// Phase T: sells on foot or by vehicle from their assigned FIELD locations only
// (the location scope, docs/phase-t-design.md section 4). Never any extras.
const FIELD_ATTENDANT: Permission[] = ['sales.create', 'payments.confirm', 'stock.view'];
const MANAGER: Permission[] = [
  ...ATTENDANT,
  'products.edit',
  'stock.receive',
  'stock.adjust',
  'stock.convert',
  'stock.count',
  'sales.void',
  'payments.approve',
  'reports.view',
  'stock.transfer',
  'field.settle',
];
const OWNER: Permission[] = [
  ...MANAGER,
  'costs.view',
  'staff.manage',
  'devices.manage',
  'subscription.manage',
  'shopkey.manage',
  'locations.manage',
];

export const PRESET_PERMISSIONS: Record<RolePreset, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER),
  MANAGER: new Set(MANAGER),
  ATTENDANT: new Set(ATTENDANT),
  FIELD_ATTENDANT: new Set(FIELD_ATTENDANT),
};

const KNOWN = new Set<string>(PERMISSIONS);

/**
 * Preset plus extra permissions. Unknown strings are ignored, an attendant
 * never gets stock.convert, and a field attendant never gets any extra, even
 * if one was stored (rejected on write by the staff API, ignored here on read).
 */
export function effectivePermissions(preset: RolePreset, extras: readonly string[] | null): ReadonlySet<Permission> {
  const result = new Set<Permission>(PRESET_PERMISSIONS[preset]);
  if (preset === 'FIELD_ATTENDANT') return result;
  for (const extra of extras ?? []) {
    if (!KNOWN.has(extra)) continue;
    if (preset === 'ATTENDANT' && extra === 'stock.convert') continue;
    result.add(extra as Permission);
  }
  return result;
}
