import type { NotificationData } from './notification-types.js';

// The short English text of a notification, rendered from its type and data
// at read time (docs/phase-f-design.md section 5). Data holds ids and counts
// only, so a message can never contain a name, note, code or secret. The phone
// may render its own language from type and data instead.

const FLAG_TEXT: Record<string, string> = {
  TOTAL_MISMATCH: 'Total did not match',
  STOCK_NEGATIVE: 'Stock went negative',
  DUPLICATE_MPESA_CODE: 'M-Pesa code used before',
  OVERPAYMENT: 'Overpaid',
  AFTER_SETTLEMENT: 'After settlement',
};
const PURPOSE_TEXT: Record<string, string> = {
  STOCK_CONVERT: 'a stock conversion',
  SALE_VOID: 'a sale void',
};

export function notificationMessage(type: string, data: NotificationData): string {
  switch (type) {
    case 'sale.flagged': {
      const flags = Array.isArray(data.flags) ? data.flags.map((f) => FLAG_TEXT[f] ?? 'Needs checking') : [];
      const number = typeof data.sale_number === 'number' ? `#${data.sale_number} ` : '';
      return flags.length > 0 ? `Sale ${number}was flagged: ${flags.join(', ')}.` : `Sale ${number}was flagged.`;
    }
    case 'stock.converted':
      return 'A pack was broken into smaller units.';
    case 'approval.used':
      return `Your PIN approved ${PURPOSE_TEXT[String(data.purpose)] ?? 'an action'}.`;
    case 'settlement.variance': {
      const lines = typeof data.lines_with_variance === 'number' ? data.lines_with_variance : 0;
      const cash = typeof data.cash_variance === 'string' ? ` of KES ${data.cash_variance}` : '';
      return `A field settlement closed with a cash variance${cash} and ${lines} ${lines === 1 ? 'line' : 'lines'} with a count difference.`;
    }
    case 'device.stale': {
      const days = typeof data.days === 'number' ? data.days : 0;
      return `A phone has not synced for ${days} ${days === 1 ? 'day' : 'days'}.`;
    }
    default:
      return 'Something needs checking.';
  }
}
