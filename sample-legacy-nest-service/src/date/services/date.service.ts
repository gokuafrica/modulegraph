import { Injectable } from '@nestjs/common';

@Injectable()
export class DateService {
  /** The current time. Injected so tests can freeze it. */
  now(): Date {
    return new Date();
  }

  /** `date` moved by a number of hours (negative goes back). */
  addHours(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 3600_000);
  }

  toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
