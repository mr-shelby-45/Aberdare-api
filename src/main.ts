import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  // Fastify only listens on 127.0.0.1 by default; 0.0.0.0 is needed inside containers.
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
await bootstrap();
