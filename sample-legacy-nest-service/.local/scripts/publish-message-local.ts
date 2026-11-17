/**
 * Publishes one message to a local Kafka, for trying a consumer by hand:
 *   npx ts-node .local/scripts/publish-message-local.ts review-tools.tag-added.v1 '{"recordGuid":"…","tag":"vip"}'
 */
import { NestFactory } from '@nestjs/core';
import { KafkaJsService } from '@acme/nestjs-kafkajs';
import { AppModule } from '../../src/app.module';

async function main() {
  const [topic, json] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppModule);
  const producer = app.get(KafkaJsService).producer({ allowAutoTopicCreation: true });
  await producer.send({ subject: `${topic}-value`, topic, messages: [{ key: 'local', value: JSON.parse(json) }] });
  await producer.disconnect();
  await app.close();
}

main();
