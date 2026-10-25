import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, from, lastValueFrom } from 'rxjs';
import { type Permission, type RolePreset, effectivePermissions } from '../../common/auth/permissions.js';
import { IS_PUBLIC } from '../../common/auth/public.decorator.js';
import type { AuthedRequest, RequestAuth, RequestSession } from '../../common/auth/request-auth.js';
import { REQUIRED_PERMISSIONS } from '../../common/auth/require-permission.decorator.js';
import { OWN_TRANSACTIONS } from '../../common/auth/own-transactions.decorator.js';
import { type RequestContext, runWithRequestContext } from '../../common/context/request-context.js';
import { ApiError } from '../../common/errors/api.error.js';
import { TenantRunner } from '../../database/tenant.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService } from '../staff/staff.service.js';

// Global interceptor (docs/phase-a-design.md section 8, step 3). Runs every
// protected request inside one tenant transaction for the token's business.
// Its first queries load the live membership and device; then it checks the
// route's @RequirePermission; then the handler runs in the same transaction.
// So suspending someone, revoking a device or changing a permission takes
// effect on the very next request.
// It also opens the request context (caller IP, acting membership) for the
// audit log, on public routes too. That lives here rather than in a second
// global interceptor because Nest does not document the order of global
// interceptors, and the actor is only known after loadSession.
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantRunner,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const requestContext: RequestContext = { ip: request.ip ?? null, actorMembershipId: null };
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return from(
        runWithRequestContext(requestContext, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
      );
    }
    const auth = request.auth;
    if (!auth) throw new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];

    if (this.reflector.getAllAndOverride<boolean>(OWN_TRANSACTIONS, targets)) {
      // Same checks in a short transaction of their own, then the handler runs
      // outside any transaction and opens one per unit of work (one per sync
      // command). A suspended member is refused here, before anything runs.
      return from(
        runWithRequestContext(requestContext, async () => {
          const session = await this.tenants.run(auth.businessId, () => this.loadSession(auth));
          requestContext.actorMembershipId = session.membership.id;
          for (const permission of required) {
            if (!session.permissions.has(permission)) {
              throw new ApiError(403, 'PERMISSION_DENIED', 'You are not allowed to do this.');
            }
          }
          request.session = session;
          return lastValueFrom(next.handle(), { defaultValue: undefined });
        }),
      );
    }

    return from(
      runWithRequestContext(requestContext, () => this.tenants.run(auth.businessId, async () => {
        const session = await this.loadSession(auth);
        requestContext.actorMembershipId = session.membership.id;
        for (const permission of required) {
          if (!session.permissions.has(permission)) {
            throw new ApiError(403, 'PERMISSION_DENIED', 'You are not allowed to do this.');
          }
        }
        request.session = session;
        // The handler subscribes here, so all its work runs inside this transaction.
        return lastValueFrom(next.handle(), { defaultValue: undefined });
      })),
    );
  }

  private async loadSession(auth: RequestAuth): Promise<RequestSession> {
    const membership = await this.staff.findForSession(auth.membershipId);
    if (!membership || membership.personId !== auth.personId || membership.status !== 'ACTIVE') {
      throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Your access to this business is not active.');
    }
    const device = await this.devices.findForSession(auth.deviceId);
    if (!device || device.status !== 'ACTIVE' || !(await this.devices.belongsTo(device, membership.id))) {
      throw new ApiError(403, 'DEVICE_REVOKED', 'This device is no longer allowed. Please log in again.');
    }
    const rolePreset = membership.rolePreset as RolePreset;
    return {
      membership: {
        id: membership.id,
        personId: membership.personId,
        displayName: membership.displayName,
        rolePreset,
        status: membership.status,
      },
      device: { id: device.id, name: device.name, isShared: device.isShared },
      permissions: effectivePermissions(rolePreset, membership.extraPermissions),
    };
  }
}
