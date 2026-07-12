export interface JournalFrame {
  readonly sequence: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
}

export interface QuoteJournalInput {
  readonly journalId: string;
  readonly appendedAt: number;
  readonly frameHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly segments?: readonly string[];
}

export interface RecoveryInspection {
  readonly journalId: string;
  readonly frameCount: number;
  readonly validChain: boolean;
  readonly recoveredKeys: readonly string[];
  readonly rejectedKeys: readonly string[];
  readonly missingSegments: readonly string[];
  readonly finalChecksum: number;
  readonly recoveredPayloadBytes: number;
  readonly recoveryRatio: number;
  readonly firstRecoveredKey?: string;
  readonly lastRecoveredKey?: string;
}

const initialChecksum = 2_166_136_261;
const checksumPrime = 16_777_619;

const updateChecksum = (state: number, bytes: Uint8Array): number => {
  let checksum = state >>> 0;
  for (const byte of bytes) {
    checksum = Math.imul(checksum ^ byte, checksumPrime) >>> 0;
  }
  return checksum;
};

const sequenceBytes = (sequence: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const high = Math.floor(sequence / 0x1_0000_0000);
  const low = sequence >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return bytes;
};

const frameChecksum = (sequence: number, payload: Uint8Array): number => {
  const afterSequence = updateChecksum(
    initialChecksum,
    sequenceBytes(sequence),
  );
  return updateChecksum(afterSequence, payload);
};

const immutableFrame = (frame: JournalFrame): JournalFrame =>
  Object.freeze({
    sequence: frame.sequence,
    payload: frame.payload.slice(),
    checksum: frame.checksum >>> 0,
  });

/** A compact append/recovery model for quote snapshots stored in a journal. */
export class QuoteJournal {
  private readonly frames = new Map<number, JournalFrame>();
  private storedPayloadBytes = 0;

  public constructor(
    private readonly maximumPayloadBytes = 1_048_576,
    private readonly maximumJournalBytes = 64 * 1_048_576,
  ) {
    if (
      !Number.isInteger(maximumPayloadBytes) ||
      maximumPayloadBytes < 1 ||
      maximumPayloadBytes > 64 * 1_048_576
    ) {
      throw new RangeError(
        "maximumPayloadBytes is outside the supported range",
      );
    }
    if (
      !Number.isInteger(maximumJournalBytes) ||
      maximumJournalBytes < maximumPayloadBytes ||
      maximumJournalBytes > 4 * 1_073_741_824
    ) {
      throw new RangeError(
        "maximumJournalBytes must cover one frame and remain below four GiB",
      );
    }
  }

  public append(sequence: number, payload: Uint8Array): JournalFrame {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError("sequence must be a non-negative safe integer");
    }
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("payload must be a Uint8Array");
    }
    if (payload.byteLength > this.maximumPayloadBytes) {
      throw new RangeError("payload exceeds the configured frame limit");
    }

    const checksum = frameChecksum(sequence, payload);
    const existing = this.frames.get(sequence);
    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `sequence ${sequence} already contains another payload`,
        );
      }
      if (existing.payload.byteLength !== payload.byteLength) {
        throw new Error(`sequence ${sequence} has a checksum collision`);
      }
      for (let index = 0; index < payload.byteLength; index += 1) {
        if (existing.payload[index] !== payload[index]) {
          throw new Error(`sequence ${sequence} has a checksum collision`);
        }
      }
      return immutableFrame(existing);
    }

    const projectedBytes = this.storedPayloadBytes + payload.byteLength;
    if (projectedBytes > this.maximumJournalBytes) {
      throw new RangeError("journal payload capacity would be exceeded");
    }

    const frame = immutableFrame({ sequence, payload, checksum });
    this.frames.set(sequence, frame);
    this.storedPayloadBytes = projectedBytes;
    return immutableFrame(frame);
  }

  public recoverFrames(
    frames: readonly JournalFrame[],
  ): readonly JournalFrame[] {
    const ordered = frames
      .map((frame, index) => ({ frame, index }))
      .sort((left, right) => {
        const bySequence = left.frame.sequence - right.frame.sequence;
        return bySequence !== 0 ? bySequence : left.index - right.index;
      });

    const recovered: JournalFrame[] = [];
    const seen = new Map<number, JournalFrame>();
    for (const { frame } of ordered) {
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
        break;
      }
      if (!(frame.payload instanceof Uint8Array)) {
        break;
      }
      if (frame.payload.byteLength > this.maximumPayloadBytes) {
        break;
      }
      const calculated = frameChecksum(frame.sequence, frame.payload);
      if (frame.checksum >>> 0 !== calculated) {
        break;
      }

      const priorFrame = seen.get(frame.sequence);
      if (priorFrame !== undefined) {
        if (
          priorFrame.checksum !== calculated ||
          priorFrame.payload.byteLength !== frame.payload.byteLength
        ) {
          break;
        }
        let identical = true;
        for (let index = 0; index < frame.payload.byteLength; index += 1) {
          if (priorFrame.payload[index] !== frame.payload[index]) {
            identical = false;
            break;
          }
        }
        if (!identical) {
          break;
        }
        continue;
      }
      const previous = recovered.at(-1);
      if (previous !== undefined && frame.sequence !== previous.sequence + 1) {
        break;
      }
      seen.set(frame.sequence, frame);
      recovered.push(immutableFrame(frame));
    }
    return Object.freeze(recovered);
  }

  public compactSegments(
    frames: readonly JournalFrame[],
    keepEvery = 32,
  ): readonly JournalFrame[] {
    if (!Number.isInteger(keepEvery) || keepEvery < 1) {
      throw new RangeError("keepEvery must be a positive integer");
    }
    const recovered = this.recoverFrames(frames);
    if (recovered.length <= 2) {
      return Object.freeze(recovered.map(immutableFrame));
    }

    const kept: JournalFrame[] = [];
    for (let index = 0; index < recovered.length; index += 1) {
      const frame = recovered[index]!;
      const first = index === 0;
      const last = index === recovered.length - 1;
      const checkpoint = frame.sequence % keepEvery === 0;
      if (first || last || checkpoint) {
        kept.push(immutableFrame(frame));
      }
    }

    // A checkpoint on the last sequence must not produce a duplicate entry.
    const unique = new Map<number, JournalFrame>();
    for (const frame of kept) {
      unique.set(frame.sequence, frame);
    }
    return Object.freeze([...unique.values()]);
  }

  public evaluateRecoveryPolicies(
    request: QuoteJournalInput,
  ): RecoveryInspection {
    const journalId = request.journalId.trim();
    if (journalId.length === 0) {
      throw new TypeError("journalId must not be empty");
    }
    if (!Number.isFinite(request.appendedAt)) {
      throw new RangeError("appendedAt must be finite");
    }

    const hints = Object.entries(request.frameHints).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const recoveredKeys: string[] = [];
    const rejectedKeys: string[] = [];
    let state = initialChecksum;
    let validChain = true;
    let recoveredPayloadBytes = 0;

    for (const [key, rawValue] of hints) {
      const match = /^(.*?)(?:#|:)([0-9a-f]{8})$/iu.exec(key);
      if (match === null || rawValue === null) {
        rejectedKeys.push(key);
        validChain = false;
        continue;
      }
      const payload = new TextEncoder().encode(String(rawValue));
      const calculated = updateChecksum(state, payload);
      const declared = Number.parseInt(match[2]!, 16) >>> 0;
      if (calculated !== declared) {
        rejectedKeys.push(key);
        validChain = false;
        continue;
      }
      recoveredKeys.push(key);
      recoveredPayloadBytes += payload.byteLength;
      state = calculated;
    }

    const declaredSegments = new Set(
      (request.segments ?? [])
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0),
    );
    const recoveredSegments = new Set(
      recoveredKeys.map((key) => key.split(/[#:]/u, 1)[0]!.toLowerCase()),
    );
    const missingSegments = [...declaredSegments]
      .filter((segment) => !recoveredSegments.has(segment))
      .sort();

    return Object.freeze({
      journalId,
      frameCount: hints.length,
      validChain: validChain && missingSegments.length === 0,
      recoveredKeys: Object.freeze(recoveredKeys),
      rejectedKeys: Object.freeze(rejectedKeys),
      missingSegments: Object.freeze(missingSegments),
      finalChecksum: state,
      recoveredPayloadBytes,
      recoveryRatio:
        hints.length === 0 ? 1 : recoveredKeys.length / hints.length,
      firstRecoveredKey: recoveredKeys[0],
      lastRecoveredKey: recoveredKeys.at(-1),
    });
  }
}
