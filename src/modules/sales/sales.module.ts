import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { AuditModule } from '../audit/audit.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { StockModule } from '../stock/stock.module.js';
import { AttachPaymentHandler } from './commands/attach-payment.handler.js';
import { CreateSaleHandler } from './commands/create-sale.handler.js';
import { SalesReadsRepository } from './sales-reads.repository.js';
import { SalesReadsService } from './sales-reads.service.js';
import { SalesController } from './sales.controller.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';

// Sales (Phase E). Sits above stock, products, locations, payments and staff
// (none of them imports it); the sync module imports the command handlers
// and, from E4, the reads for its sync tables.
@Module({
  imports: [StockModule, ProductsModule, LocationsModule, PaymentsModule, StaffModule, AuditModule],
  controllers: [SalesController],
  providers: [SalesService, SalesRepository, SalesReadsService, SalesReadsRepository, SignedCursor, CreateSaleHandler, AttachPaymentHandler],
  exports: [CreateSaleHandler, AttachPaymentHandler, SalesReadsService],
})
export class SalesModule {}
