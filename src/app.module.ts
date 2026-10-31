import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { TeamModule } from './modules/team/team.module.js';

@Module({
  imports: [HealthModule, AuthModule, TeamModule, LocationsModule, SyncModule, NotificationsModule],
})
export class AppModule {}
