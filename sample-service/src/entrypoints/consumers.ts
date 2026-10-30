import type { Modules } from '../app.ts';
import { KafkaConsumer, KafkaProducer } from '../platform/kafka.ts';

export function registerConsumers(consumer: KafkaConsumer, kafka: KafkaProducer, m: Modules): void {
  consumer.subscribe('user.documents.uploaded', async (msg) => {
    await m.kyc.runCheck(msg.userId as string);
  });

  consumer.subscribe('user.profile.changed', async (msg) => {
    const profile = await m.profile.getProfile(msg.userId as string);
    await kafka.produce('profile.snapshot.v1', profile);
  });

  consumer.subscribe('tax.year.closed', async (msg) => {
    await m.tax.assess(msg.userId as string);
  });

  consumer.subscribe('travel.booking.created', async (msg) => {
    await m.travel.checkVisa(msg.userId as string, msg.destination as string);
  });

  consumer.subscribe('user.deleted', async (msg) => {
    await m.profile.purge(msg.userId as string);
  });
}
