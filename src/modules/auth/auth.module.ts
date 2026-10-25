import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../../database/database.module.js';
import { MessagingModule } from '../../integrations/messaging.module.js';
import { BusinessModule } from '../business/business.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { ChallengeService } from './challenge.service.js';
import { PurposeTokenService } from './purpose-token.service.js';
import { RefreshTokenRepository } from './refresh-token.repository.js';
import { SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';
import { TokenService } from './token.service.js';

@Module({
  // The JWT secret is passed on every sign and verify call, from AppConfig.
  imports: [DatabaseModule, MessagingModule, BusinessModule, StaffModule, DevicesModule, JwtModule.register({})],
  controllers: [SignupController],
  providers: [SignupService, ChallengeService, PurposeTokenService, TokenService, RefreshTokenRepository],
})
export class AuthModule {}
