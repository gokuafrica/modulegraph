import { NestFactory } from '@nestjs/core';
import { Type, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as minimist from 'minimist';
import { AcmeLogger } from '@acme/nestjs-logging';
import { AppModule } from './app.module';
import { StaleReviewPollerModule } from './jobs/stale-review-poller/stale-review-poller.module';
import { RecordStatusBackfillModule } from './jobs/record-status-backfill/record-status-backfill.module';

const JOBS: Record<string, Type<unknown>> = {
  'stale-review-poller': StaleReviewPollerModule,
  'record-status-backfill': RecordStatusBackfillModule,
};

async function bootstrap() {
  const argv = minimist(process.argv.slice(2));
  const jobName = argv._[0];

  if (jobName) {
    const jobModule = JOBS[jobName];
    if (!jobModule) {
      throw new Error(`Unknown job "${jobName}". Known jobs: ${Object.keys(JOBS).join(', ')}`);
    }
    const app = await NestFactory.createApplicationContext(jobModule, { bufferLogs: true });
    app.useLogger(app.get(AcmeLogger));
    app.enableShutdownHooks();
    return;
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AcmeLogger));
  app.setGlobalPrefix('api', { exclude: ['metrics', 'health'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('User records service')
    .setDescription('Manual review of user records')
    .setVersion('3')
    .addApiKey({ type: 'apiKey', name: 'x-internal-api-key', in: 'header' }, 'internal')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
