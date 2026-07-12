import type {
  AccountDeliveryEvent,
  AccountDispatchDecision,
  AccountLaneState,
  AccountOrderingInput,
  AccountOrderingResult,
  DeduplicationObservation,
} from "../runtime/trade-runtime-contracts.js";

export function planAccountOrdering(input: AccountOrderingInput): AccountOrderingResult {
  const policy = input.policy;
  const nowTime = input.now.getTime();
  if (!Number.isFinite(nowTime)) throw new Error("account ordering time is invalid");
  if (!Number.isInteger(policy.maximumParallelAccounts) || policy.maximumParallelAccounts < 1) {
    throw new Error("maximum parallel accounts must be a positive integer");
  }
  if (!Number.isInteger(policy.maximumQueueDepthPerAccount) || policy.maximumQueueDepthPerAccount < 1) {
    throw new Error("maximum account queue depth must be a positive integer");
  }
  if (!Number.isInteger(policy.maximumDeliveryAttempts) || policy.maximumDeliveryAttempts < 1) {
    throw new Error("maximum delivery attempts must be a positive integer");
  }
  if (!Number.isFinite(policy.gapWaitMs) || policy.gapWaitMs < 0) throw new Error("gap wait cannot be negative");
  if (!Number.isFinite(policy.failureBackoffMs) || policy.failureBackoffMs < 0) {
    throw new Error("failure backoff cannot be negative");
  }
  const diagnostics: string[] = [];
  const dispatches: AccountDispatchDecision[] = [];
  const rejected: AccountDispatchDecision[] = [];
  const queued: AccountDeliveryEvent[] = [];
  const nextWakeCandidates: number[] = [];
  const deduplicationByEvent = new Map<string, DeduplicationObservation>();
  for (const observation of input.deduplication) {
    const existing = deduplicationByEvent.get(observation.eventId);
    if (existing === undefined || existing.processedAt < observation.processedAt) {
      deduplicationByEvent.set(observation.eventId, observation);
    }
    if (!Number.isFinite(observation.processedAt.getTime())) {
      diagnostics.push(`deduplication observation has invalid time: ${observation.eventId}`);
    }
    if (observation.sequence < 0 || !Number.isSafeInteger(observation.sequence)) {
      diagnostics.push(`deduplication observation has invalid sequence: ${observation.eventId}`);
    }
  }
  const activeAccounts = new Set(input.activeAccountIds);
  if (activeAccounts.size !== input.activeAccountIds.length) {
    diagnostics.push("duplicate active account identifiers were collapsed");
  }
  const laneByAccount = new Map<string, AccountLaneState>();
  for (const lane of input.lanes) {
    if (lane.accountId.trim().length === 0) throw new Error("lane account id cannot be blank");
    const existing = laneByAccount.get(lane.accountId);
    if (existing !== undefined) {
      const existingSequence = existing.lastAppliedSequence ?? -1;
      const candidateSequence = lane.lastAppliedSequence ?? -1;
      if (candidateSequence > existingSequence) laneByAccount.set(lane.accountId, lane);
      diagnostics.push(`duplicate lane state collapsed for account ${lane.accountId}`);
      continue;
    }
    if (lane.lastAppliedSequence !== undefined) {
      if (!Number.isSafeInteger(lane.lastAppliedSequence) || lane.lastAppliedSequence < 0) {
        throw new Error(`lane has invalid applied sequence: ${lane.accountId}`);
      }
    }
    if (lane.consecutiveFailures < 0 || !Number.isInteger(lane.consecutiveFailures)) {
      throw new Error(`lane has invalid failure count: ${lane.accountId}`);
    }
    if (lane.blockedUntil !== undefined && !Number.isFinite(lane.blockedUntil.getTime())) {
      throw new Error(`lane has invalid blocked-until time: ${lane.accountId}`);
    }
    laneByAccount.set(lane.accountId, lane);
    if (lane.runningMessageId !== undefined) activeAccounts.add(lane.accountId);
  }
  const eventByMessage = new Map<string, AccountDeliveryEvent>();
  const messageByEvent = new Map<string, string>();
  for (const event of input.events) {
    if (event.messageId.trim().length === 0) throw new Error("message id cannot be blank");
    if (event.eventId.trim().length === 0) throw new Error("event id cannot be blank");
    if (event.accountId.trim().length === 0) throw new Error("event account id cannot be blank");
    if (event.tradeId.trim().length === 0) throw new Error("event trade id cannot be blank");
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "late",
        reason: "invalid-sequence",
        shouldAcknowledge: false,
      });
      continue;
    }
    if (!Number.isSafeInteger(event.partition) || event.partition < 0) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "late",
        reason: "invalid-partition",
        shouldAcknowledge: false,
      });
      continue;
    }
    if (!Number.isSafeInteger(event.offset) || event.offset < 0) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "late",
        reason: "invalid-offset",
        shouldAcknowledge: false,
      });
      continue;
    }
    if (!Number.isInteger(event.deliveryAttempt) || event.deliveryAttempt < 1) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "late",
        reason: "invalid-delivery-attempt",
        shouldAcknowledge: false,
      });
      continue;
    }
    if (!Number.isFinite(event.receivedAt.getTime())) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "late",
        reason: "invalid-received-time",
        shouldAcknowledge: false,
      });
      continue;
    }
    if (eventByMessage.has(event.messageId)) {
      rejected.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "reject",
        relationship: "duplicate",
        reason: "duplicate-message-id-in-input",
        shouldAcknowledge: false,
      });
      continue;
    }
    const priorMessage = messageByEvent.get(event.eventId);
    if (priorMessage !== undefined) {
      dispatches.push({
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action: "ack",
        relationship: "duplicate",
        reason: `event-duplicated-by-message:${priorMessage}`,
        shouldAcknowledge: true,
      });
      continue;
    }
    eventByMessage.set(event.messageId, event);
    messageByEvent.set(event.eventId, event.messageId);
  }
  const eventsByAccount = new Map<string, AccountDeliveryEvent[]>();
  for (const event of eventByMessage.values()) {
    const processed = deduplicationByEvent.get(event.eventId);
    if (processed !== undefined) {
      if (processed.accountId !== event.accountId) {
        rejected.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId: event.accountId,
          action: "reject",
          relationship: "duplicate",
          reason: "deduplication-account-mismatch",
          shouldAcknowledge: false,
        });
      } else {
        dispatches.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId: event.accountId,
          action: "ack",
          relationship: "duplicate",
          expectedSequence: processed.sequence,
          reason: `event-already-${processed.outcome}`,
          shouldAcknowledge: true,
        });
      }
      continue;
    }
    if (event.deliveryAttempt > policy.maximumDeliveryAttempts) {
      const action = policy.deadLetterAfterAttempts ? "dead-letter" : "reject";
      const decision: AccountDispatchDecision = {
        messageId: event.messageId,
        eventId: event.eventId,
        accountId: event.accountId,
        action,
        relationship: "late",
        reason: "delivery-attempt-limit-exceeded",
        shouldAcknowledge: action === "dead-letter",
      };
      rejected.push(decision);
      continue;
    }
    const group = eventsByAccount.get(event.accountId) ?? [];
    group.push(event);
    eventsByAccount.set(event.accountId, group);
  }
  for (const group of eventsByAccount.values()) {
    group.sort((left, right) => {
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      if (left.receivedAt.getTime() !== right.receivedAt.getTime()) {
        return left.receivedAt.getTime() - right.receivedAt.getTime();
      }
      if (left.partition !== right.partition) return left.partition - right.partition;
      if (left.offset !== right.offset) return left.offset - right.offset;
      return left.messageId.localeCompare(right.messageId);
    });
  }
  const accountOrder = [...eventsByAccount.keys()].sort((left, right) => {
    const leftGroup = eventsByAccount.get(left) ?? [];
    const rightGroup = eventsByAccount.get(right) ?? [];
    const leftFirst = leftGroup[0];
    const rightFirst = rightGroup[0];
    if (leftFirst === undefined || rightFirst === undefined) return left.localeCompare(right);
    if (policy.prioritizeOldestAccount) {
      const timeOrder = leftFirst.receivedAt.getTime() - rightFirst.receivedAt.getTime();
      if (timeOrder !== 0) return timeOrder;
    }
    const priorityOrder = rightFirst.priority - leftFirst.priority;
    if (priorityOrder !== 0) return priorityOrder;
    return left.localeCompare(right);
  });
  const laneAssignments: Record<string, number> = {};
  const usedLaneIndexes = new Set<number>();
  let nextLaneIndex = 0;
  for (const accountId of activeAccounts) {
    laneAssignments[accountId] = nextLaneIndex;
    usedLaneIndexes.add(nextLaneIndex);
    nextLaneIndex += 1;
  }
  const availableAccountSlots = Math.max(0, policy.maximumParallelAccounts - activeAccounts.size);
  let newlyActivated = 0;
  for (const accountId of accountOrder) {
    const group = eventsByAccount.get(accountId) ?? [];
    const lane = laneByAccount.get(accountId);
    if (group.length === 0) continue;
    if (lane?.blockedUntil !== undefined && lane.blockedUntil.getTime() > nowTime) {
      nextWakeCandidates.push(lane.blockedUntil.getTime());
      for (const event of group) {
        queued.push(event);
        dispatches.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId,
          action: "defer",
          relationship: "next",
          deferUntil: lane.blockedUntil,
          reason: "account-lane-backoff-active",
          shouldAcknowledge: false,
        });
      }
      continue;
    }
    if (lane?.runningMessageId !== undefined || activeAccounts.has(accountId)) {
      for (const event of group) queued.push(event);
      diagnostics.push(`account already active; events retained in order: ${accountId}`);
      continue;
    }
    if (newlyActivated >= availableAccountSlots) {
      for (const event of group) queued.push(event);
      diagnostics.push(`parallel account limit deferred account: ${accountId}`);
      continue;
    }
    while (usedLaneIndexes.has(nextLaneIndex)) nextLaneIndex += 1;
    const laneIndex = nextLaneIndex;
    usedLaneIndexes.add(laneIndex);
    laneAssignments[accountId] = laneIndex;
    nextLaneIndex += 1;
    newlyActivated += 1;
    activeAccounts.add(accountId);
    let expectedSequence = (lane?.lastAppliedSequence ?? -1) + 1;
    if (lane?.lastAppliedSequence === undefined && policy.allowInitialNonZeroSequence) {
      expectedSequence = group[0]?.sequence ?? 0;
    }
    let selected = false;
    for (const event of group) {
      if (event.sequence < expectedSequence) {
        dispatches.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId,
          action: "ack",
          relationship: "late",
          laneIndex,
          expectedSequence,
          reason: "sequence-already-applied",
          shouldAcknowledge: true,
        });
        continue;
      }
      if (event.sequence > expectedSequence) {
        const deferUntil = new Date(nowTime + policy.gapWaitMs);
        queued.push(event);
        nextWakeCandidates.push(deferUntil.getTime());
        dispatches.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId,
          action: "defer",
          relationship: "gap",
          laneIndex,
          expectedSequence,
          deferUntil,
          reason: `sequence-gap:${expectedSequence}-${event.sequence}`,
          shouldAcknowledge: false,
        });
        continue;
      }
      if (!selected) {
        dispatches.push({
          messageId: event.messageId,
          eventId: event.eventId,
          accountId,
          action: "handle",
          relationship: lane?.lastAppliedSequence === undefined ? "initial" : "next",
          laneIndex,
          expectedSequence,
          reason: "next-account-event",
          shouldAcknowledge: false,
        });
        selected = true;
        expectedSequence += 1;
      } else {
        queued.push(event);
      }
    }
  }
  const queuedByAccount = new Map<string, AccountDeliveryEvent[]>();
  for (const event of queued) {
    const group = queuedByAccount.get(event.accountId) ?? [];
    group.push(event);
    queuedByAccount.set(event.accountId, group);
  }
  for (const [accountId, group] of queuedByAccount) {
    const existingDepth = laneByAccount.get(accountId)?.queued.length ?? 0;
    const overflow = existingDepth + group.length - policy.maximumQueueDepthPerAccount;
    if (overflow <= 0) continue;
    group.sort((left, right) => right.sequence - left.sequence || right.offset - left.offset);
    const overflowEvents = group.slice(0, overflow);
    for (const event of overflowEvents) {
      const queueIndex = queued.findIndex((candidate) => candidate.messageId === event.messageId);
      if (queueIndex >= 0) queued.splice(queueIndex, 1);
      const decision: AccountDispatchDecision = {
        messageId: event.messageId,
        eventId: event.eventId,
        accountId,
        action: "reject",
        relationship: "gap",
        reason: "account-queue-capacity-exceeded",
        shouldAcknowledge: false,
      };
      rejected.push(decision);
      dispatches.push(decision);
    }
  }
  queued.sort((left, right) => {
    const accountOrder = left.accountId.localeCompare(right.accountId);
    if (accountOrder !== 0) return accountOrder;
    return left.sequence - right.sequence || left.offset - right.offset;
  });
  const finiteWakeCandidates = nextWakeCandidates.filter((candidate) => Number.isFinite(candidate));
  const nextWakeAt = finiteWakeCandidates.length === 0
    ? undefined
    : new Date(Math.min(...finiteWakeCandidates));
  const baseResult = {
    dispatches,
    queued,
    rejected,
    activeAccountIds: [...activeAccounts].sort(),
    laneAssignments,
    diagnostics,
  };
  const dispatchMessageIds = new Set<string>();
  for (const decision of dispatches) {
    if (dispatchMessageIds.has(decision.messageId)) {
      const prior = dispatches.find((candidate) =>
        candidate.messageId === decision.messageId && candidate !== decision,
      );
      if (prior?.action !== decision.action || prior.reason !== decision.reason) {
        diagnostics.push(`message has multiple dispatch decisions: ${decision.messageId}`);
      }
    }
    dispatchMessageIds.add(decision.messageId);
    if (decision.action === "handle" && decision.laneIndex === undefined) {
      throw new Error(`handled trade message lacks a lane assignment: ${decision.messageId}`);
    }
    if (decision.action === "ack" && !decision.shouldAcknowledge) {
      throw new Error(`ack dispatch is not marked for acknowledgement: ${decision.messageId}`);
    }
    if (decision.action === "defer" && decision.deferUntil === undefined && decision.relationship === "gap") {
      throw new Error(`gap-deferred trade message lacks a wake time: ${decision.messageId}`);
    }
  }
  const queuedMessageIds = new Set(queued.map((event) => event.messageId));
  if (queuedMessageIds.size !== queued.length) throw new Error("account ordering queue contains duplicate messages");
  const assignedLaneIndexes = Object.values(laneAssignments);
  if (new Set(assignedLaneIndexes).size !== assignedLaneIndexes.length) {
    throw new Error("account ordering assigned one lane to multiple accounts");
  }
  if (activeAccounts.size > policy.maximumParallelAccounts + input.activeAccountIds.length) {
    throw new Error("account ordering active set exceeds parallelism accounting");
  }
  return nextWakeAt === undefined ? baseResult : { ...baseResult, nextWakeAt };
}
