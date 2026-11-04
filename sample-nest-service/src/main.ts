import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module.ts';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: { client: { brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'] }, consumer: { groupId: 'order-service' } },
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: { package: 'orders.v1', protoPath: 'proto/orders.proto' },
  });
  await app.startAllMicroservices();
  await app.listen(3000);
}

void bootstrap();
