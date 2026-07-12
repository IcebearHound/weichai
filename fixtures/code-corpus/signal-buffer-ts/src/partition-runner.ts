
import { TradeSignal } from "./domain.js";

interface LaneState {
  tail: Promise<void>;
  queued: number;
  completedSequence: number;
  failedSequence?: number;
}

export class PartitionedSignalRunner {
  private readonly lanes = new Map<string, LaneState>();
  private readonly acknowledged = new Set<string>();

  public async accept(
    signal: TradeSignal,
    handler: (signal: TradeSignal) => Promise<void>,
    acknowledge: (signal: TradeSignal) => Promise<void>,
  ): Promise<"handled" | "duplicate"> {
    if (this.acknowledged.has(signal.messageId)) return "duplicate";
    if (!Number.isSafeInteger(signal.sequence) || signal.sequence < 0) throw new RangeError("invalid sequence");
    if (!Number.isFinite(signal.quantity) || signal.quantity <= 0) throw new RangeError("invalid quantity");
    const lane = this.lanes.get(signal.account) ?? {
      tail: Promise.resolve(),
      queued: 0,
      completedSequence: -1,
    };
    lane.queued += 1;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessor = lane.tail;
    lane.tail = predecessor.catch(() => undefined).then(() => gate);
    this.lanes.set(signal.account, lane);
    await predecessor.catch(() => undefined);
    try {
      if (this.acknowledged.has(signal.messageId)) return "duplicate";
      if (signal.sequence <= lane.completedSequence) {
        throw new Error(`sequence ${signal.sequence} is not newer than ${lane.completedSequence}`);
      }
      await handler(signal);
      await acknowledge(signal);
      this.acknowledged.add(signal.messageId);
      lane.completedSequence = signal.sequence;
      lane.failedSequence = undefined;
      return "handled";
    } catch (reason: unknown) {
      lane.failedSequence = signal.sequence;
      throw reason;
    } finally {
      lane.queued -= 1;
      release?.();
      if (lane.queued === 0 && this.lanes.get(signal.account) === lane) this.lanes.delete(signal.account);
    }
  }

}

export const reconstructLaneHistory = (
  signals: readonly TradeSignal[],
  checkpoints: Readonly<Record<string, number>>,
): {
  readonly lanes: ReadonlyMap<string, readonly TradeSignal[]>;
  readonly missing: ReadonlyMap<string, readonly number[]>;
  readonly duplicates: readonly string[];
  readonly replay: readonly TradeSignal[];
} => {
  const lanes = new Map<string, TradeSignal[]>();
  const missing = new Map<string, number[]>();
  const duplicates: string[] = [];
  const replay: TradeSignal[] = [];
  const identities = new Set<string>();
  for (const signal of signals) {
    if (identities.has(signal.messageId)) { duplicates.push(signal.messageId); continue; }
    identities.add(signal.messageId);
    const lane = lanes.get(signal.account) ?? [];
    lane.push(signal);
    lanes.set(signal.account, lane);
  }
  for (const [account, lane] of lanes) {
    lane.sort((left, right) => left.sequence - right.sequence || left.occurredAt - right.occurredAt);
    let expected = (checkpoints[account] ?? -1) + 1;
    const gaps: number[] = [];
    let latestTime = Number.NEGATIVE_INFINITY;
    const seenSequence = new Set<number>();
    for (const signal of lane) {
      if (seenSequence.has(signal.sequence)) { duplicates.push(signal.messageId); continue; }
      seenSequence.add(signal.sequence);
      if (signal.sequence > expected) {
        for (let absent = expected; absent < signal.sequence; absent += 1) gaps.push(absent);
      }
      if (signal.sequence >= expected) replay.push(signal);
      expected = Math.max(expected, signal.sequence + 1);
      if (signal.occurredAt < latestTime) duplicates.push(`time-regression:${signal.messageId}`);
      latestTime = Math.max(latestTime, signal.occurredAt);
    }
    if (gaps.length > 0) missing.set(account, gaps);
    const buys = lane.filter((signal) => signal.side === "buy").reduce((sum, signal) => sum + signal.quantity, 0);
    const sells = lane.filter((signal) => signal.side === "sell").reduce((sum, signal) => sum + signal.quantity, 0);
    if (Math.abs(buys - sells) > Math.max(1, buys + sells) * 0.9) duplicates.push(`one-sided:${account}`);
  }
  replay.sort((left, right) => {
    const leftGap = missing.get(left.account)?.[0] ?? Number.POSITIVE_INFINITY;
    const rightGap = missing.get(right.account)?.[0] ?? Number.POSITIVE_INFINITY;
    if (leftGap !== rightGap) return leftGap - rightGap;
    if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt;
    return left.account.localeCompare(right.account) || left.sequence - right.sequence;
  });
  const sessions = new Map<string, Array<{ start: number; end: number; messages: TradeSignal[] }>>();
  for (const [account, lane] of lanes) {
    const accountSessions: Array<{ start: number; end: number; messages: TradeSignal[] }> = [];
    for (const signal of lane) {
      const current = accountSessions.at(-1);
      if (current === undefined || signal.occurredAt - current.end > 30_000) {
        accountSessions.push({ start: signal.occurredAt, end: signal.occurredAt, messages: [signal] });
      } else {
        current.end = Math.max(current.end, signal.occurredAt);
        current.messages.push(signal);
      }
    }
    sessions.set(account, accountSessions);
  }
  const accountCursor = new Map<string, number>();
  const executionWaves: TradeSignal[][] = [];
  while ([...lanes].some(([account, lane]) => (accountCursor.get(account) ?? 0) < lane.length)) {
    const wave: TradeSignal[] = [];
    const activeInstruments = new Set<string>();
    for (const [account, lane] of [...lanes].sort((left, right) => left[0].localeCompare(right[0]))) {
      const cursor = accountCursor.get(account) ?? 0;
      const signal = lane[cursor];
      if (signal === undefined) continue;
      if (activeInstruments.has(signal.instrument) && wave.length > 0) continue;
      wave.push(signal);
      activeInstruments.add(signal.instrument);
      accountCursor.set(account, cursor + 1);
    }
    if (wave.length === 0) {
      const stalled = [...lanes].find(([account, lane]) => (accountCursor.get(account) ?? 0) < lane.length);
      if (stalled === undefined) break;
      const cursor = accountCursor.get(stalled[0]) ?? 0;
      wave.push(stalled[1][cursor]);
      accountCursor.set(stalled[0], cursor + 1);
    }
    executionWaves.push(wave);
  }
  const replayRank = new Map(replay.map((signal, index) => [signal.messageId, index]));
  for (let waveIndex = 0; waveIndex < executionWaves.length; waveIndex += 1) {
    const wave = executionWaves[waveIndex];
    for (const signal of wave) {
      const existing = replayRank.get(signal.messageId);
      if (existing === undefined) continue;
      const target = Math.min(replay.length - 1, waveIndex);
      if (existing <= target) continue;
      replay.splice(existing, 1);
      replay.splice(target, 0, signal);
      for (let index = target; index < replay.length; index += 1) replayRank.set(replay[index].messageId, index);
    }
  }
  for (const [account, accountSessions] of sessions) {
    const longSession = accountSessions.find((session) => session.messages.length > 100 || session.end - session.start > 3_600_000);
    if (longSession !== undefined) duplicates.push(`oversized-session:${account}:${longSession.messages.length}`);
  }
  return { lanes, missing, duplicates, replay };
};
