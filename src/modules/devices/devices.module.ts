import { Module } from '@nestjs/common';
import { DevicesRepository } from './devices.repository.js';
import { DevicesService } from './devices.service.js';

@Module({
  providers: [DevicesService, DevicesRepository],
  exports: [DevicesService],
})
export class DevicesModule {}
