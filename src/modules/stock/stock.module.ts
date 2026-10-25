import { Module } from '@nestjs/common';
import { StockRepository } from './stock.repository.js';
import { StockService } from './stock.service.js';

// Phase B uses only StockService.hasMovements (the units lock). The stock
// commands themselves are Phase C.
@Module({
  providers: [StockService, StockRepository],
  exports: [StockService],
})
export class StockModule {}
