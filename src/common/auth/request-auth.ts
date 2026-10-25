import type { FastifyRequest } from 'fastify';
import type { Permission, RolePreset } from './permissions.js';

/** What a verified access token says. Set by AuthGuard. */
export interface RequestAuth {
  personId: string;
  membershipId: string;
  businessId: string;
  deviceId: string;
}

/** The live session, loaded inside the tenant transaction. Set by TenantInterceptor. */
export interface RequestSession {
  membership: { id: string; personId: string; displayName: string; rolePreset: RolePreset; status: string };
  device: { id: string; name: string; isShared: boolean };
  permissions: ReadonlySet<Permission>;
}

export type AuthedRequest = FastifyRequest & { auth?: RequestAuth; session?: RequestSession };
