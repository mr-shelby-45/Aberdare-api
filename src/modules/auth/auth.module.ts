import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../../database/database.module.js';
import { MessagingModule } from '../../integrations/messaging.module.js';
import { BusinessModule } from '../business/business.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { AccessTokenService } from './access-token.service.js';
import { AuthGuard } from './auth.guard.js';
import { ChallengeService } from './challenge.service.js';
import { FirstLoginController } from './first-login.controller.js';
import { FirstLoginService } from './first-login.service.js';
import { LoginController } from './login.controller.js';
import { LoginService } from './login.service.js';
import { MeController } from './me.controller.js';
import { PinLoginService } from './pin-login.service.js';
import { PurposeTokenService } from './purpose-token.service.js';
import { SessionService } from './session.service.js';
import { SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';
import { TenantInterceptor } from './tenant.interceptor.js';
import { TokenService } from './token.service.js';

@Module({
  // The JWT secret is passed on every sign and verify call, from AppConfig.
  imports: [DatabaseModule, MessagingModule, BusinessModule, StaffModule, DevicesModule, SessionsModule, JwtModule.register({})],
  controllers: [SignupController, LoginController, FirstLoginController, MeController],
  providers: [
    SignupService,
    LoginService,
    PinLoginService,
    FirstLoginService,
    SessionService,
    ChallengeService,
    PurposeTokenService,
    AccessTokenService,
    TokenService,
    // Every route in the app: token check, then one tenant transaction with
    // the live membership, device and permissions (docs/phase-a-design.md section 8).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
  ],
})
export class AuthModule {}
