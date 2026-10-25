import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/app.config.js';
import { createApp } from './create-app.js';

async function bootstrap(): Promise<void> {
  // Local development reads .env (Node's built-in loader, no dotenv). Real
  // environment variables, as on a server, are not overridden by it.
  if (existsSync('.env')) process.loadEnvFile('.env');
  // Stops here with a clear message if any setting is invalid.
  const config = loadConfig();
  const app = await createApp(AppModule, config);
  // Fastify only listens on 127.0.0.1 by default; 0.0.0.0 is needed inside containers.
  await app.listen(config.port, '0.0.0.0');
}
await bootstrap();
