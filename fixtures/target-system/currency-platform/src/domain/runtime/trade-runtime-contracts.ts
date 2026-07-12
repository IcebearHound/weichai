export type DeliveryAction = "ack" | "handle" | "defer" | "reject" | "dead-letter";
export type SequenceRelationship = "next" | "duplicate" | "gap" | "late" | "initial";

export interface AccountDeliveryEvent {
  readonly messageId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly tradeId: string;
  readonly sequence: number;
  readonly partition: number;
  readonly offset: number;
  readonly deliveryAttempt: number;
  readonly receivedAt: Date;
  readonly priority: number;
}

export interface AccountLaneState {
  readonly accountId: string;
  readonly lastAppliedSequence?: number;
  readonly runningMessageId?: string;
  readonly queued: readonly AccountDeliveryEvent[];
  readonly blockedUntil?: Date;
  readonly consecutiveFailures: number;
}

export interface AccountOrderingPolicy {
  readonly maximumParallelAccounts: number;
  readonly maximumQueueDepthPerAccount: number;
  readonly maximumDeliveryAttempts: number;
  readonly gapWaitMs: number;
  readonly failureBackoffMs: number;
  readonly allowInitialNonZeroSequence: boolean;
  readonly deadLetterAfterAttempts: boolean;
  readonly prioritizeOldestAccount: boolean;
}

export interface DeduplicationObservation {
  readonly eventId: string;
  readonly processedAt: Date;
  readonly outcome: "handled" | "rejected";
  readonly accountId: string;
  readonly sequence: number;
}

export interface AccountDispatchDecision {
  readonly messageId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly action: DeliveryAction;
  readonly relationship: SequenceRelationship;
  readonly laneIndex?: number;
  readonly expectedSequence?: number;
  readonly deferUntil?: Date;
  readonly reason: string;
  readonly shouldAcknowledge: boolean;
}

export interface AccountOrderingInput {
  readonly events: readonly AccountDeliveryEvent[];
  readonly lanes: readonly AccountLaneState[];
  readonly deduplication: readonly DeduplicationObservation[];
  readonly activeAccountIds: readonly string[];
  readonly now: Date;
  readonly policy: AccountOrderingPolicy;
}

export interface AccountOrderingResult {
  readonly dispatches: readonly AccountDispatchDecision[];
  readonly queued: readonly AccountDeliveryEvent[];
  readonly rejected: readonly AccountDispatchDecision[];
  readonly activeAccountIds: readonly string[];
  readonly laneAssignments: Readonly<Record<string, number>>;
  readonly nextWakeAt?: Date;
  readonly diagnostics: readonly string[];
}

export interface TradeDeliveryCommit {
  readonly partition: number;
  readonly contiguousOffset: number;
  readonly acknowledgedMessageIds: readonly string[];
  readonly heldOffsets: readonly number[];
  readonly generatedAt: Date;
}
