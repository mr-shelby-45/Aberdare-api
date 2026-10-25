import { Module } from '@nestjs/common';
import { BusinessRepository } from './business.repository.js';
import { BusinessService } from './business.service.js';

@Module({
  providers: [BusinessService, BusinessRepository],
  exports: [BusinessService],
})
export class BusinessModule {}
