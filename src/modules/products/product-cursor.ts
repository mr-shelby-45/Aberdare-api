import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app.config.js';

export interface CursorPosition {
  name: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The opaque paging cursor of GET /v1/products (docs/phase-b-design.md
 * section 6, signed as decided in B4): base64url JSON of the last row's name
 * and id plus the include_archived it was issued for, then a dot and an
 * HMAC-SHA256. The key is derived from AUTH_PEPPER, so no new setting.
 * Anything tampered, truncated or reused with another include_archived is
 * refused (null), never trusted.
 */
@Injectable()
export class ProductCursor {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = createHmac('sha256', config.authPepper).update('product-list-cursor/v1').digest();
  }

  sign(position: CursorPosition, includeArchived: boolean): string {
    const body = Buffer.from(JSON.stringify({ v: 1, n: position.name, i: position.id, a: includeArchived })).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }

  read(cursor: string, includeArchived: boolean): CursorPosition | null {
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
    const p = parsed as { v?: unknown; n?: unknown; i?: unknown; a?: unknown };
    if (p.v !== 1 || typeof p.n !== 'string' || typeof p.i !== 'string' || !UUID.test(p.i) || p.a !== includeArchived) {
      return null;
    }
    return { name: p.n, id: p.i };
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body).digest();
  }
}
