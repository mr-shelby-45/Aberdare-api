import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { DatabaseModule } from '../../database/database.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

// Notifications (Phase F2). A data module: imports staff (a data module) and
// the database layer only, so the modules that will notify in F4 (sales,
// stock, approvals, field) can import it without a cycle.
@Module({
  imports: [DatabaseModule, StaffModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository, SignedCursor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
