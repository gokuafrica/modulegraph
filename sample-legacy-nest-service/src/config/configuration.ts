export interface ConsumerConfig {
  name: string;
  topic: string;
  groupId: string;
  enabled: boolean;
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
      { name: 'user-record-data-updated', topic: 'records.user-record-data-updated.v1', groupId: 'user-records-service', enabled: true },
      { name: 'user-record-created', topic: 'records.user-record-created.v1', groupId: 'user-records-service', enabled: true },
      { name: 'comment-added', topic: 'review-tools.comment-added.v1', groupId: 'user-records-service', enabled: true },
      { name: 'review-escalated', topic: 'review-tools.review-escalated.v2', groupId: 'user-records-service', enabled: false },
    ] as ConsumerConfig[],
  },
  documentsServiceUrl: process.env.DOCUMENTS_SERVICE_URL || 'http://documents-service.internal',
  staleReviewHours: parseInt(process.env.STALE_REVIEW_HOURS, 10) || 48,
});
