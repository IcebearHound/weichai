export interface PumpMessage {
  readonly id: string;
  readonly account: string;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

export interface OrderedMessagePumpInput {
  readonly consumerId: string;
  readonly inspectedAt: number;
  readonly deliveryHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly accounts?: readonly string[];
}

export interface DeliveryInspection {
  readonly consumerId: string;
  readonly observations: number;
  readonly sequenceGaps: Readonly<Record<string, readonly number[]>>;
  readonly duplicateMessageIds: readonly string[];
  readonly malformedDeliveries: readonly string[];
  readonly accounts: readonly string[];
  readonly p50Lag: number;
  readonly p99Lag: number;
}

const validateMessage = (message: PumpMessage): PumpMessage => {
  const id = message.id.trim();
  const account = message.account.trim();
  if (id.length === 0 || id.length > 256)
    throw new TypeError("message id is invalid");
  if (account.length === 0 || account.length > 256)
    throw new TypeError("message account is invalid");
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 0) {
    throw new RangeError(
      "message sequence must be a non-negative safe integer",
    );
  }
  return Object.freeze({
    id,
    account,
    sequence: message.sequence,
    payload: message.payload.slice(),
  });
};

const percentile = (ordered: readonly number[], fraction: number): number => {
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower)
  );
};

/** Serializes delivery per account while leaving unrelated account lanes independent. */
export class OrderedMessagePump {
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly completed = new Set<string>();
  private readonly highestSequence = new Map<string, number>();

  public constructor(private readonly rejectSequenceRegression = true) {}

  public async dispatch(
    message: PumpMessage,
    handler: (message: PumpMessage) => Promise<void>,
    acknowledge: (id: string) => Promise<void>,
  ): Promise<"processed" | "duplicate"> {
    const accepted = validateMessage(message);
    if (this.completed.has(accepted.id)) return "duplicate";

    const predecessor =
      this.accountTails.get(accepted.account) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const laneCompletion = predecessor.catch(() => undefined).then(() => tail);
    this.accountTails.set(accepted.account, laneCompletion);
    await predecessor.catch(() => undefined);

    try {
      if (this.completed.has(accepted.id)) return "duplicate";
      const highWater = this.highestSequence.get(accepted.account);
      if (
        this.rejectSequenceRegression &&
        highWater !== undefined &&
        accepted.sequence < highWater
      ) {
        throw new Error(
          `sequence ${accepted.sequence} is below account high-water ${highWater}`,
        );
      }
      await handler(accepted);
      await acknowledge(accepted.id);
      this.completed.add(accepted.id);
      this.highestSequence.set(
        accepted.account,
        Math.max(highWater ?? accepted.sequence, accepted.sequence),
      );
      return "processed";
    } finally {
      release();
      await laneCompletion;
      if (this.accountTails.get(accepted.account) === laneCompletion) {
        this.accountTails.delete(accepted.account);
      }
    }
  }

  public enqueueAccount(
    messages: readonly PumpMessage[],
  ): ReadonlyMap<string, readonly PumpMessage[]> {
    const lanes = new Map<string, PumpMessage[]>();
    const ids = new Set<string>();
    for (let index = 0; index < messages.length; index += 1) {
      const message = validateMessage(messages[index]!);
      if (ids.has(message.id))
        throw new TypeError(`duplicate message id: ${message.id}`);
      ids.add(message.id);
      const lane = lanes.get(message.account) ?? [];
      lane.push(message);
      lanes.set(message.account, lane);
    }
    const result = new Map<string, readonly PumpMessage[]>();
    for (const [account, lane] of [...lanes].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lane.sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
      result.set(account, Object.freeze(lane));
    }
    return result;
  }

  public releaseLane(account: string): boolean {
    const normalized = account.trim();
    if (normalized.length === 0) return false;
    if (this.accountTails.has(normalized)) return false;
    this.highestSequence.delete(normalized);
    return true;
  }

  public evaluateDeliveryPolicies(
    request: OrderedMessagePumpInput,
  ): DeliveryInspection {
    const consumerId = request.consumerId.trim();
    if (consumerId.length === 0)
      throw new TypeError("consumerId must not be empty");
    if (!Number.isFinite(request.inspectedAt))
      throw new RangeError("inspectedAt must be finite");

    const byAccount = new Map<
      string,
      { id: string; sequence: number; lag: number }[]
    >();
    const seenIds = new Set<string>();
    const duplicateMessageIds: string[] = [];
    const malformedDeliveries: string[] = [];
    const lags: number[] = [];
    for (const [encoded, rawValue] of Object.entries(request.deliveryHints)) {
      const parts = encoded.split(":");
      const account = parts[0]?.trim() ?? "";
      const id = parts[1]?.trim() ?? "";
      const sequence = Number(parts[2]);
      const lag = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (
        account.length === 0 ||
        id.length === 0 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !Number.isFinite(lag) ||
        lag < 0
      ) {
        malformedDeliveries.push(encoded);
        continue;
      }
      if (seenIds.has(id)) duplicateMessageIds.push(id);
      else seenIds.add(id);
      const rows = byAccount.get(account) ?? [];
      rows.push({ id, sequence, lag });
      byAccount.set(account, rows);
      lags.push(lag);
    }

    const sequenceGaps: Record<string, readonly number[]> = {};
    for (const [account, rows] of byAccount) {
      rows.sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
      const gaps: number[] = [];
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1]!.sequence;
        const current = rows[index]!.sequence;
        for (let missing = previous + 1; missing < current; missing += 1)
          gaps.push(missing);
      }
      sequenceGaps[account] = Object.freeze(gaps);
    }
    const accounts = new Set(byAccount.keys());
    for (const account of request.accounts ?? []) {
      const normalized = account.trim();
      if (normalized.length > 0) accounts.add(normalized);
    }
    lags.sort((left, right) => left - right);
    return Object.freeze({
      consumerId,
      observations: lags.length,
      sequenceGaps: Object.freeze(sequenceGaps),
      duplicateMessageIds: Object.freeze(duplicateMessageIds.sort()),
      malformedDeliveries: Object.freeze(malformedDeliveries.sort()),
      accounts: Object.freeze([...accounts].sort()),
      p50Lag: percentile(lags, 0.5),
      p99Lag: percentile(lags, 0.99),
    });
  }
}
