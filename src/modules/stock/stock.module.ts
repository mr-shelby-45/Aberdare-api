import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { LocationsModule } from '../locations/locations.module.js';
import { StockIntegrityService } from './stock-integrity.service.js';
import { StockReadsRepository } from './stock-reads.repository.js';
import { StockReadsService } from './stock-reads.service.js';
import { StockController } from './stock.controller.js';
import { StockRepository } from './stock.repository.js';
import { StockService } from './stock.service.js';

// The ledger and the stock reads. Phase B uses StockService.hasMovements (the
// units lock); C1 adds the integrity check; C2 the reads. The stock commands
// live in StockCommandsModule, above this one and the catalogue.
@Module({
  // Phase T2: the location scope for the reads. LocationsModule imports no stock module.
  imports: [LocationsModule],
  controllers: [StockController],
  providers: [StockService, StockRepository, StockIntegrityService, StockReadsService, StockReadsRepository, SignedCursor],
  exports: [StockService, StockIntegrityService],
})
export class StockModule {}
