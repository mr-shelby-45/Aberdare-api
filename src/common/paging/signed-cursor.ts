import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app.config.js';

/** What a cursor carries: the last row's sort keys and the filters it was issued for. */
export type CursorValues = Record<string, string | boolean | null>;

/**
 * The opaque paging cursor of the list endpoints (signed as decided in B4,
 * shared since C2): base64url JSON of a kind (which list) and its values, then
 * a dot and an HMAC-SHA256. The key is derived from AUTH_PEPPER, so no new
 * setting. A cursor that was tampered with, truncated, or issued by another
 * list is refused (null), never trusted. Callers still check each value's
 * type and compare the filters with the current request.
 */
@Injectable()
export class SignedCursor {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = createHmac('sha256', config.authPepper).update('list-cursor/v2').digest();
  }

  sign(kind: string, values: CursorValues): string {
    const body = Buffer.from(JSON.stringify({ k: kind, v: values })).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }

  read(kind: string, cursor: string): CursorValues | null {
    const [body, mac, extra] = cursor.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const given = Buffer.from(mac, 'base64url');
    const expected = this.mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const p = parsed as { k?: unknown; v?: unknown };
    if (p.k !== kind || typeof p.v !== 'object' || p.v === null || Array.isArray(p.v)) return null;
    return p.v as CursorValues;
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body).digest();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor value that must be a UUID, or null when it is not. */
export function cursorUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
