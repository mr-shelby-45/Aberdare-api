import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { DatabaseModule } from '../../database/database.module.js';
import { MessagingModule } from '../../integrations/messaging.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { NotificationDeliveryService } from './notification-delivery.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

// Notifications (Phase F2; delivery F3). Imports only data modules (staff,
// devices), the senders and the database layer, so the modules that will
// notify in F4 (sales, stock, approvals, field) can import it without a cycle.
@Module({
  imports: [DatabaseModule, StaffModule, DevicesModule, MessagingModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDeliveryService, NotificationsRepository, SignedCursor],
  exports: [NotificationsService, NotificationDeliveryService],
})
export class NotificationsModule {}
