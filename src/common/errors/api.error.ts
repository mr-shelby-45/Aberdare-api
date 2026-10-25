import { HttpException } from '@nestjs/common';

// An error we chose to send: status, stable code, and a message that is safe
// to show to a user (docs/architecture.md section 11). Optional headers, for
// example Retry-After on ACCOUNT_LOCKED, are added to the response.
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super({ code, message }, status);
  }
}
