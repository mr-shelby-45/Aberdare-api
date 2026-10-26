import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StockModule } from '../stock/stock.module.js';
import { AttachPaymentHandler } from './commands/attach-payment.handler.js';
import { CreateSaleHandler } from './commands/create-sale.handler.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';

// Sales (Phase E). Sits above stock, products, locations and payments (none
// of them imports it); the sync module imports the command handlers.
@Module({
  imports: [StockModule, ProductsModule, LocationsModule, PaymentsModule, AuditModule],
  providers: [SalesService, SalesRepository, CreateSaleHandler, AttachPaymentHandler],
  exports: [CreateSaleHandler, AttachPaymentHandler],
})
export class SalesModule {}
