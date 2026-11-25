import 'reflect-metadata';
import { Controller, Get, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Database } from './database';
import { Approvals, ApprovalsController } from './approvals';
import { Identity, IdentityController, JwtGuard } from './identity';

@Controller('health')
class HealthController {
  @Get() check() {
    return { status: 'ok', service: 'aprovacao-api' };
  }
}

@Module({
  controllers: [HealthController, ApprovalsController, IdentityController],
  providers: [Database, Approvals, Identity, JwtGuard],
})
export class AppModule {}

export async function createApplication() {
  for (const key of ['JWT_SECRET', 'BOOTSTRAP_KEY']) {
    if (!process.env[key] || process.env[key]!.length < 32)
      throw new Error(key + ' deve conter pelo menos 32 caracteres');
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  const options = new DocumentBuilder()
    .setTitle('aprovacao-api')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Bootstrap-Key' },
      'bootstrap',
    )
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, options), {
    customSiteTitle: 'aprovacao-api | API',
  });
  return app;
}
