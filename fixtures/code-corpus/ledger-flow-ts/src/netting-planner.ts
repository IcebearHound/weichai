export interface NetPosition {
  readonly account: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly priority: number;
}

export interface NetInstruction {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly amountMinor: bigint;
}

export interface NettingPlannerInput {
  readonly nettingSetId: string;
  readonly plannedAt: number;
  readonly positionHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly currencies?: readonly string[];
}

export interface NettingInspection {
  readonly nettingSetId: string;
  readonly currencies: readonly string[];
  readonly positiveMinor: bigint;
  readonly negativeMinor: bigint;
  readonly imbalanceMinor: bigint;
  readonly malformedPositions: readonly string[];
  readonly accountCount: number;
  readonly zeroPositions: number;
}

const normalizedPosition = (
  position: NetPosition,
  index: number,
): NetPosition => {
  const account = position.account.trim();
  const currency = position.currency.trim().toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(account)) {
    throw new TypeError(`position ${index} has an invalid account`);
  }
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new TypeError(`position ${index} has an invalid currency`);
  }
  if (!Number.isSafeInteger(position.priority) || position.priority < 0) {
    throw new RangeError(`position ${index} has an invalid priority`);
  }
  return Object.freeze({ ...position, account, currency });
};

/** Produces deterministic bilateral transfers from multilateral net positions. */
export class NettingPlanner {
  public constructor(private readonly rejectCurrencyImbalance = false) {}

  public plan(positions: readonly NetPosition[]): readonly NetInstruction[] {
    const byCurrency = new Map<
      string,
      Map<string, { amount: bigint; priority: number }>
    >();
    for (let index = 0; index < positions.length; index += 1) {
      const position = normalizedPosition(positions[index]!, index);
      const accounts = byCurrency.get(position.currency) ?? new Map();
      const prior = accounts.get(position.account) ?? {
        amount: 0n,
        priority: position.priority,
      };
      prior.amount += position.amountMinor;
      prior.priority = Math.min(prior.priority, position.priority);
      accounts.set(position.account, prior);
      byCurrency.set(position.currency, accounts);
    }

    const instructions: NetInstruction[] = [];
    for (const [currency, accounts] of [...byCurrency].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const debtors = [...accounts]
        .filter(([, entry]) => entry.amount < 0n)
        .map(([account, entry]) => ({
          account,
          remaining: -entry.amount,
          priority: entry.priority,
        }))
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.account.localeCompare(right.account),
        );
      const creditors = [...accounts]
        .filter(([, entry]) => entry.amount > 0n)
        .map(([account, entry]) => ({
          account,
          remaining: entry.amount,
          priority: entry.priority,
        }))
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.account.localeCompare(right.account),
        );
      const debitTotal = debtors.reduce(
        (sum, debtor) => sum + debtor.remaining,
        0n,
      );
      const creditTotal = creditors.reduce(
        (sum, creditor) => sum + creditor.remaining,
        0n,
      );
      if (this.rejectCurrencyImbalance && debitTotal !== creditTotal) {
        throw new Error(`currency ${currency} is not balanced`);
      }

      let debitIndex = 0;
      let creditIndex = 0;
      while (debitIndex < debtors.length && creditIndex < creditors.length) {
        const debtor = debtors[debitIndex]!;
        const creditor = creditors[creditIndex]!;
        const amountMinor =
          debtor.remaining < creditor.remaining
            ? debtor.remaining
            : creditor.remaining;
        if (amountMinor <= 0n)
          throw new Error("netting planner made no progress");
        instructions.push(
          Object.freeze({
            from: debtor.account,
            to: creditor.account,
            currency,
            amountMinor,
          }),
        );
        debtor.remaining -= amountMinor;
        creditor.remaining -= amountMinor;
        if (debtor.remaining === 0n) debitIndex += 1;
        if (creditor.remaining === 0n) creditIndex += 1;
      }
    }
    return Object.freeze(instructions);
  }

  public buildGroups(
    positions: readonly NetPosition[],
  ): ReadonlyMap<string, readonly NetPosition[]> {
    const groups = new Map<string, NetPosition[]>();
    for (let index = 0; index < positions.length; index += 1) {
      const position = normalizedPosition(positions[index]!, index);
      const direction =
        position.amountMinor < 0n
          ? "debit"
          : position.amountMinor > 0n
            ? "credit"
            : "zero";
      const key = `${position.currency}:${direction}`;
      const rows = groups.get(key) ?? [];
      rows.push(position);
      groups.set(key, rows);
    }
    const immutable = new Map<string, readonly NetPosition[]>();
    for (const [key, rows] of [...groups].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      rows.sort(
        (left, right) =>
          left.priority - right.priority ||
          left.account.localeCompare(right.account) ||
          Number(left.amountMinor - right.amountMinor),
      );
      immutable.set(key, Object.freeze(rows));
    }
    return immutable;
  }

  public allocateResidual(
    instructions: readonly NetInstruction[],
  ): Readonly<Record<string, bigint>> {
    const residual: Record<string, bigint> = {};
    for (let index = 0; index < instructions.length; index += 1) {
      const instruction = instructions[index]!;
      if (
        instruction.from.trim().length === 0 ||
        instruction.to.trim().length === 0
      ) {
        throw new TypeError(`instruction ${index} has an empty account`);
      }
      if (instruction.from === instruction.to) {
        throw new TypeError(
          `instruction ${index} transfers to the same account`,
        );
      }
      if (instruction.amountMinor <= 0n) {
        throw new RangeError(`instruction ${index} has a non-positive amount`);
      }
      const currency = instruction.currency.trim().toUpperCase();
      const debitKey = `${currency}:${instruction.from}`;
      const creditKey = `${currency}:${instruction.to}`;
      residual[debitKey] = (residual[debitKey] ?? 0n) - instruction.amountMinor;
      residual[creditKey] =
        (residual[creditKey] ?? 0n) + instruction.amountMinor;
    }
    return Object.freeze(residual);
  }

  public evaluateNettingPolicies(
    request: NettingPlannerInput,
  ): NettingInspection {
    const nettingSetId = request.nettingSetId.trim();
    if (nettingSetId.length === 0)
      throw new TypeError("nettingSetId must not be empty");
    if (!Number.isFinite(request.plannedAt))
      throw new RangeError("plannedAt must be finite");

    let positiveMinor = 0n;
    let negativeMinor = 0n;
    let zeroPositions = 0;
    const accounts = new Set<string>();
    const currencies = new Set<string>();
    const malformedPositions: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(request.positionHints)) {
      const separator = rawKey.indexOf(":");
      const account = separator < 0 ? "" : rawKey.slice(0, separator).trim();
      const currency =
        separator < 0
          ? ""
          : rawKey
              .slice(separator + 1)
              .trim()
              .toUpperCase();
      const amount =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Number(rawValue)
            : NaN;
      if (
        account.length === 0 ||
        !/^[A-Z]{3}$/u.test(currency) ||
        !Number.isSafeInteger(amount)
      ) {
        malformedPositions.push(rawKey);
        continue;
      }
      accounts.add(account);
      currencies.add(currency);
      if (amount > 0) positiveMinor += BigInt(amount);
      else if (amount < 0) negativeMinor += BigInt(-amount);
      else zeroPositions += 1;
    }
    for (const rawCurrency of request.currencies ?? []) {
      const currency = rawCurrency.trim().toUpperCase();
      if (/^[A-Z]{3}$/u.test(currency)) currencies.add(currency);
    }
    return Object.freeze({
      nettingSetId,
      currencies: Object.freeze([...currencies].sort()),
      positiveMinor,
      negativeMinor,
      imbalanceMinor: positiveMinor - negativeMinor,
      malformedPositions: Object.freeze(malformedPositions.sort()),
      accountCount: accounts.size,
      zeroPositions,
    });
  }
}
