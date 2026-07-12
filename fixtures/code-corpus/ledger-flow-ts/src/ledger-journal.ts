export interface LedgerFrame {
  readonly partition: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly payload: Uint8Array;
  readonly hash: string;
}

export interface LedgerJournalInput {
  readonly ledgerId: string;
  readonly persistedAt: number;
  readonly ledgerFrames: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly partitions?: readonly string[];
}

export interface ChainInspection {
  readonly ledgerId: string;
  readonly orderedKeys: readonly string[];
  readonly malformedKeys: readonly string[];
  readonly missingPartitions: readonly string[];
  readonly rollingChecksum: number;
  readonly frameCount: number;
  readonly payloadBytes: number;
}

const seed = 2_166_136_261;
const prime = 16_777_619;

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

const partitionName = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid ledger partition: ${value}`);
  }
  return normalized;
};

/** Append-only hash chains separated by ledger partition. */
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

  public recover(partition: string): readonly LedgerFrame[] {
    const normalizedPartition = partitionName(partition);
    const frames = this.ledgerFrames.get(normalizedPartition) ?? [];
    const recovered: LedgerFrame[] = [];
    let expectedPrevious = "00000000";
    let previousSequence: number | undefined;
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
