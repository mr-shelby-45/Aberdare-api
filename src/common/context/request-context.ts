import { AsyncLocalStorage } from 'node:async_hooks';

// Who is calling and from where, for the audit log (docs/phase-a-design.md
// section 14). TenantInterceptor opens it for every request, public or
// protected, and fills in the actor once the live session is loaded. Code
// outside a request (tests, the future worker) simply has no context.
export interface RequestContext {
  ip: string | null;
  // The membership acting in this request. Null on public routes.
  actorMembershipId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
