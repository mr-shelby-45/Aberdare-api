import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app.config.js';
import { CodeHasher } from './auth/code-hasher.js';
import { PasswordHasher } from './auth/password-hasher.js';
import { Clock } from './time/clock.js';

// Available everywhere: the validated configuration, the clock and the hashers.
// createApp() adds it around the root module with the config it loaded.
@Global()
@Module({})
export class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: AppConfig, useValue: config }, Clock, PasswordHasher, CodeHasher],
      exports: [AppConfig, Clock, PasswordHasher, CodeHasher],
    };
  }
}
