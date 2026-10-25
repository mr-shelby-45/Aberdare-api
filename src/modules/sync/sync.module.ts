import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ProductsModule } from '../products/products.module.js';
import { CatalogueHandlers } from './catalogue-handlers.js';
import { SyncController } from './sync.controller.js';
import { SyncRepository } from './sync.repository.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [DatabaseModule, ProductsModule],
  controllers: [SyncController],
  providers: [SyncService, SyncRepository, CatalogueHandlers],
})
export class SyncModule {}
