import { NestFactory, NestApplication } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as minimist from 'minimist';
import { AcmeLogger } from '@acme/nestjs-logging';
import { AppModule } from './app.module';
import { ConsumerHandlerMap } from './consumers/consumer-handler.map';
import { ConsumersManagerService } from './consumers/services/consumers-manager.service';
import { StaleReviewPollerModule } from './jobs/stale-review-poller/stale-review-poller.module';
import { RecordStatusBackfillModule } from './jobs/record-status-backfill/record-status-backfill.module';
import { DuplicateScanModule } from './jobs/duplicate-scan/duplicate-scan.module';
import { AuditLogRetentionModule } from './jobs/audit-log-retention/audit-log-retention.module';
import { ManualDataReencryptModule } from './jobs/manual-data-reencrypt/manual-data-reencrypt.module';
import { EscalationDigestModule } from './jobs/escalation-digest/escalation-digest.module';
import { TagCleanupModule } from './jobs/tag-cleanup/tag-cleanup.module';

async function bootstrap() {
  const args = minimist(process.argv.slice(2));
  const command = args['_'][0];

  if (['stale-review-poller', 'record-status-backfill', 'duplicate-scan', 'audit-log-retention', 'manual-data-reencrypt', 'escalation-digest', 'tag-cleanup'].includes(command)) {
    const modules = {
      'stale-review-poller': StaleReviewPollerModule,
      'record-status-backfill': RecordStatusBackfillModule,
      'duplicate-scan': DuplicateScanModule,
      'audit-log-retention': AuditLogRetentionModule,
      'manual-data-reencrypt': ManualDataReencryptModule,
      'escalation-digest': EscalationDigestModule,
      'tag-cleanup': TagCleanupModule,
    };
    const app: NestApplication = await NestFactory.create(modules[command].register());
    app.enableShutdownHooks();
    try {
      await app.init();
    } finally {
      await app.close();
    }
    return;
  }

  const consumers = command?.split(',').map((arg) => ConsumerHandlerMap.get(arg));

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
  await app.get(ConsumersManagerService).start(consumers?.filter(Boolean) ?? []);
}

bootstrap();
