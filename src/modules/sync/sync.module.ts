import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StockCommandsModule } from '../stock/stock-commands.module.js';
import { CommandHandlers } from './command-handlers.js';
import { SyncController } from './sync.controller.js';
import { SyncRepository } from './sync.repository.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [DatabaseModule, ProductsModule, StockCommandsModule],
  controllers: [SyncController],
  providers: [SyncService, SyncRepository, CommandHandlers],
})
export class SyncModule {}
