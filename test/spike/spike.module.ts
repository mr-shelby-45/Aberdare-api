import { Module } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { SpikeController } from './spike.controller.js';
import { WebhookTestController } from './webhook-test.controller.js';

// The real app plus the spike step 5 test routes.
@Module({
  imports: [AppModule],
  controllers: [SpikeController, WebhookTestController],
})
export class SpikeModule {}
