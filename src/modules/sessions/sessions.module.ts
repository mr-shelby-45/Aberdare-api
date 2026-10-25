import { Module } from '@nestjs/common';
import { RefreshTokenRepository } from './refresh-token.repository.js';
import { RefreshTokensService } from './refresh-tokens.service.js';

@Module({
  providers: [RefreshTokensService, RefreshTokenRepository],
  exports: [RefreshTokensService],
})
export class SessionsModule {}
