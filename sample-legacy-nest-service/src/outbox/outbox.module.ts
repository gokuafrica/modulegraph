import { Module } from '@nestjs/common';
import { OutboxEventsService } from './services/outbox-events.service';

@Module({ providers: [OutboxEventsService], exports: [OutboxEventsService] })
export class OutboxModule {}
