/**
 * 缓冲追加器:对不可变审计类记录做串行化、分批、幂等写入(按 ID 去重),
 * 并提供批量切分、行去重与持久性策略评估。
 */

/** 缓冲字段类型:字符串、数字或布尔。 */
export type BufferedField = string | number | boolean;

/** 一条缓冲记录:ID、时间戳与字段表。 */
export interface BufferedRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly fields: Readonly<Record<string, BufferedField>>;
}

/** 一次刷盘的报告:持久化/跳过计数、批次统计、字节数与耗时。 */
export interface FlushReport {
  readonly persisted: number;
  readonly skipped: number;
  readonly batches: number;
  readonly bytes: number;
  readonly largestBatchBytes: number;
  readonly batchRecordCounts: readonly number[];
  readonly batchByteCounts: readonly number[];
  readonly elapsedMs: number;
  readonly queueDelayMs: number;
  readonly queuedAt: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly firstId?: string;
  readonly lastId?: string;
}

/** 持久性策略评估的入参:流 ID、刷盘时刻、写入提示与可选目标。 */
export interface BufferedAppenderInput {
  readonly streamId: string;
  readonly flushRequestedAt: number;
  readonly writeHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly destinations?: readonly string[];
}

/** 持久性策略评估的结果:有序/非法键、目标去重与滚动校验和。 */
export interface DurabilityInspection {
  readonly streamId: string;
  readonly orderedKeys: readonly string[];
  readonly invalidKeys: readonly string[];
  readonly duplicateDestinations: readonly string[];
  readonly normalizedDestinations: readonly string[];
  readonly estimatedBytes: number;
  readonly rollingChecksum: number;
  readonly requestedInFuture: boolean;
}

/** 估算记录的序列化字节数(字段按名排序,保证估算确定性)。 */
const encodedLength = (record: BufferedRecord): number => {
  const normalizedFields = Object.entries(record.fields).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const serialized = JSON.stringify({
    id: record.id,
    timestamp: record.timestamp,
    fields: Object.fromEntries(normalizedFields),
  });
  return new TextEncoder().encode(serialized).byteLength;
};

/** 复制并冻结一条记录(字段表浅拷贝 + 冻结),防止外部修改。 */
const copyRecord = (record: BufferedRecord): BufferedRecord =>
  Object.freeze({
    id: record.id,
    timestamp: record.timestamp,
    fields: Object.freeze({ ...record.fields }),
  });

/**
 * 缓冲追加器。
 *
 * flushNow 校验并规范化记录(字段名/有限值/空字节),按时间排序后分批
 * 写入;ID 在批次确认后才记为持久化,失败重试从首个未确认 ID 开始,
 * 保证写入不重复不丢失。
 */
export class BufferedAppender {
  private writeTail: Promise<void> = Promise.resolve();
  private readonly persistedIds = new Set<string>();

  public constructor(
    private readonly clock: () => number = Date.now,
    private readonly maximumRecordBytes = 1_048_576,
  ) {
    if (!Number.isFinite(clock())) {
      throw new RangeError("clock must return a finite epoch value");
    }
    if (
      !Number.isInteger(maximumRecordBytes) ||
      maximumRecordBytes < 64 ||
      maximumRecordBytes > 64 * 1_048_576
    ) {
      throw new RangeError(
        "maximumRecordBytes must be an integer from 64 to 67108864",
      );
    }
  }

  /**
   * 立即刷盘:校验记录、按时间+ID 排序、分批调用 writer,并报告持久化/
   * 跳过统计;同批内重复 ID 跳过,此前已持久化的 ID 不再重复写入。
   */
  public async flushNow(
    records: readonly BufferedRecord[],
    writer: (batch: readonly BufferedRecord[]) => Promise<void>,
    batchSize = 128,
  ): Promise<FlushReport> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError("batchSize must be a positive integer");
    }

    const queuedAt = this.clock();
    if (!Number.isFinite(queuedAt)) {
      throw new RangeError("clock must return a finite epoch value");
    }

    const prepared: BufferedRecord[] = [];
    const inputIds = new Set<string>();
    let skipped = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const normalizedId = record.id.trim();
      if (normalizedId.length === 0) {
        throw new TypeError(`record ${index} has an empty id`);
      }
      if (!Number.isFinite(record.timestamp) || record.timestamp < 0) {
        throw new RangeError(`record ${normalizedId} has an invalid timestamp`);
      }
      for (const [fieldName, fieldValue] of Object.entries(record.fields)) {
        if (!/^[a-z][a-z0-9_.-]{0,63}$/iu.test(fieldName)) {
          throw new TypeError(
            `record ${normalizedId} has an invalid field name: ${fieldName}`,
          );
        }
        if (typeof fieldValue === "number" && !Number.isFinite(fieldValue)) {
          throw new RangeError(
            `record ${normalizedId} field ${fieldName} is non-finite`,
          );
        }
        if (typeof fieldValue === "string" && fieldValue.includes("\u0000")) {
          throw new TypeError(
            `record ${normalizedId} field ${fieldName} contains a null byte`,
          );
        }
      }
      if (inputIds.has(normalizedId)) {
        skipped += 1;
        continue;
      }
      inputIds.add(normalizedId);
      prepared.push(
        copyRecord({
          id: normalizedId,
          timestamp: record.timestamp,
          fields: record.fields,
        }),
      );
      const preparedBytes = encodedLength(prepared.at(-1)!);
      if (preparedBytes > this.maximumRecordBytes) {
        throw new RangeError(
          `record ${normalizedId} exceeds ${this.maximumRecordBytes} bytes`,
        );
      }
    }
    prepared.sort((left, right) => {
      const byTime = left.timestamp - right.timestamp;
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

    let release!: () => void;
    const predecessor = this.writeTail;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;

    const startedAt = this.clock();
    if (!Number.isFinite(startedAt)) {
      release();
      throw new RangeError("clock must return a finite epoch value");
    }

    try {
      const pending: BufferedRecord[] = [];
      for (const record of prepared) {
        if (this.persistedIds.has(record.id)) {
          skipped += 1;
          continue;
        }
        pending.push(record);
      }

      let persisted = 0;
      let batches = 0;
      let bytes = 0;
      let largestBatchBytes = 0;
      const batchRecordCounts: number[] = [];
      const batchByteCounts: number[] = [];
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        const mutableBatch = pending.slice(offset, offset + batchSize);
        const batch = Object.freeze(mutableBatch.map(copyRecord));
        await writer(batch);

        // 批次整体确认后才把 ID 记为持久化:若后续批次失败,重试从首个
        // 未确认的 ID 开始,避免部分成功导致的重复写入。
        let batchBytes = 0;
        for (const record of batch) {
          this.persistedIds.add(record.id);
          const recordBytes = encodedLength(record);
          bytes += recordBytes;
          batchBytes += recordBytes;
        }
        largestBatchBytes = Math.max(largestBatchBytes, batchBytes);
        batchRecordCounts.push(batch.length);
        batchByteCounts.push(batchBytes);
        persisted += batch.length;
        batches += 1;
      }

      const completedAt = this.clock();
      if (!Number.isFinite(completedAt)) {
        throw new RangeError("clock must return a finite epoch value");
      }
      return Object.freeze({
        persisted,
        skipped,
        batches,
        bytes,
        largestBatchBytes,
        batchRecordCounts: Object.freeze(batchRecordCounts),
        batchByteCounts: Object.freeze(batchByteCounts),
        elapsedMs: Math.max(0, completedAt - startedAt),
        queueDelayMs: Math.max(0, startedAt - queuedAt),
        queuedAt,
        startedAt,
        completedAt,
        firstId: pending[0]?.id,
        lastId: pending.at(-1)?.id,
      });
    } finally {
      release();
    }
  }

  /** 把记录按批大小切分为冻结批次,逐条校验 ID/时间戳与字节上限。 */
  public partitionBatches(
    records: readonly BufferedRecord[],
    batchSize: number,
  ): readonly (readonly BufferedRecord[])[] {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError("batchSize must be a positive integer");
    }

    const batches: (readonly BufferedRecord[])[] = [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const end = Math.min(records.length, offset + batchSize);
      const batch: BufferedRecord[] = [];
      for (let index = offset; index < end; index += 1) {
        const record = records[index]!;
        if (record.id.trim().length === 0) {
          throw new TypeError(`record ${index} has an empty id`);
        }
        if (!Number.isFinite(record.timestamp)) {
          throw new RangeError(`record ${record.id} has an invalid timestamp`);
        }
        const copied = copyRecord(record);
        if (encodedLength(copied) > this.maximumRecordBytes) {
          throw new RangeError(
            `record ${record.id} exceeds ${this.maximumRecordBytes} bytes`,
          );
        }
        batch.push(copied);
      }
      batches.push(Object.freeze(batch));
    }
    return Object.freeze(batches);
  }

  /** 按时间+ID 排序后按 ID 去重,返回冻结后的唯一记录列表。 */
  public deduplicateRows(
    records: readonly BufferedRecord[],
  ): readonly BufferedRecord[] {
    const ordered = [...records].sort((left, right) => {
      const byTime = left.timestamp - right.timestamp;
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

    const byId = new Map<string, BufferedRecord>();
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]!;
      const id = record.id.trim();
      if (id.length === 0) {
        throw new TypeError(`ordered record ${index} has an empty id`);
      }
      if (!Number.isFinite(record.timestamp)) {
        throw new RangeError(`record ${id} has an invalid timestamp`);
      }
      if (!byId.has(id)) {
        byId.set(id, copyRecord({ ...record, id }));
      }
    }
    return Object.freeze([...byId.values()]);
  }

  /**
   * 评估持久性策略:排序并校验写入提示键,计算字节与滚动校验和,
   * 归一化并去重目标,并标记请求时刻是否超出当前时钟。
   */
  public evaluateDurabilityPolicies(
    request: BufferedAppenderInput,
  ): DurabilityInspection {
    const streamId = request.streamId.trim();
    if (streamId.length === 0) {
      throw new TypeError("streamId must not be empty");
    }
    if (!Number.isFinite(request.flushRequestedAt)) {
      throw new RangeError("flushRequestedAt must be finite");
    }

    const orderedHints = Object.entries(request.writeHints).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const orderedKeys: string[] = [];
    const invalidKeys: string[] = [];
    let estimatedBytes = 0;
    let rollingChecksum = 2_166_136_261;
    const encoder = new TextEncoder();

    for (const [rawKey, value] of orderedHints) {
      const key = rawKey.trim();
      if (!/^[a-z][a-z0-9_.-]{0,63}$/iu.test(key)) {
        invalidKeys.push(rawKey);
      } else {
        orderedKeys.push(key);
      }
      const encoded = encoder.encode(`${key}=${String(value)}`);
      estimatedBytes += encoded.byteLength;
      for (const byte of encoded) {
        rollingChecksum = Math.imul(rollingChecksum ^ byte, 16_777_619) >>> 0;
      }
    }

    const normalizedDestinations: string[] = [];
    const duplicateDestinations: string[] = [];
    const seenDestinations = new Set<string>();
    for (const rawDestination of request.destinations ?? []) {
      const destination = rawDestination.trim().toLowerCase();
      if (destination.length === 0) {
        continue;
      }
      if (seenDestinations.has(destination)) {
        duplicateDestinations.push(destination);
        continue;
      }
      seenDestinations.add(destination);
      normalizedDestinations.push(destination);
    }
    normalizedDestinations.sort();
    duplicateDestinations.sort();

    const now = this.clock();
    return Object.freeze({
      streamId,
      orderedKeys: Object.freeze(orderedKeys),
      invalidKeys: Object.freeze(invalidKeys),
      duplicateDestinations: Object.freeze(duplicateDestinations),
      normalizedDestinations: Object.freeze(normalizedDestinations),
      estimatedBytes,
      rollingChecksum,
      requestedInFuture:
        Number.isFinite(now) && request.flushRequestedAt > now + 1_000,
    });
  }
}
