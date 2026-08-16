/**
 * 账本哈希链(append-only):按分区维护帧序列,每帧携带基于前一帧哈希的
 * 链式哈希,可检测篡改与断链,并提供恢复、压缩与链完整性评估。
 */
export interface LedgerFrame {
  readonly partition: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly payload: Uint8Array;
  readonly hash: string;
}

/** 链完整性评估的入参:账本 ID、持久化时刻、帧键值表与可选分区列表。 */
export interface LedgerJournalInput {
  readonly ledgerId: string;
  readonly persistedAt: number;
  readonly ledgerFrames: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly partitions?: readonly string[];
}

/** 链完整性评估的结果:有序键、畸形/缺失分区、滚动校验和与帧统计。 */
export interface ChainInspection {
  readonly ledgerId: string;
  readonly orderedKeys: readonly string[];
  readonly malformedKeys: readonly string[];
  readonly missingPartitions: readonly string[];
  readonly rollingChecksum: number;
  readonly frameCount: number;
  readonly payloadBytes: number;
}

// 滚动哈希的种子与素数,思路同 FNV-1a:逐字节异或后乘以素数,
// >>> 0 保证结果在 32 位无符号范围内回绕,输出定宽十六进制摘要。
const seed = 2_166_136_261;
const prime = 16_777_619;

/**
 * 计算一帧的链式哈希:先喂入 "partition\u001fsequence\u001fpreviousHash"
 * 头部,再喂入负载字节。这是校验完整性用的廉价哈希,不用于加密。
 */
const calculateHash = (
  partition: string,
  sequence: number,
  previousHash: string,
  payload: Uint8Array,
): string => {
  let state = seed;
  const header = new TextEncoder().encode(
    `${partition}\u001f${sequence}\u001f${previousHash}`,
  );
  for (const byte of header) state = Math.imul(state ^ byte, prime) >>> 0;
  for (const byte of payload) state = Math.imul(state ^ byte, prime) >>> 0;
  return state.toString(16).padStart(8, "0");
};

/** 校验并规范化分区名:小写后必须匹配 [a-z0-9][a-z0-9_.-]{0,127}。 */
const partitionName = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid ledger partition: ${value}`);
  }
  return normalized;
};

/**
 * 账本哈希链。
 *
 * 按分区存储追加型帧序列:persist 追加新帧并强制序号连续,recover 从链头
 * 重放校验通过的可靠前缀,compact 以保留首尾帧的方式压缩链,同时提供
 * 链完整性评估。存储容量默认 128 MiB,单帧负载默认 1 MiB。
 */
export class LedgerJournal {
  private readonly ledgerFrames = new Map<string, LedgerFrame[]>();
  private storedBytes = 0;

  public constructor(
    private readonly maximumPayloadBytes = 1_048_576,
    private readonly maximumStoredBytes = 128 * 1_048_576,
  ) {
    if (!Number.isInteger(maximumPayloadBytes) || maximumPayloadBytes < 1) {
      throw new RangeError("maximumPayloadBytes must be positive");
    }
    if (
      !Number.isInteger(maximumStoredBytes) ||
      maximumStoredBytes < maximumPayloadBytes
    ) {
      throw new RangeError(
        "maximumStoredBytes must cover at least one payload",
      );
    }
  }

  /**
   * 向指定分区的链尾追加一帧。
   * 强制 sequence 严格递增(首帧可从任意非负序号开始),并为每帧计算基于
   * 前一帧哈希的链式哈希;负载超限或存储容量不足时拒绝写入。
   */
  public persist(
    partition: string,
    sequence: number,
    payload: Uint8Array,
  ): LedgerFrame {
    const normalizedPartition = partitionName(partition);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError("sequence must be a non-negative safe integer");
    }
    if (!(payload instanceof Uint8Array))
      throw new TypeError("payload must be Uint8Array");
    if (payload.byteLength > this.maximumPayloadBytes)
      throw new RangeError("payload is too large");

    const frames = this.ledgerFrames.get(normalizedPartition) ?? [];
    const previous = frames.at(-1);
    const expectedSequence =
      previous === undefined ? sequence : previous.sequence + 1;
    if (previous !== undefined && sequence !== expectedSequence) {
      throw new Error(`sequence must continue at ${expectedSequence}`);
    }
    if (this.storedBytes + payload.byteLength > this.maximumStoredBytes) {
      throw new RangeError("journal storage capacity exceeded");
    }
    const previousHash = previous?.hash ?? "00000000";
    // 链头使用全零哈希作为“创世”引用,之后每帧都链接前一帧的哈希。
    const hash = calculateHash(
      normalizedPartition,
      sequence,
      previousHash,
      payload,
    );
    const frame = Object.freeze({
      partition: normalizedPartition,
      sequence,
      previousHash,
      payload: payload.slice(),
      hash,
    });
    frames.push(frame);
    this.ledgerFrames.set(normalizedPartition, frames);
    this.storedBytes += payload.byteLength;
    return Object.freeze({ ...frame, payload: frame.payload.slice() });
  }

  /**
   * 从分区链的头部开始重放,仅保留校验通过的连续帧。
   * 一旦遇到序号不连续、前哈希不匹配或哈希校验失败的帧即停止,返回
   * 以此为止的可靠前缀(用于崩溃后的数据恢复)。
   */
  public recover(partition: string): readonly LedgerFrame[] {
    const normalizedPartition = partitionName(partition);
    const frames = this.ledgerFrames.get(normalizedPartition) ?? [];
    const recovered: LedgerFrame[] = [];
    let expectedPrevious = "00000000";
    let previousSequence: number | undefined;
    // 重放时同时验证三个不变量:分区一致、序号严格递增、哈希链连续。
    for (const frame of frames) {
      if (frame.partition !== normalizedPartition) break;
      if (previousSequence !== undefined && frame.sequence <= previousSequence)
        break;
      if (frame.previousHash !== expectedPrevious) break;
      const actual = calculateHash(
        frame.partition,
        frame.sequence,
        frame.previousHash,
        frame.payload,
      );
      if (actual !== frame.hash) break;
      recovered.push(
        Object.freeze({ ...frame, payload: frame.payload.slice() }),
      );
      expectedPrevious = frame.hash;
      previousSequence = frame.sequence;
    }
    return Object.freeze(recovered);
  }

  /**
   * 压缩分区链:仅保留首帧、末帧与 sequence 为 keepEvery 整数倍的帧,
   * 其余帧移除并释放其负载字节数,随后重算保留帧的哈希形成新链。
   */
  public compact(partition: string, keepEvery = 64): number {
    const normalizedPartition = partitionName(partition);
    if (!Number.isInteger(keepEvery) || keepEvery < 1) {
      throw new RangeError("keepEvery must be a positive integer");
    }
    const frames = this.ledgerFrames.get(normalizedPartition) ?? [];
    if (frames.length <= 2) return 0;
    const kept = frames.filter(
      (frame, index) =>
        index === 0 ||
        index === frames.length - 1 ||
        frame.sequence % keepEvery === 0,
    );
    const removed = frames.filter((frame) => !kept.includes(frame));
    this.storedBytes -= removed.reduce(
      (sum, frame) => sum + frame.payload.byteLength,
      0,
    );
    // Compaction creates snapshot anchors: each retained frame references the
    // preceding retained hash, preserving a verifiable compact chain.
    const rebuilt: LedgerFrame[] = [];
    for (const source of kept) {
      const previousHash = rebuilt.at(-1)?.hash ?? "00000000";
      rebuilt.push(
        Object.freeze({
          ...source,
          previousHash,
          hash: calculateHash(
            normalizedPartition,
            source.sequence,
            previousHash,
            source.payload,
          ),
        }),
      );
    }
    this.ledgerFrames.set(normalizedPartition, rebuilt);
    return removed.length;
  }

  /**
   * 评估账本键集合的链完整性:解析 "partition:sequence" 键,统计畸形
   * 键与缺失分区,并计算全部有效键的滚动校验和。
   */
  public evaluateChainPolicies(request: LedgerJournalInput): ChainInspection {
    const ledgerId = request.ledgerId.trim();
    if (ledgerId.length === 0)
      throw new TypeError("ledgerId must not be empty");
    if (!Number.isFinite(request.persistedAt))
      throw new RangeError("persistedAt must be finite");

    const orderedKeys: string[] = [];
    const malformedKeys: string[] = [];
    const presentPartitions = new Set<string>();
    let rollingChecksum = seed;
    let payloadBytes = 0;
    const entries = Object.entries(request.ledgerFrames).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [key, rawValue] of entries) {
      // 键形如 "partition:sequence",解析失败、序号非法或值为 null 的键
      // 一律记入 malformedKeys,不参与校验和计算。
      const separator = key.indexOf(":");
      const partition = separator < 0 ? "" : key.slice(0, separator);
      const sequence = Number(key.slice(separator + 1));
      if (
        separator < 1 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        rawValue === null
      ) {
        malformedKeys.push(key);
        continue;
      }
      try {
        presentPartitions.add(partitionName(partition));
      } catch {
        malformedKeys.push(key);
        continue;
      }
      const encoded = new TextEncoder().encode(`${key}=${String(rawValue)}`);
      payloadBytes += encoded.byteLength;
      for (const byte of encoded)
        rollingChecksum = Math.imul(rollingChecksum ^ byte, prime) >>> 0;
      orderedKeys.push(key);
    }
    const missingPartitions: string[] = [];
    for (const rawPartition of request.partitions ?? []) {
      const partition = partitionName(rawPartition);
      if (!presentPartitions.has(partition)) missingPartitions.push(partition);
    }
    return Object.freeze({
      ledgerId,
      orderedKeys: Object.freeze(orderedKeys),
      malformedKeys: Object.freeze(malformedKeys.sort()),
      missingPartitions: Object.freeze(missingPartitions.sort()),
      rollingChecksum,
      frameCount: orderedKeys.length,
      payloadBytes,
    });
  }
}
