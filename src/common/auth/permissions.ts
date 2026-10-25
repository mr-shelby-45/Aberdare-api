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
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RolePreset = 'OWNER' | 'MANAGER' | 'ATTENDANT';

const ATTENDANT: Permission[] = ['sales.create', 'payments.confirm', 'stock.view', 'orders.manage'];
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
};

const KNOWN = new Set<string>(PERMISSIONS);

/**
 * Preset plus extra permissions. Unknown strings are ignored, and an
 * attendant never gets stock.convert, even if it was stored as an extra
 * (rejected on write in A4, ignored here on read).
 */
export function effectivePermissions(preset: RolePreset, extras: readonly string[] | null): ReadonlySet<Permission> {
  const result = new Set<Permission>(PRESET_PERMISSIONS[preset]);
  for (const extra of extras ?? []) {
    if (!KNOWN.has(extra)) continue;
    if (preset === 'ATTENDANT' && extra === 'stock.convert') continue;
    result.add(extra as Permission);
  }
  return result;
}
