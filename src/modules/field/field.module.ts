import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { AuditModule } from '../audit/audit.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { FieldSettlementsModule } from '../field-settlements/field-settlements.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { StockModule } from '../stock/stock.module.js';
import { CloseSettlementHandler } from './commands/close-settlement.handler.js';
import { FieldController } from './field.controller.js';
import { FieldService } from './field.service.js';

// Field sales settlements (Phase T4): preview, close and reads. Sits above
// every module it reads through (none of them imports it); the sync module
// imports the close handler.
@Module({
  imports: [FieldSettlementsModule, LocationsModule, StockModule, ProductsModule, SalesModule, PaymentsModule, DevicesModule, StaffModule, AuditModule],
  controllers: [FieldController],
  providers: [FieldService, CloseSettlementHandler, SignedCursor],
  exports: [CloseSettlementHandler],
})
export class FieldModule {}
