import { Module } from '@nestjs/common';
import { StockIntegrityService } from './stock-integrity.service.js';
import { StockRepository } from './stock.repository.js';
import { StockService } from './stock.service.js';

// Phase B uses StockService.hasMovements (the units lock). Phase C1 adds the
// integrity check; the stock commands come in C2 to C5.
@Module({
  providers: [StockService, StockRepository, StockIntegrityService],
  exports: [StockService, StockIntegrityService],
})
export class StockModule {}
