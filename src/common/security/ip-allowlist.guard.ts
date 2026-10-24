import { type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { BlockList } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors/api.error.js';
import { listContains, toBlockList } from './address-list.js';

export interface IpAllowlistOptions {
  allowlist: readonly string[];
  // log: let everyone through, log those outside the list (the starting mode
  // for Safaricom callbacks, docs/architecture.md section 8). enforce: block them.
  mode: 'log' | 'enforce';
}

// Checks request.ip, which is only the real client address behind a load
// balancer when TRUST_PROXY is set correctly (see AppConfig.trustProxy).
export class IpAllowlistGuard implements CanActivate {
  private readonly list: BlockList;

  constructor(private readonly options: IpAllowlistOptions) {
    this.list = toBlockList(options.allowlist);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (listContains(this.list, request.ip)) return true;

    request.log.warn(
      { sourceIp: request.ip, mode: this.options.mode },
      'request from outside the IP allowlist',
    );
    if (this.options.mode === 'enforce') {
      throw new ApiError(403, 'FORBIDDEN', 'Not allowed');
    }
    return true;
  }
}
