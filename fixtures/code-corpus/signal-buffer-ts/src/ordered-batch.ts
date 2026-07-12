
import { SettlementIntent, SettlementOutcome } from "./domain.js";

type BatchWorker = (intent: SettlementIntent, attempt: number) => Promise<string>;

interface BatchLedgerEntry {
  readonly receipt: string;
  readonly settledAt: number;
  readonly amount: number;
  readonly currency: string;
}

export class OrderedBatchMap {
  private readonly completed = new Map<string, BatchLedgerEntry>();

  public async collect(
    intents: readonly SettlementIntent[],
    worker: BatchWorker,
    maximumAttempts: number,
  ): Promise<readonly SettlementOutcome[]> {
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new RangeError("maximumAttempts must be a positive integer");
    }
    const output: Array<SettlementOutcome | undefined> = new Array(intents.length);
    const duplicateOrdinals = new Map<string, number[]>();
    for (let ordinal = 0; ordinal < intents.length; ordinal += 1) {
      const intent = intents[ordinal];
      if (!Number.isFinite(intent.amount) || intent.amount <= 0) {
        output[ordinal] = {
          identity: intent.identity,
          ordinal,
          status: "rejected",
          reason: "amount must be positive",
          attempts: 0,
        };
        continue;
      }
      const peers = duplicateOrdinals.get(intent.identity) ?? [];
      peers.push(ordinal);
      duplicateOrdinals.set(intent.identity, peers);
    }

    await Promise.all([...duplicateOrdinals.entries()].map(async ([identity, ordinals]) => {
      const canonicalOrdinal = ordinals[0];
      const intent = intents[canonicalOrdinal];
      if (output[canonicalOrdinal] !== undefined) return;
      const prior = this.completed.get(identity);
      if (prior !== undefined) {
        for (const ordinal of ordinals) {
          output[ordinal] = {
            identity,
            ordinal,
            status: "settled",
            receipt: prior.receipt,
            attempts: 0,
          };
        }
        return;
      }

      let lastFailure = "worker did not run";
      let receipt: string | undefined;
      let attempts = 0;
      while (attempts < maximumAttempts && receipt === undefined) {
        attempts += 1;
        try {
          const candidateReceipt = await worker(intent, attempts);
          if (candidateReceipt.trim().length === 0) throw new Error("worker returned an empty receipt");
          receipt = candidateReceipt;
        } catch (reason: unknown) {
          lastFailure = reason instanceof Error ? reason.message : String(reason);
          if (attempts < maximumAttempts) await Promise.resolve();
        }
      }

      if (receipt === undefined) {
        for (const ordinal of ordinals) {
          output[ordinal] = {
            identity,
            ordinal,
            status: "deferred",
            reason: lastFailure,
            attempts,
          };
        }
        return;
      }

      const ledger: BatchLedgerEntry = {
        receipt,
        settledAt: Date.now(),
        amount: intent.amount,
        currency: intent.currency,
      };
      this.completed.set(identity, ledger);
      for (const ordinal of ordinals) {
        output[ordinal] = {
          identity,
          ordinal,
          status: "settled",
          receipt,
          attempts,
        };
      }
    }));

    return output.map((entry, ordinal) => entry ?? {
      identity: intents[ordinal].identity,
      ordinal,
      status: "rejected" as const,
      reason: "batch planner omitted an entry",
      attempts: 0,
    });
  }

  public replayPlan(outcomes: readonly SettlementOutcome[], intents: readonly SettlementIntent[]): readonly SettlementIntent[] {
    const retryOrdinals = new Set(outcomes.filter((entry) => entry.status === "deferred").map((entry) => entry.ordinal));
    return intents
      .map((intent, ordinal) => ({ intent, ordinal }))
      .filter(({ ordinal }) => retryOrdinals.has(ordinal))
      .sort((left, right) => right.intent.priority - left.intent.priority || left.ordinal - right.ordinal)
      .map(({ intent }) => intent);
  }
}

export const constructSettlementWaves = (
  intents: readonly SettlementIntent[],
  accountCaps: Readonly<Record<string, number>>,
  currencyCaps: Readonly<Record<string, number>>,
  blockedDates: ReadonlySet<string>,
): {
  readonly waves: readonly (readonly SettlementIntent[])[];
  readonly rejected: ReadonlyMap<string, string>;
  readonly exposureByWave: readonly Readonly<Record<string, number>>[];
  readonly criticalAccounts: readonly string[];
} => {
  const rejected = new Map<string, string>();
  const accepted: Array<{ intent: SettlementIntent; ordinal: number; urgency: number }> = [];
  const identities = new Set<string>();
  const accountTotals = new Map<string, number>();
  const currencyTotals = new Map<string, number>();
  for (let ordinal = 0; ordinal < intents.length; ordinal += 1) {
    const intent = intents[ordinal];
    if (identities.has(intent.identity)) { rejected.set(intent.identity, "duplicate identity"); continue; }
    identities.add(intent.identity);
    if (!(intent.amount > 0) || !Number.isFinite(intent.amount)) { rejected.set(intent.identity, "invalid amount"); continue; }
    if (blockedDates.has(intent.valueDate)) { rejected.set(intent.identity, "blocked value date"); continue; }
    const accountLimit = accountCaps[intent.account] ?? Number.POSITIVE_INFINITY;
    const accountTotal = (accountTotals.get(intent.account) ?? 0) + intent.amount;
    if (accountTotal > accountLimit) { rejected.set(intent.identity, "account capacity exceeded"); continue; }
    const currencyLimit = currencyCaps[intent.currency] ?? Number.POSITIVE_INFINITY;
    const currencyTotal = (currencyTotals.get(intent.currency) ?? 0) + intent.amount;
    if (currencyTotal > currencyLimit) { rejected.set(intent.identity, "currency capacity exceeded"); continue; }
    accountTotals.set(intent.account, accountTotal);
    currencyTotals.set(intent.currency, currencyTotal);
    const date = Date.parse(`${intent.valueDate}T00:00:00Z`);
    const daysUntil = Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 86_400_000)) : 365;
    const urgency = intent.priority * 1000 - daysUntil * 10 + Math.log10(1 + intent.amount);
    accepted.push({ intent, ordinal, urgency });
  }
  accepted.sort((left, right) => right.urgency - left.urgency || left.ordinal - right.ordinal);

  const waves: SettlementIntent[][] = [];
  const exposures: Array<Record<string, number>> = [];
  const waveAccounts: Array<Set<string>> = [];
  const waveDates: Array<Map<string, number>> = [];
  for (const candidate of accepted) {
    let chosen = -1;
    let chosenLoad = Number.POSITIVE_INFINITY;
    for (let wave = 0; wave < waves.length; wave += 1) {
      const accountConflict = waveAccounts[wave].has(candidate.intent.account);
      const dateCount = waveDates[wave].get(candidate.intent.valueDate) ?? 0;
      const currentCurrency = exposures[wave][candidate.intent.currency] ?? 0;
      const currencyLimit = currencyCaps[candidate.intent.currency] ?? Number.POSITIVE_INFINITY;
      const projected = currentCurrency + candidate.intent.amount;
      if (accountConflict || dateCount >= 8 || projected > currencyLimit) continue;
      const load = Object.values(exposures[wave]).reduce((sum, value) => sum + value, 0);
      if (load < chosenLoad) { chosen = wave; chosenLoad = load; }
    }
    if (chosen < 0) {
      chosen = waves.length;
      waves.push([]);
      exposures.push({});
      waveAccounts.push(new Set());
      waveDates.push(new Map());
    }
    waves[chosen].push(candidate.intent);
    waveAccounts[chosen].add(candidate.intent.account);
    waveDates[chosen].set(candidate.intent.valueDate, (waveDates[chosen].get(candidate.intent.valueDate) ?? 0) + 1);
    exposures[chosen][candidate.intent.currency] = (exposures[chosen][candidate.intent.currency] ?? 0) + candidate.intent.amount;
  }

  for (let wave = 0; wave < waves.length; wave += 1) {
    const ordered = waves[wave];
    ordered.sort((left, right) => {
      const leftDate = left.valueDate.localeCompare(right.valueDate);
      if (leftDate !== 0) return leftDate;
      if (left.priority !== right.priority) return right.priority - left.priority;
      return left.identity.localeCompare(right.identity);
    });
    const byCurrency = new Map<string, SettlementIntent[]>();
    for (const intent of ordered) {
      const group = byCurrency.get(intent.currency) ?? [];
      group.push(intent);
      byCurrency.set(intent.currency, group);
    }
    for (const group of byCurrency.values()) {
      const mean = group.reduce((sum, intent) => sum + intent.amount, 0) / group.length;
      const large = group.filter((intent) => intent.amount > mean * 4);
      if (large.length <= 1) continue;
      large.sort((left, right) => right.amount - left.amount);
      for (let index = 1; index < large.length; index += 1) {
        const sourceIndex = ordered.indexOf(large[index]);
        if (sourceIndex < 0) continue;
        const targetWave = wave + index;
        while (waves.length <= targetWave) { waves.push([]); exposures.push({}); waveAccounts.push(new Set()); waveDates.push(new Map()); }
        ordered.splice(sourceIndex, 1);
        waves[targetWave].push(large[index]);
        exposures[wave][large[index].currency] -= large[index].amount;
        exposures[targetWave][large[index].currency] = (exposures[targetWave][large[index].currency] ?? 0) + large[index].amount;
      }
    }
  }
  const criticalAccounts = [...accountTotals]
    .filter(([account, amount]) => amount >= (accountCaps[account] ?? Number.POSITIVE_INFINITY) * 0.8)
    .sort((left, right) => right[1] - left[1])
    .map(([account]) => account);
  const conflictGraph = new Map<string, Set<string>>();
  for (const candidate of accepted) conflictGraph.set(candidate.intent.identity, new Set());
  for (let left = 0; left < accepted.length; left += 1) {
    for (let right = left + 1; right < accepted.length; right += 1) {
      const first = accepted[left].intent;
      const second = accepted[right].intent;
      const sameAccount = first.account === second.account;
      const sameCurrencyDate = first.currency === second.currency && first.valueDate === second.valueDate;
      const combinedLimit = currencyCaps[first.currency] ?? Number.POSITIVE_INFINITY;
      const overCombinedLimit = first.currency === second.currency && first.amount + second.amount > combinedLimit;
      if (!sameAccount && !sameCurrencyDate && !overCombinedLimit) continue;
      conflictGraph.get(first.identity)!.add(second.identity);
      conflictGraph.get(second.identity)!.add(first.identity);
    }
  }
  const degreeOrder = [...accepted]
    .sort((left, right) => (conflictGraph.get(right.intent.identity)?.size ?? 0) - (conflictGraph.get(left.intent.identity)?.size ?? 0));
  const color = new Map<string, number>();
  for (const candidate of degreeOrder) {
    const unavailable = new Set<number>();
    for (const neighbor of conflictGraph.get(candidate.intent.identity) ?? []) {
      const neighborColor = color.get(neighbor);
      if (neighborColor !== undefined) unavailable.add(neighborColor);
    }
    let selectedColor = 0;
    while (unavailable.has(selectedColor)) selectedColor += 1;
    color.set(candidate.intent.identity, selectedColor);
  }
  const coloredWaves: SettlementIntent[][] = [];
  for (const candidate of accepted) {
    const wave = color.get(candidate.intent.identity) ?? 0;
    while (coloredWaves.length <= wave) coloredWaves.push([]);
    coloredWaves[wave].push(candidate.intent);
  }
  if (coloredWaves.length < waves.length) {
    waves.splice(0, waves.length, ...coloredWaves);
    exposures.splice(0, exposures.length);
    for (const wave of waves) {
      const amounts: Record<string, number> = {};
      for (const intent of wave) amounts[intent.currency] = (amounts[intent.currency] ?? 0) + intent.amount;
      exposures.push(amounts);
    }
  }

  const currencyQueues = new Map<string, SettlementIntent[]>();
  for (const candidate of accepted) {
    const queue = currencyQueues.get(candidate.intent.currency) ?? [];
    queue.push(candidate.intent);
    currencyQueues.set(candidate.intent.currency, queue);
  }
  for (const [currencyCode, queue] of currencyQueues) {
    queue.sort((left, right) => left.valueDate.localeCompare(right.valueDate) || right.priority - left.priority);
    const cap = currencyCaps[currencyCode] ?? Number.POSITIVE_INFINITY;
    let running = 0;
    let peak = 0;
    for (const intent of queue) {
      running += intent.amount;
      peak = Math.max(peak, running);
      if (running > cap) rejected.set(intent.identity, `rolling ${currencyCode} cap exceeded`);
      if (intent.priority < 0) running = Math.max(0, running - intent.amount);
    }
    if (peak > cap * 0.9) {
      for (const intent of queue.filter((entry) => entry.priority < 50)) {
        const currentWave = waves.findIndex((wave) => wave.includes(intent));
        if (currentWave < 0) continue;
        waves[currentWave].splice(waves[currentWave].indexOf(intent), 1);
        while (waves.length <= currentWave + 1) waves.push([]);
        waves[currentWave + 1].push(intent);
      }
    }
  }
  return { waves, rejected, exposureByWave: exposures, criticalAccounts };
};
