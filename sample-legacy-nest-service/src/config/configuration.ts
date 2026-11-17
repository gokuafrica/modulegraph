export interface ConsumerConfig {
  name: string;
  /** The handler class (ConsumerHandlerMap maps the command-line name to it). */
  handler: string;
  topic: string;
  groupId: string;
}

export interface KafkaTopicsConfig {
  RECORD_DUPLICATE_FOUND: string;
  AUDIT_EVENTS: string;
  MANUAL_DATA_REENCRYPTED: string;
}

export const configuration = () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  internalApiKey: process.env.INTERNAL_API_KEY,
  databases: {
    legacy: {
      host: process.env.LEGACY_DB_HOST,
      port: parseInt(process.env.LEGACY_DB_PORT, 10) || 3306,
      username: process.env.LEGACY_DB_USER,
      password: process.env.LEGACY_DB_PASSWORD,
      database: process.env.LEGACY_DB_NAME || 'records',
    },
    admin: {
      host: process.env.ADMIN_DB_HOST,
      port: parseInt(process.env.ADMIN_DB_PORT, 10) || 3306,
      username: process.env.ADMIN_DB_USER,
      password: process.env.ADMIN_DB_PASSWORD,
      database: process.env.ADMIN_DB_NAME || 'records_admin',
    },
  },
  kms: {
    region: process.env.AWS_REGION || 'eu-west-1',
    keyId: process.env.KMS_KEY_ID,
  },
  kafka: {
    clientId: 'user-records-service',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    schemaRegistryUrl: process.env.SCHEMA_REGISTRY_URL,
    consumers: [
      { name: 'address-verified', handler: 'AddressVerifiedHandler', topic: 'review-tools.address-verified.v1', groupId: 'user-records-service' },
      { name: 'agent-assigned', handler: 'AgentAssignedHandler', topic: 'review-tools.agent-assigned.v1', groupId: 'user-records-service' },
      { name: 'comment-added', handler: 'CommentAddedHandler', topic: 'review-tools.comment-added.v1', groupId: 'user-records-service' },
      { name: 'consent-withdrawn', handler: 'ConsentWithdrawnHandler', topic: 'review-tools.consent-withdrawn.v1', groupId: 'user-records-service' },
      { name: 'document-deleted', handler: 'DocumentDeletedHandler', topic: 'review-tools.document-deleted.v1', groupId: 'user-records-service' },
      { name: 'document-uploaded', handler: 'DocumentUploadedHandler', topic: 'review-tools.document-uploaded.v1', groupId: 'user-records-service' },
      { name: 'escalation-requested', handler: 'EscalationRequestedHandler', topic: 'review-tools.escalation-requested.v1', groupId: 'user-records-service' },
      { name: 'identity-verified', handler: 'IdentityVerifiedHandler', topic: 'review-tools.identity-verified.v1', groupId: 'user-records-service' },
      { name: 'record-duplicate-detected', handler: 'RecordDuplicateDetectedHandler', topic: 'review-tools.record-duplicate-detected.v1', groupId: 'user-records-service' },
      { name: 'record-locked', handler: 'RecordLockedHandler', topic: 'review-tools.record-locked.v1', groupId: 'user-records-service' },
      { name: 'record-unlocked', handler: 'RecordUnlockedHandler', topic: 'review-tools.record-unlocked.v1', groupId: 'user-records-service' },
      { name: 'review-escalated', handler: 'ReviewEscalatedHandler', topic: 'review-tools.review-escalated.v1', groupId: 'user-records-service' },
      { name: 'review-note-added', handler: 'ReviewNoteAddedHandler', topic: 'review-tools.review-note-added.v1', groupId: 'user-records-service' },
      { name: 'review-reopened', handler: 'ReviewReopenedHandler', topic: 'review-tools.review-reopened.v1', groupId: 'user-records-service' },
      { name: 'risk-score-changed', handler: 'RiskScoreChangedHandler', topic: 'review-tools.risk-score-changed.v1', groupId: 'user-records-service' },
      { name: 'sync-feature-assignments', handler: 'SyncAssignmentsFeatureHandler', topic: 'review-tools.sync-feature-assignments.v1', groupId: 'user-records-service' },
      { name: 'sync-feature-comments', handler: 'SyncCommentsFeatureHandler', topic: 'review-tools.sync-feature-comments.v1', groupId: 'user-records-service' },
      { name: 'sync-feature-documents', handler: 'SyncDocumentsFeatureHandler', topic: 'review-tools.sync-feature-documents.v1', groupId: 'user-records-service' },
      { name: 'sync-feature-escalations', handler: 'SyncEscalationsFeatureHandler', topic: 'review-tools.sync-feature-escalations.v1', groupId: 'user-records-service' },
      { name: 'sync-feature-tags', handler: 'SyncTagsFeatureHandler', topic: 'review-tools.sync-feature-tags.v1', groupId: 'user-records-service' },
      { name: 'tag-added', handler: 'TagAddedHandler', topic: 'review-tools.tag-added.v1', groupId: 'user-records-service' },
      { name: 'tag-removed', handler: 'TagRemovedHandler', topic: 'review-tools.tag-removed.v1', groupId: 'user-records-service' },
      { name: 'user-deleted', handler: 'UserDeletedHandler', topic: 'review-tools.user-deleted.v1', groupId: 'user-records-service' },
      { name: 'user-merged', handler: 'UserMergedHandler', topic: 'review-tools.user-merged.v1', groupId: 'user-records-service' },
      { name: 'user-record-created', handler: 'UserRecordCreatedHandler', topic: 'review-tools.user-record-created.v1', groupId: 'user-records-service' },
      { name: 'user-record-data-updated', handler: 'UserRecordDataUpdatedHandler', topic: 'review-tools.user-record-data-updated.v1', groupId: 'user-records-service' },
    ] as ConsumerConfig[],
  },
  KAFKA_TOPICS: {
    RECORD_DUPLICATE_FOUND: process.env.TOPIC_RECORD_DUPLICATE_FOUND || 'user-records.record-duplicate-found.v1',
    AUDIT_EVENTS: process.env.TOPIC_AUDIT_EVENTS || 'user-records.audit-events.v2',
    MANUAL_DATA_REENCRYPTED: process.env.TOPIC_MANUAL_DATA_REENCRYPTED || 'user-records.manual-data-reencrypted.v1',
  } as KafkaTopicsConfig,
  documentsServiceUrl: process.env.DOCUMENTS_SERVICE_URL || 'http://documents-service.internal',
  staleReviewHours: parseInt(process.env.STALE_REVIEW_HOURS, 10) || 48,
});
