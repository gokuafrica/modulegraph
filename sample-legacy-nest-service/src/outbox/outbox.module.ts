import { Module } from '@nestjs/common';
import { OutboxEventsService } from './services/outbox-events.service';
import { SyncedMessageService } from './services/synced-message.service';

@Module({ providers: [OutboxEventsService, SyncedMessageService], exports: [OutboxEventsService, SyncedMessageService] })
export class OutboxModule {}
