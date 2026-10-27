import { Module } from '@nestjs/common';
import { FieldSettlementsRepository } from './field-settlements.repository.js';
import { FieldSettlementsService } from './field-settlements.service.js';

// Phase T4: the settlement tables. A data module with no feature imports;
// SalesModule (AFTER_SETTLEMENT) and FieldModule import it.
@Module({
  providers: [FieldSettlementsService, FieldSettlementsRepository],
  exports: [FieldSettlementsService],
})
export class FieldSettlementsModule {}
