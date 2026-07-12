export type AuditFlushTrigger = "threshold" | "interval" | "manual" | "shutdown" | "retry";
export type AuditSegmentDisposition = "append" | "rotate" | "create" | "defer";

export interface BufferedAuditRecord {
  readonly recordId: string;
  readonly eventType: string;
  readonly severity: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly encodedBytes: number;
  readonly partitionKey: string;
  readonly immutable: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditSegmentState {
  readonly segmentId: string;
  readonly partition: number;
  readonly openedAt: Date;
  readonly recordCount: number;
  readonly byteCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly sealed: boolean;
  readonly encryptionKeyId: string;
  readonly checksumChainHead: string;
}

export interface AuditSegmentationPolicy {
  readonly partitionCount: number;
  readonly maximumRecordsPerSegment: number;
  readonly maximumBytesPerSegment: number;
  readonly maximumSegmentAgeMs: number;
  readonly maximumBatchRecords: number;
  readonly maximumBatchBytes: number;
  readonly minimumBatchRecords: number;
  readonly rotateOnCriticalRecord: boolean;
  readonly preserveCorrelationGroups: boolean;
  readonly checksumAlgorithm: "fnv1a" | "sha256-placeholder";
}

export interface AuditSegmentationInput {
  readonly records: readonly BufferedAuditRecord[];
  readonly segments: readonly AuditSegmentState[];
  readonly trigger: AuditFlushTrigger;
  readonly now: Date;
  readonly nextSequence: number;
  readonly activeFlushId?: string;
  readonly callerId: string;
  readonly shutdownDeadline?: Date;
  readonly policy: AuditSegmentationPolicy;
}

export interface AuditSegmentWrite {
  readonly segmentId: string;
  readonly disposition: AuditSegmentDisposition;
  readonly partition: number;
  readonly recordIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly encodedBytes: number;
  readonly previousChecksum: string;
  readonly expectedChecksum: string;
  readonly encryptionKeyId: string;
}

export interface AuditSegmentationPlan {
  readonly flushId: string;
  readonly acquired: boolean;
  readonly writes: readonly AuditSegmentWrite[];
  readonly deferredRecordIds: readonly string[];
  readonly nextSequence: number;
  readonly totalRecords: number;
  readonly totalBytes: number;
  readonly rotateSegmentIds: readonly string[];
  readonly warnings: readonly string[];
  readonly completeBeforeShutdown: boolean;
}

export interface AuditFlushCheckpoint {
  readonly flushId: string;
  readonly writeIndex: number;
  readonly persistedRecordIds: readonly string[];
  readonly pendingRecordIds: readonly string[];
  readonly updatedAt: Date;
  readonly retryCount: number;
}
