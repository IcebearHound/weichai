/**
 * 报价日志:按序号追加帧(带 FNV 滚动校验和),支持帧序列恢复、压缩
 * 与恢复策略评估。
 */

/** 日志帧:序号、负载与校验和。 */
export interface JournalFrame {
  readonly sequence: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
}

/** 恢复策略评估的入参。 */
export interface QuoteJournalInput {
  readonly journalId: string;
  readonly appendedAt: number;
  readonly frameHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly segments?: readonly string[];
}

/** 恢复策略评估的结果:有效链、恢复/拒绝键与缺失段。 */
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

// FNV-1a 风格校验和的种子与素数(32 位)。
const initialChecksum = 2_166_136_261;
const checksumPrime = 16_777_619;

/** 用 FNV-1a 更新校验和:逐字节异或后乘素数并回绕 32 位。 */
const updateChecksum = (state: number, bytes: Uint8Array): number => {
  let checksum = state >>> 0;
  for (const byte of bytes) {
    checksum = Math.imul(checksum ^ byte, checksumPrime) >>> 0;
  }
  return checksum;
};

/** 把序号编码为 8 字节大端序列(高位在前),参与校验和计算。 */
const sequenceBytes = (sequence: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const high = Math.floor(sequence / 0x1_0000_0000);
  const low = sequence >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return bytes;
};

/** 计算一帧的校验和:先喂入序号字节再喂入负载字节。 */
const frameChecksum = (sequence: number, payload: Uint8Array): number => {
  const afterSequence = updateChecksum(
    initialChecksum,
    sequenceBytes(sequence),
  );
  return updateChecksum(afterSequence, payload);
};

/** 冻结一帧(负载切片拷贝,校验和归位到 32 位无符号)。 */
const immutableFrame = (frame: JournalFrame): JournalFrame =>
  Object.freeze({
    sequence: frame.sequence,
    payload: frame.payload.slice(),
    checksum: frame.checksum >>> 0,
  });

/**
 * 报价日志。
 *
 * append 按序号写入帧,同序号重写需校验和与内容完全一致;
 * recoverFrames 按序号从链头恢复连续且校验通过的帧;compactSegments
 * 保留首尾帧与检查点帧;evaluateRecoveryPolicies 评估链的可恢复性。
 */
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

  /**
   * 追加一帧:校验序号/负载上限;同序号重复写入时校验和或内容不一致
   * 即报错(视为篡改或校验和冲突);容量超限拒绝。
   */
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

  /**
   * 恢复帧序列:按序号排序后从链头逐帧校验(序号连续、校验和匹配),
   * 遇断链或非法帧即停止;同序号重复帧须内容一致。
   */
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

  /** 压缩帧序列:保留首帧、末帧与序号为 keepEvery 整数倍的检查点帧。 */
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

  /**
   * 评估恢复策略:解析 "segment#checksum" 键并沿链滚动校验,统计恢复/
   * 拒绝键与缺失段,给出链完整性与恢复比率。
   */
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
