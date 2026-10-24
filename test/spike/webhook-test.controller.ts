import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiError } from '../../src/common/errors/api.error.js';
import { secretMatches } from '../../src/common/security/path-secret.js';

// Fixed test value; real webhook secrets will come from configuration.
export const TEST_WEBHOOK_SECRET = 'whsec_test_9f2c41d7a8b3e6f0c5d1';

// Spike step 5 only: POST /webhooks/test/:secret
@Controller('webhooks/test')
export class WebhookTestController {
  @Post(':secret')
  @HttpCode(200)
  receive(@Param('secret') secret: string) {
    if (!secretMatches(secret, TEST_WEBHOOK_SECRET)) {
      // Exactly what an unknown route returns, so the route's existence is hidden.
      throw new ApiError(404, 'NOT_FOUND', 'Not found');
    }
    return { received: true };
  }
}
