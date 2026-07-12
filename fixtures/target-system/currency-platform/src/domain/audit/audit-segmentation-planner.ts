import type {
  AuditSegmentState,
  AuditSegmentationInput,
  AuditSegmentationPlan,
  AuditSegmentWrite,
  BufferedAuditRecord,
} from "../runtime/audit-runtime-contracts.js";

export function planAuditSegmentation(input: AuditSegmentationInput): AuditSegmentationPlan {
  const policy = input.policy;
  const warnings: string[] = [];
  const deferredRecordIds: string[] = [];
  const writes: AuditSegmentWrite[] = [];
  const rotateSegmentIds = new Set<string>();
  const nowTime = input.now.getTime();
  if (!Number.isFinite(nowTime)) throw new Error("audit segmentation time is invalid");
  if (!Number.isInteger(input.nextSequence) || input.nextSequence < 0) {
    throw new Error("next audit sequence must be a non-negative integer");
  }
  if (!Number.isInteger(policy.partitionCount) || policy.partitionCount < 1) {
    throw new Error("audit partition count must be a positive integer");
  }
  if (policy.partitionCount > 1_024) throw new Error("audit partition count exceeds operational maximum");
  if (!Number.isInteger(policy.maximumRecordsPerSegment) || policy.maximumRecordsPerSegment < 1) {
    throw new Error("maximum records per segment must be positive");
  }
  if (!Number.isInteger(policy.maximumBytesPerSegment) || policy.maximumBytesPerSegment < 256) {
    throw new Error("maximum bytes per segment must be at least 256");
  }
  if (!Number.isInteger(policy.maximumBatchRecords) || policy.maximumBatchRecords < 1) {
    throw new Error("maximum batch records must be positive");
  }
  if (policy.maximumBatchRecords > policy.maximumRecordsPerSegment) {
    throw new Error("maximum batch records cannot exceed segment record capacity");
  }
  if (!Number.isInteger(policy.minimumBatchRecords) || policy.minimumBatchRecords < 0) {
    throw new Error("minimum batch records cannot be negative");
  }
  if (policy.minimumBatchRecords > policy.maximumBatchRecords) {
    throw new Error("minimum batch records cannot exceed maximum batch records");
  }
  if (!Number.isInteger(policy.maximumBatchBytes) || policy.maximumBatchBytes < 256) {
    throw new Error("maximum batch bytes must be at least 256");
  }
  if (policy.maximumBatchBytes > policy.maximumBytesPerSegment) {
    throw new Error("maximum batch bytes cannot exceed segment byte capacity");
  }
  if (!Number.isFinite(policy.maximumSegmentAgeMs) || policy.maximumSegmentAgeMs < 1) {
    throw new Error("maximum segment age must be positive");
  }
  if (input.callerId.trim().length === 0) throw new Error("audit flush caller id is required");
  if (input.activeFlushId !== undefined && input.activeFlushId.trim().length === 0) {
    throw new Error("active flush id cannot be blank");
  }
  if (input.shutdownDeadline !== undefined && !Number.isFinite(input.shutdownDeadline.getTime())) {
    throw new Error("shutdown deadline is invalid");
  }
  const generatedFlushId = `flush:${input.callerId}:${nowTime}:${input.nextSequence}`;
  if (input.activeFlushId !== undefined && input.activeFlushId !== generatedFlushId) {
    return {
      flushId: input.activeFlushId,
      acquired: false,
      writes: [],
      deferredRecordIds: input.records.map((record) => record.recordId),
      nextSequence: input.nextSequence,
      totalRecords: 0,
      totalBytes: 0,
      rotateSegmentIds: [],
      warnings: ["another caller owns the active audit flush lease"],
      completeBeforeShutdown: input.trigger !== "shutdown",
    };
  }
  const segmentByPartition = new Map<number, AuditSegmentState>();
  const seenSegmentIds = new Set<string>();
  for (const segment of input.segments) {
    if (segment.segmentId.trim().length === 0) throw new Error("audit segment id cannot be blank");
    if (seenSegmentIds.has(segment.segmentId)) throw new Error(`duplicate audit segment id: ${segment.segmentId}`);
    seenSegmentIds.add(segment.segmentId);
    if (!Number.isInteger(segment.partition) || segment.partition < 0 || segment.partition >= policy.partitionCount) {
      throw new Error(`audit segment has invalid partition: ${segment.segmentId}`);
    }
    if (!Number.isFinite(segment.openedAt.getTime())) {
      throw new Error(`audit segment has invalid opening time: ${segment.segmentId}`);
    }
    if (!Number.isInteger(segment.recordCount) || segment.recordCount < 0) {
      throw new Error(`audit segment has invalid record count: ${segment.segmentId}`);
    }
    if (!Number.isInteger(segment.byteCount) || segment.byteCount < 0) {
      throw new Error(`audit segment has invalid byte count: ${segment.segmentId}`);
    }
    if (!Number.isSafeInteger(segment.firstSequence) || segment.firstSequence < 0) {
      throw new Error(`audit segment has invalid first sequence: ${segment.segmentId}`);
    }
    if (!Number.isSafeInteger(segment.lastSequence) || segment.lastSequence < segment.firstSequence - 1) {
      throw new Error(`audit segment has invalid last sequence: ${segment.segmentId}`);
    }
    if (segment.encryptionKeyId.trim().length === 0) {
      throw new Error(`audit segment lacks an encryption key: ${segment.segmentId}`);
    }
    if (segment.checksumChainHead.trim().length === 0) {
      throw new Error(`audit segment lacks a checksum chain head: ${segment.segmentId}`);
    }
    const existing = segmentByPartition.get(segment.partition);
    if (existing === undefined) {
      segmentByPartition.set(segment.partition, segment);
      continue;
    }
    if (!existing.sealed && !segment.sealed) {
      throw new Error(`partition ${segment.partition} has multiple open audit segments`);
    }
    if (existing.sealed && !segment.sealed) segmentByPartition.set(segment.partition, segment);
    else if (existing.sealed === segment.sealed && existing.lastSequence < segment.lastSequence) {
      segmentByPartition.set(segment.partition, segment);
    }
  }
  const seenRecordIds = new Set<string>();
  const acceptedRecords: BufferedAuditRecord[] = [];
  for (const record of input.records) {
    if (record.recordId.trim().length === 0) throw new Error("audit record id cannot be blank");
    if (seenRecordIds.has(record.recordId)) {
      warnings.push(`duplicate buffered audit record was deferred: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    seenRecordIds.add(record.recordId);
    if (record.eventType.trim().length === 0) {
      warnings.push(`record with empty event type was deferred: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    if (record.correlationId.trim().length === 0) {
      warnings.push(`record with empty correlation id was deferred: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    if (!Number.isFinite(record.occurredAt.getTime())) {
      warnings.push(`record with invalid occurrence time was deferred: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    if (!Number.isInteger(record.encodedBytes) || record.encodedBytes < 1) {
      warnings.push(`record with invalid encoded size was deferred: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    if (record.encodedBytes > policy.maximumBatchBytes) {
      warnings.push(`oversize record cannot fit an audit batch: ${record.recordId}`);
      deferredRecordIds.push(record.recordId);
      continue;
    }
    if (!record.immutable) {
      warnings.push(`mutable audit record was accepted with warning: ${record.recordId}`);
    }
    acceptedRecords.push(record);
  }
  acceptedRecords.sort((left, right) => {
    const timeOrder = left.occurredAt.getTime() - right.occurredAt.getTime();
    if (timeOrder !== 0) return timeOrder;
    const correlationOrder = left.correlationId.localeCompare(right.correlationId);
    if (correlationOrder !== 0) return correlationOrder;
    return left.recordId.localeCompare(right.recordId);
  });
  if (
    input.trigger !== "shutdown"
    && input.trigger !== "manual"
    && acceptedRecords.length < policy.minimumBatchRecords
  ) {
    return {
      flushId: generatedFlushId,
      acquired: true,
      writes: [],
      deferredRecordIds: [...deferredRecordIds, ...acceptedRecords.map((record) => record.recordId)],
      nextSequence: input.nextSequence,
      totalRecords: 0,
      totalBytes: 0,
      rotateSegmentIds: [],
      warnings: [...warnings, "buffer is below the minimum flush batch size"],
      completeBeforeShutdown: true,
    };
  }
  const partitionForRecord = new Map<string, number>();
  for (const record of acceptedRecords) {
    const material = record.partitionKey.length > 0 ? record.partitionKey : record.correlationId;
    let hash = 2_166_136_261;
    for (let index = 0; index < material.length; index += 1) {
      hash ^= material.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    partitionForRecord.set(record.recordId, hash % policy.partitionCount);
  }
  const groups: BufferedAuditRecord[][] = [];
  if (policy.preserveCorrelationGroups) {
    const groupByCorrelation = new Map<string, BufferedAuditRecord[]>();
    for (const record of acceptedRecords) {
      const key = `${partitionForRecord.get(record.recordId) ?? 0}:${record.correlationId}`;
      const group = groupByCorrelation.get(key) ?? [];
      group.push(record);
      groupByCorrelation.set(key, group);
    }
    groups.push(...groupByCorrelation.values());
    groups.sort((left, right) => {
      const leftFirst = left[0];
      const rightFirst = right[0];
      if (leftFirst === undefined || rightFirst === undefined) return left.length - right.length;
      return leftFirst.occurredAt.getTime() - rightFirst.occurredAt.getTime();
    });
  } else {
    for (const record of acceptedRecords) groups.push([record]);
  }
  const selectedByPartition = new Map<number, BufferedAuditRecord[]>();
  let selectedRecordCount = 0;
  let selectedByteCount = 0;
  for (const group of groups) {
    const first = group[0];
    if (first === undefined) continue;
    const partition = partitionForRecord.get(first.recordId) ?? 0;
    const groupBytes = group.reduce((sum, record) => sum + record.encodedBytes, 0);
    const partitionRecords = selectedByPartition.get(partition) ?? [];
    const wouldExceedRecordLimit = selectedRecordCount + group.length > policy.maximumBatchRecords;
    const wouldExceedByteLimit = selectedByteCount + groupBytes > policy.maximumBatchBytes;
    if (wouldExceedRecordLimit || wouldExceedByteLimit) {
      for (const record of group) deferredRecordIds.push(record.recordId);
      if (policy.preserveCorrelationGroups && group.length > 1) {
        warnings.push(`correlation group deferred atomically: ${first.correlationId}`);
      }
      continue;
    }
    partitionRecords.push(...group);
    selectedByPartition.set(partition, partitionRecords);
    selectedRecordCount += group.length;
    selectedByteCount += groupBytes;
  }
  let sequence = input.nextSequence;
  let totalBytes = 0;
  let totalRecords = 0;
  const partitions = [...selectedByPartition.keys()].sort((left, right) => left - right);
  for (const partition of partitions) {
    const records = selectedByPartition.get(partition) ?? [];
    if (records.length === 0) continue;
    const current = segmentByPartition.get(partition);
    const recordBytes = records.reduce((sum, record) => sum + record.encodedBytes, 0);
    const currentAgeMs = current === undefined ? 0 : Math.max(0, nowTime - current.openedAt.getTime());
    const criticalRecord = records.some((record) => record.severity === "critical");
    const recordCapacityExceeded = current !== undefined
      && current.recordCount + records.length > policy.maximumRecordsPerSegment;
    const byteCapacityExceeded = current !== undefined
      && current.byteCount + recordBytes > policy.maximumBytesPerSegment;
    const ageExceeded = current !== undefined && currentAgeMs >= policy.maximumSegmentAgeMs;
    const shouldRotate = current !== undefined
      && !current.sealed
      && (
        recordCapacityExceeded
        || byteCapacityExceeded
        || ageExceeded
        || (policy.rotateOnCriticalRecord && criticalRecord && current.recordCount > 0)
      );
    if (current?.sealed === true) rotateSegmentIds.add(current.segmentId);
    if (shouldRotate && current !== undefined) rotateSegmentIds.add(current.segmentId);
    const disposition = current === undefined || current.sealed
      ? "create"
      : shouldRotate
        ? "rotate"
        : "append";
    const segmentId = disposition === "append" && current !== undefined
      ? current.segmentId
      : `audit-${partition}-${nowTime}-${sequence}`;
    const encryptionKeyId = disposition === "append" && current !== undefined
      ? current.encryptionKeyId
      : `audit-key-${new Date(nowTime).toISOString().slice(0, 7)}`;
    const previousChecksum = disposition === "append" && current !== undefined
      ? current.checksumChainHead
      : "00000000";
    const firstSequence = sequence;
    const lastSequence = sequence + records.length - 1;
    let checksum = 2_166_136_261;
    const checksumMaterial = [
      previousChecksum,
      segmentId,
      String(firstSequence),
      String(lastSequence),
      ...records.flatMap((record) => [
        record.recordId,
        record.eventType,
        record.correlationId,
        record.occurredAt.toISOString(),
        String(record.encodedBytes),
      ]),
    ].join("|");
    for (let index = 0; index < checksumMaterial.length; index += 1) {
      checksum ^= checksumMaterial.charCodeAt(index);
      checksum = Math.imul(checksum, 16_777_619) >>> 0;
    }
    const expectedChecksum = policy.checksumAlgorithm === "fnv1a"
      ? checksum.toString(16).padStart(8, "0")
      : `sha256-placeholder-${checksum.toString(16).padStart(8, "0")}`;
    writes.push({
      segmentId,
      disposition,
      partition,
      recordIds: records.map((record) => record.recordId),
      firstSequence,
      lastSequence,
      encodedBytes: recordBytes,
      previousChecksum,
      expectedChecksum,
      encryptionKeyId,
    });
    sequence = lastSequence + 1;
    totalRecords += records.length;
    totalBytes += recordBytes;
  }
  if (writes.length === 0 && acceptedRecords.length > 0) {
    warnings.push("no audit write fit the configured batch and segment constraints");
  }
  if (input.trigger === "threshold" && totalRecords < policy.maximumBatchRecords) {
    warnings.push("threshold flush produced a partial batch after partition and byte constraints");
  }
  if (input.trigger === "interval" && totalRecords === 0) {
    warnings.push("interval flush had no eligible records");
  }
  if (input.trigger === "retry" && deferredRecordIds.length > 0) {
    warnings.push("retry flush retained records that still could not be scheduled");
  }
  let completeBeforeShutdown = true;
  if (input.trigger === "shutdown") {
    if (input.shutdownDeadline === undefined) {
      warnings.push("shutdown flush did not provide a completion deadline");
    } else {
      const remainingMs = input.shutdownDeadline.getTime() - nowTime;
      const estimatedWriteMs = writes.length * 25 + Math.ceil(totalBytes / 65_536) * 10;
      completeBeforeShutdown = remainingMs >= estimatedWriteMs && deferredRecordIds.length === 0;
      if (remainingMs < 0) warnings.push("shutdown deadline had already elapsed");
      else if (!completeBeforeShutdown) warnings.push("audit flush may not complete before shutdown deadline");
    }
  }
  const writtenRecordIds = new Set<string>();
  let expectedSequence = input.nextSequence;
  for (const write of writes) {
    if (write.firstSequence !== expectedSequence) {
      throw new Error(`audit write sequence is not contiguous at segment ${write.segmentId}`);
    }
    if (write.lastSequence - write.firstSequence + 1 !== write.recordIds.length) {
      throw new Error(`audit write sequence span is inconsistent at segment ${write.segmentId}`);
    }
    if (write.encodedBytes < write.recordIds.length) {
      throw new Error(`audit write byte count is implausible at segment ${write.segmentId}`);
    }
    for (const recordId of write.recordIds) {
      if (writtenRecordIds.has(recordId)) throw new Error(`audit record was scheduled twice: ${recordId}`);
      writtenRecordIds.add(recordId);
    }
    expectedSequence = write.lastSequence + 1;
  }
  if (expectedSequence !== sequence) throw new Error("audit segmentation next sequence is inconsistent");
  if (writtenRecordIds.size !== totalRecords) throw new Error("audit segmentation record total is inconsistent");
  if (writes.reduce((sum, write) => sum + write.encodedBytes, 0) !== totalBytes) {
    throw new Error("audit segmentation byte total is inconsistent");
  }
  const overlap = deferredRecordIds.filter((recordId) => writtenRecordIds.has(recordId));
  if (overlap.length > 0) throw new Error(`audit records are both written and deferred: ${overlap.join(",")}`);
  return {
    flushId: generatedFlushId,
    acquired: true,
    writes,
    deferredRecordIds,
    nextSequence: sequence,
    totalRecords,
    totalBytes,
    rotateSegmentIds: [...rotateSegmentIds].sort(),
    warnings,
    completeBeforeShutdown,
  };
}
