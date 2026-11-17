import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJsModule } from '@acme/nestjs-kafkajs';
import { OutboxWriterModule } from '@acme/typeorm-outbox-writer';

@Module({
  imports: [
    KafkaJsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        clientId: config.get('kafka.clientId'),
        brokers: config.get('kafka.brokers'),
        schemaRegistryUrl: config.get('kafka.schemaRegistryUrl'),
      }),
    }),
    OutboxWriterModule.forRoot({ table: 'outbox_events', source: 'user-records-service' }),
  ],
})
export class MessagingModule {}
