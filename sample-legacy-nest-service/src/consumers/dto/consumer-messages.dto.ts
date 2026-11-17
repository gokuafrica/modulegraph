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
