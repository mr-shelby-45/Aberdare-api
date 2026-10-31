import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProductsModule } from '../products/products.module.js';
import { AdjustStockHandler } from './commands/adjust-stock.handler.js';
import { ConvertStockHandler } from './commands/convert-stock.handler.js';
import { CountStockHandler } from './commands/count-stock.handler.js';
import { IssueStockHandler } from './commands/issue-stock.handler.js';
import { ReceiveStockHandler } from './commands/receive-stock.handler.js';
import { ReturnStockHandler } from './commands/return-stock.handler.js';
import { StockCommandsService } from './stock-commands.service.js';
import { StockModule } from './stock.module.js';

// The stock commands (Phase C2, decided with Ian). They need products and
// locations, and ProductsModule already imports StockModule (the units lock),
// so they live in this module above all three instead of in StockModule,
// which would make a cycle. The sync module imports the handlers.
@Module({
  imports: [StockModule, ProductsModule, LocationsModule, AuditModule, ApprovalsModule, NotificationsModule],
  providers: [StockCommandsService, ReceiveStockHandler, AdjustStockHandler, CountStockHandler, ConvertStockHandler, IssueStockHandler, ReturnStockHandler],
  exports: [ReceiveStockHandler, AdjustStockHandler, CountStockHandler, ConvertStockHandler, IssueStockHandler, ReturnStockHandler],
})
export class StockCommandsModule {}
