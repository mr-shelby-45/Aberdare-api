// The notification types of Phase F (docs/phase-f-design.md section 6) and
// the only data keys each may carry: ids, counts, enums and flags, never
// names, notes, phone numbers, PINs, codes or a customer's payment amounts.
// Kept in step with the notification_type_known database check.

export const NOTIFICATION_TYPES = ['sale.flagged', 'stock.converted', 'approval.used', 'settlement.variance', 'device.stale'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const CHANNELS = ['IN_APP', 'PUSH', 'SMS', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];

export const DATA_KEYS: Record<NotificationType, readonly string[]> = {
  'sale.flagged': ['sale_id', 'sale_number', 'flags'],
  'stock.converted': ['conversion_id', 'converter_membership_id'],
  'approval.used': ['approval_id', 'purpose', 'requester_membership_id', 'approver_membership_id', 'target_id'],
  'settlement.variance': ['settlement_id', 'attendant_membership_id', 'cash_variance', 'lines_with_variance'],
  'device.stale': ['device_id', 'membership_id', 'days'],
};

/** A data value: an id, enum or money text (at most 100 characters), a whole number, a flag, or a short list of enums. */
export type DataValue = string | number | boolean | string[];
export type NotificationData = Record<string, DataValue>;

/** Throws on a type, key or value outside the rules above (a programming error, never shop input). */
export function checkNotification(type: string, dedupeKey: string, data: NotificationData): asserts type is NotificationType {
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) throw new Error(`notification type not known: ${type}`);
  if (dedupeKey.length < 1 || dedupeKey.length > 200) throw new Error('notification dedupe key must be 1 to 200 characters');
  const allowed = DATA_KEYS[type as NotificationType];
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.includes(key)) throw new Error(`notification data key not allowed for ${type}: ${key}`);
    const ok =
      (typeof value === 'string' && value.length <= 100) ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.length <= 10 && value.every((v) => typeof v === 'string' && v.length <= 40));
    if (!ok) throw new Error(`notification data value not allowed: ${key}`);
  }
}
