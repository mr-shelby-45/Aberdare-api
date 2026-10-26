import { Module } from '@nestjs/common';
import { PaymentsRepository } from './payments.repository.js';
import { PaymentsService } from './payments.service.js';

// Payments (Phase E3): the payment table only. A data module with no feature
// imports; SalesModule imports it.
@Module({
  providers: [PaymentsService, PaymentsRepository],
  exports: [PaymentsService],
})
export class PaymentsModule {}
