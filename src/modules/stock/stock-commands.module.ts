import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { ProductsModule } from '../products/products.module.js';
import { AdjustStockHandler } from './commands/adjust-stock.handler.js';
import { ReceiveStockHandler } from './commands/receive-stock.handler.js';
import { StockCommandsService } from './stock-commands.service.js';
import { StockModule } from './stock.module.js';

// The stock commands (Phase C2, decided with Ian). They need products and
// locations, and ProductsModule already imports StockModule (the units lock),
// so they live in this module above all three instead of in StockModule,
// which would make a cycle. The sync module imports the handlers.
@Module({
  imports: [StockModule, ProductsModule, LocationsModule, AuditModule],
  providers: [StockCommandsService, ReceiveStockHandler, AdjustStockHandler],
  exports: [ReceiveStockHandler, AdjustStockHandler],
})
export class StockCommandsModule {}
