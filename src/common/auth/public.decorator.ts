import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * A route that needs no access token. Every other route is protected by the
 * global AuthGuard and runs inside the TenantInterceptor's transaction.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
