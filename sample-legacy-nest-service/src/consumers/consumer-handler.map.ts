import { Type } from '@nestjs/common';
import { BaseConsumerHandler } from './base/base-consumer.handler';
import { AddressVerifiedHandler } from './handlers/address-verified.handler';
import { AgentAssignedHandler } from './handlers/agent-assigned.handler';
import { CommentAddedHandler } from './handlers/comment-added.handler';
import { ConsentWithdrawnHandler } from './handlers/consent-withdrawn.handler';
import { DocumentDeletedHandler } from './handlers/document-deleted.handler';
import { DocumentUploadedHandler } from './handlers/document-uploaded.handler';
import { EscalationRequestedHandler } from './handlers/escalation-requested.handler';
import { IdentityVerifiedHandler } from './handlers/identity-verified.handler';
import { RecordDuplicateDetectedHandler } from './handlers/record-duplicate-detected.handler';
import { RecordLockedHandler } from './handlers/record-locked.handler';
import { RecordUnlockedHandler } from './handlers/record-unlocked.handler';
import { ReviewEscalatedHandler } from './handlers/review-escalated.handler';
import { ReviewNoteAddedHandler } from './handlers/review-note-added.handler';
import { ReviewReopenedHandler } from './handlers/review-reopened.handler';
import { RiskScoreChangedHandler } from './handlers/risk-score-changed.handler';
import { SyncAssignmentsFeatureHandler } from './handlers/sync-assignments-feature.handler';
import { SyncCommentsFeatureHandler } from './handlers/sync-comments-feature.handler';
import { SyncDocumentsFeatureHandler } from './handlers/sync-documents-feature.handler';
import { SyncEscalationsFeatureHandler } from './handlers/sync-escalations-feature.handler';
import { SyncTagsFeatureHandler } from './handlers/sync-tags-feature.handler';
import { TagAddedHandler } from './handlers/tag-added.handler';
import { TagRemovedHandler } from './handlers/tag-removed.handler';
import { UserDeletedHandler } from './handlers/user-deleted.handler';
import { UserMergedHandler } from './handlers/user-merged.handler';
import { UserRecordCreatedHandler } from './handlers/user-record-created.handler';
import { UserRecordDataUpdatedHandler } from './handlers/user-record-data-updated.handler';

export const ConsumerHandlerMap = new Map<string, Type<BaseConsumerHandler<any, any>>>([
  ['address-verified', AddressVerifiedHandler],
  ['agent-assigned', AgentAssignedHandler],
  ['comment-added', CommentAddedHandler],
  ['consent-withdrawn', ConsentWithdrawnHandler],
  ['document-deleted', DocumentDeletedHandler],
  ['document-uploaded', DocumentUploadedHandler],
  ['escalation-requested', EscalationRequestedHandler],
  ['identity-verified', IdentityVerifiedHandler],
  ['record-duplicate-detected', RecordDuplicateDetectedHandler],
  ['record-locked', RecordLockedHandler],
  ['record-unlocked', RecordUnlockedHandler],
  ['review-escalated', ReviewEscalatedHandler],
  ['review-note-added', ReviewNoteAddedHandler],
  ['review-reopened', ReviewReopenedHandler],
  ['risk-score-changed', RiskScoreChangedHandler],
  ['sync-feature-assignments', SyncAssignmentsFeatureHandler],
  ['sync-feature-comments', SyncCommentsFeatureHandler],
  ['sync-feature-documents', SyncDocumentsFeatureHandler],
  ['sync-feature-escalations', SyncEscalationsFeatureHandler],
  ['sync-feature-tags', SyncTagsFeatureHandler],
  ['tag-added', TagAddedHandler],
  ['tag-removed', TagRemovedHandler],
  ['user-deleted', UserDeletedHandler],
  ['user-merged', UserMergedHandler],
  ['user-record-created', UserRecordCreatedHandler],
  ['user-record-data-updated', UserRecordDataUpdatedHandler],
]);
