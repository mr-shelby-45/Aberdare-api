import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StockCommandsModule } from '../stock/stock-commands.module.js';
import { StockModule } from '../stock/stock.module.js';
import { ChangeFeedService } from './change-feed.service.js';
import { ChangeLogRepository } from './change-log.repository.js';
import { ChangesCursor } from './changes-cursor.js';
import { CommandHandlers } from './command-handlers.js';
import { SyncController } from './sync.controller.js';
import { ChangesService } from './changes.service.js';
import { SnapshotService } from './snapshot.service.js';
import { SyncTables } from './sync-tables.js';
import { SyncRepository } from './sync.repository.js';
import { SyncService } from './sync.service.js';

// Phone commands (Phase B) and, from Phase D, the change feed for the sync reads.
@Module({
  imports: [DatabaseModule, ProductsModule, StockCommandsModule, StockModule, LocationsModule, DevicesModule],
  controllers: [SyncController],
  providers: [SyncService, SyncRepository, CommandHandlers, SignedCursor, ChangesCursor, ChangeLogRepository, ChangeFeedService, SyncTables, SnapshotService, ChangesService],
})
export class SyncModule {}
