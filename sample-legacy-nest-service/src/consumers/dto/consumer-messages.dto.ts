export interface UserRecordDataUpdatedMessage {
  guid: string;
  agentGuid: string;
  data: Record<string, unknown>;
  reason?: string;
}

export interface UserRecordCreatedMessage {
  userGuid: string;
  recordType: string;
  data: Record<string, unknown>;
}

export interface CommentAddedMessage {
  recordGuid: string;
  authorGuid: string;
  body: string;
}

export interface ReviewEscalatedMessage {
  recordGuid: string;
  reason: string;
  escalatedBy: string;
}

export interface RecordTagMessage {
  recordGuid: string;
  tag: string;
}

export interface AgentAssignedMessage {
  recordGuid: string;
  agentGuid: string;
}

export interface RecordDuplicateDetectedMessage {
  recordGuid: string;
  duplicateOf: string;
}

export interface RiskScoreChangedMessage {
  recordGuid: string;
  score: number;
  changedAt: string;
}

export interface ReviewNoteAddedMessage {
  recordGuid: string;
  actorGuid: string;
  note: string;
}

/** Events about a record that only need an audit entry. */
export interface RecordEventMessage {
  recordGuid: string;
  actorGuid: string;
  details?: Record<string, unknown>;
}

export interface SyncFeatureMessage {
  recordGuid: string;
  values: string[];
}
