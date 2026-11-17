import { Injectable } from '@nestjs/common';

export const NOTIFIER = Symbol('NOTIFIER');

export abstract class Notifier {
  abstract send(message: string): Promise<void>;
}

/** Built by a factory provider in AppModule (useFactory returns a new EmailNotifier). */
@Injectable()
export class EmailNotifier extends Notifier {
  async send(message: string): Promise<void> {
    await fetch('https://mail.example.com/v1/send', { method: 'POST', body: message });
  }
}

/** Another implementation nothing binds. */
@Injectable()
export class SmsNotifier extends Notifier {
  async send(message: string): Promise<void> {
    await fetch('https://sms.example.com/v1/send', { method: 'POST', body: message });
  }
}
