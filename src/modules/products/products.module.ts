import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StockModule } from '../stock/stock.module.js';
import { BarcodesRepository } from './barcodes.repository.js';
import { CreateProductHandler } from './commands/create-product.handler.js';
import { UpdateProductHandler } from './commands/update-product.handler.js';
import { UpsertPackTypeHandler } from './commands/upsert-pack-type.handler.js';
import { PackTypesRepository } from './pack-types.repository.js';
import { ProductsRepository } from './products.repository.js';
import { ProductsService } from './products.service.js';

// Products, pack types and barcodes (Phase B). Writes arrive only as sync
// commands; the handlers are exported for the sync module.
@Module({
  imports: [AuditModule, StockModule],
  providers: [
    ProductsService,
    ProductsRepository,
    PackTypesRepository,
    BarcodesRepository,
    CreateProductHandler,
    UpdateProductHandler,
    UpsertPackTypeHandler,
  ],
  exports: [CreateProductHandler, UpdateProductHandler, UpsertPackTypeHandler],
})
export class ProductsModule {}
