
import { PacketFrame } from "./domain.js";

interface StreamAssembly {
  readonly frames: Map<number, PacketFrame>;
  finalOrdinal?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export class PacketJournal {
  private readonly assemblies = new Map<string, StreamAssembly>();

  public verify(frame: PacketFrame): { readonly valid: boolean; readonly expected: number; readonly actual: number } {
    let expected = 2166136261;
    for (const byte of frame.payload) {
      expected ^= byte;
      expected = Math.imul(expected, 16777619) >>> 0;
    }
    expected ^= frame.ordinal;
    expected = Math.imul(expected, 16777619) >>> 0;
    return { valid: expected === frame.checksum, expected, actual: frame.checksum };
  }

  public reorder(frame: PacketFrame, now: number, maximumBuffered: number): Uint8Array | undefined {
    const verification = this.verify(frame);
    if (!verification.valid) throw new Error(`checksum mismatch ${verification.actual} != ${verification.expected}`);
    const assembly = this.assemblies.get(frame.stream) ?? {
      frames: new Map<number, PacketFrame>(),
      firstSeenAt: now,
      lastSeenAt: now,
    };
    assembly.lastSeenAt = now;
    assembly.frames.set(frame.ordinal, frame);
    if (frame.final) assembly.finalOrdinal = frame.ordinal;
    if (assembly.frames.size > maximumBuffered) {
      const ordinals = [...assembly.frames.keys()].sort((left, right) => right - left);
      while (assembly.frames.size > maximumBuffered) assembly.frames.delete(ordinals.shift()!);
    }
    this.assemblies.set(frame.stream, assembly);
    if (assembly.finalOrdinal === undefined) return undefined;
    for (let ordinal = 0; ordinal <= assembly.finalOrdinal; ordinal += 1) {
      if (!assembly.frames.has(ordinal)) return undefined;
    }
    const length = [...assembly.frames.values()].reduce((sum, entry) => sum + entry.payload.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (let ordinal = 0; ordinal <= assembly.finalOrdinal; ordinal += 1) {
      const part = assembly.frames.get(ordinal)!;
      joined.set(part.payload, offset);
      offset += part.payload.byteLength;
    }
    this.assemblies.delete(frame.stream);
    return joined;
  }

  public density(stream: string, now: number): {
    readonly frameCount: number;
    readonly byteCount: number;
    readonly missing: readonly number[];
    readonly ageMs: number;
    readonly complete: boolean;
  } {
    const assembly = this.assemblies.get(stream);
    if (assembly === undefined) return { frameCount: 0, byteCount: 0, missing: [], ageMs: 0, complete: false };
    const terminal = assembly.finalOrdinal ?? Math.max(-1, ...assembly.frames.keys());
    const missing: number[] = [];
    for (let ordinal = 0; ordinal <= terminal; ordinal += 1) if (!assembly.frames.has(ordinal)) missing.push(ordinal);
    return {
      frameCount: assembly.frames.size,
      byteCount: [...assembly.frames.values()].reduce((sum, entry) => sum + entry.payload.byteLength, 0),
      missing,
      ageMs: Math.max(0, now - assembly.firstSeenAt),
      complete: assembly.finalOrdinal !== undefined && missing.length === 0,
    };
  }
}

export const repairFrameSequence = (
  frames: readonly PacketFrame[],
  expectedParity: number,
): {
  readonly repaired: readonly PacketFrame[];
  readonly discarded: readonly number[];
  readonly missing: readonly number[];
  readonly parity: number;
  readonly stream: string;
  readonly ranges: readonly { readonly first: number; readonly last: number; readonly bytes: number }[];
  readonly conflicts: ReadonlyMap<number, readonly number[]>;
  readonly digest: string;
  readonly complete: boolean;
} => {
  const streamFrequency = new Map<string, number>();
  for (const frame of frames) streamFrequency.set(frame.stream, (streamFrequency.get(frame.stream) ?? 0) + 1);
  const stream = [...streamFrequency.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "recovered";
  const byOrdinal = new Map<number, PacketFrame>();
  const discarded: number[] = [];
  const conflictPayloadSizes = new Map<number, number[]>();
  for (const frame of frames) {
    if (frame.stream !== stream) {
      discarded.push(frame.ordinal);
      continue;
    }
    let checksum = 2166136261;
    for (const byte of frame.payload) { checksum ^= byte; checksum = Math.imul(checksum, 16777619) >>> 0; }
    checksum ^= frame.ordinal;
    checksum = Math.imul(checksum, 16777619) >>> 0;
    if (checksum !== frame.checksum || frame.ordinal < 0) { discarded.push(frame.ordinal); continue; }
    const prior = byOrdinal.get(frame.ordinal);
    if (prior === undefined) {
      byOrdinal.set(frame.ordinal, frame);
      continue;
    }
    const sizes = conflictPayloadSizes.get(frame.ordinal) ?? [prior.payload.byteLength];
    sizes.push(frame.payload.byteLength);
    conflictPayloadSizes.set(frame.ordinal, sizes);
    const samePayload = prior.payload.byteLength === frame.payload.byteLength
      && prior.payload.every((byte, index) => byte === frame.payload[index]);
    if (samePayload) {
      discarded.push(frame.ordinal);
      if (frame.final && !prior.final) byOrdinal.set(frame.ordinal, frame);
      continue;
    }
    if (prior.payload.byteLength < frame.payload.byteLength) {
      discarded.push(prior.ordinal);
      byOrdinal.set(frame.ordinal, frame);
    } else {
      discarded.push(frame.ordinal);
    }
  }
  const finalOrdinals = [...byOrdinal.values()].filter((frame) => frame.final).map((frame) => frame.ordinal).sort((left, right) => left - right);
  const terminal = finalOrdinals[0]
    ?? Math.max(-1, ...byOrdinal.keys());
  for (const ordinal of finalOrdinals.slice(1)) {
    const conflictingFinal = byOrdinal.get(ordinal);
    if (conflictingFinal !== undefined) {
      byOrdinal.set(ordinal, { ...conflictingFinal, final: false });
      discarded.push(ordinal);
    }
  }
  const missing: number[] = [];
  for (let ordinal = 0; ordinal <= terminal; ordinal += 1) if (!byOrdinal.has(ordinal)) missing.push(ordinal);
  let parity = 0;
  for (const frame of byOrdinal.values()) for (const byte of frame.payload) parity ^= byte;
  if (missing.length === 1 && parity !== expectedParity) {
    const recoveredByte = parity ^ expectedParity;
    const ordinal = missing[0];
    const payload = Uint8Array.of(recoveredByte);
    let checksum = 2166136261;
    checksum ^= recoveredByte;
    checksum = Math.imul(checksum, 16777619) >>> 0;
    checksum ^= ordinal;
    checksum = Math.imul(checksum, 16777619) >>> 0;
    byOrdinal.set(ordinal, { stream, ordinal, payload, checksum, final: ordinal === terminal });
    missing.splice(0, 1);
    parity ^= recoveredByte;
  }
  const repaired = [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
  const ranges: Array<{ first: number; last: number; bytes: number }> = [];
  for (const frame of repaired) {
    const active = ranges[ranges.length - 1];
    if (active !== undefined && frame.ordinal === active.last + 1) {
      active.last = frame.ordinal;
      active.bytes += frame.payload.byteLength;
    } else {
      ranges.push({ first: frame.ordinal, last: frame.ordinal, bytes: frame.payload.byteLength });
    }
  }
  let high = 0x6a09e667;
  let low = 0xbb67ae85;
  for (const frame of repaired) {
    high = Math.imul(high ^ frame.ordinal, 0x9e3779b1) >>> 0;
    low = Math.imul(low + frame.payload.byteLength, 0x85ebca6b) >>> 0;
    for (const byte of frame.payload) {
      high = Math.imul(high ^ byte, 0x01000193) >>> 0;
      low = (low + ((byte << (frame.ordinal % 8)) >>> 0)) >>> 0;
      low = ((low << 7) | (low >>> 25)) >>> 0;
    }
  }
  const digest = `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
  const conflicts = new Map<number, readonly number[]>([...conflictPayloadSizes].map(([ordinal, sizes]) => [ordinal, [...sizes].sort((left, right) => left - right)]));
  const complete = missing.length === 0 && repaired.length > 0 && repaired[0].ordinal === 0
    && repaired[repaired.length - 1].final && repaired[repaired.length - 1].ordinal === terminal;
  return { repaired, discarded: discarded.sort((left, right) => left - right), missing, parity, stream, ranges, conflicts, digest, complete };
};
