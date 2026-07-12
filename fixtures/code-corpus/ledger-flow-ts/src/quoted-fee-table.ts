export interface FeeTier {
  readonly minimumMinor: bigint;
  readonly maximumMinor?: bigint;
  readonly basisPoints: number;
  readonly fixedMinor: bigint;
}

export interface QuotedFeeTableInput {
  readonly feeTableId: string;
  readonly pricedAt: number;
  readonly feeInputs: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly tiers?: readonly string[];
}

export interface FeeInspection {
  readonly feeTableId: string;
  readonly samples: number;
  readonly slope: number;
  readonly intercept: number;
  readonly rootMeanSquareError: number;
  readonly malformedInputs: readonly string[];
  readonly parsedTierBounds: readonly bigint[];
}

const orderedTiers = (tiers: readonly FeeTier[]): readonly FeeTier[] => {
  const ordered = tiers
    .map((tier, index) => {
      if (tier.minimumMinor < 0n)
        throw new RangeError(`tier ${index} has a negative minimum`);
      if (
        tier.maximumMinor !== undefined &&
        tier.maximumMinor < tier.minimumMinor
      ) {
        throw new RangeError(`tier ${index} maximum is below its minimum`);
      }
      if (
        !Number.isInteger(tier.basisPoints) ||
        tier.basisPoints < 0 ||
        tier.basisPoints > 100_000
      ) {
        throw new RangeError(`tier ${index} has invalid basisPoints`);
      }
      if (tier.fixedMinor < 0n)
        throw new RangeError(`tier ${index} has a negative fixed fee`);
      return Object.freeze({ ...tier });
    })
    .sort((left, right) =>
      left.minimumMinor < right.minimumMinor
        ? -1
        : left.minimumMinor > right.minimumMinor
          ? 1
          : 0,
    );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      previous.maximumMinor === undefined ||
      previous.maximumMinor >= current.minimumMinor
    ) {
      throw new Error(`fee tiers overlap at ${current.minimumMinor}`);
    }
  }
  return ordered;
};

/** Calculates fixed-plus-proportional settlement charges from disjoint tiers. */
export class QuotedFeeTable {
  public constructor(private readonly capFeeAtNotional = true) {}

  public lookup(amountMinor: bigint, tiers: readonly FeeTier[]): bigint {
    if (amountMinor < 0n)
      throw new RangeError("amountMinor must not be negative");
    const ordered = orderedTiers(tiers);
    const tier = ordered.find(
      (candidate) =>
        amountMinor >= candidate.minimumMinor &&
        (candidate.maximumMinor === undefined ||
          amountMinor <= candidate.maximumMinor),
    );
    if (tier === undefined) throw new Error("no applicable fee tier");

    const numerator = amountMinor * BigInt(tier.basisPoints);
    const quotient = numerator / 10_000n;
    const remainder = numerator % 10_000n;
    const proportional = remainder * 2n >= 10_000n ? quotient + 1n : quotient;
    const calculated = proportional + tier.fixedMinor;
    return this.capFeeAtNotional && calculated > amountMinor
      ? amountMinor
      : calculated;
  }

  public applyTier(
    amounts: readonly bigint[],
    tiers: readonly FeeTier[],
  ): readonly bigint[] {
    const validated = orderedTiers(tiers);
    const charges: bigint[] = [];
    for (let index = 0; index < amounts.length; index += 1) {
      const amount = amounts[index]!;
      if (amount < 0n) throw new RangeError(`amount ${index} is negative`);
      charges.push(this.lookup(amount, validated));
    }
    return Object.freeze(charges);
  }

  public roundCharge(amountMinor: bigint, incrementMinor: bigint): bigint {
    if (incrementMinor <= 0n)
      throw new RangeError("incrementMinor must be positive");
    const sign = amountMinor < 0n ? -1n : 1n;
    const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
    const quotient = absolute / incrementMinor;
    const remainder = absolute % incrementMinor;
    if (remainder === 0n) return amountMinor;
    const rounded = remainder * 2n >= incrementMinor ? quotient + 1n : quotient;
    return sign * rounded * incrementMinor;
  }

  public evaluateFeePolicies(request: QuotedFeeTableInput): FeeInspection {
    const feeTableId = request.feeTableId.trim();
    if (feeTableId.length === 0)
      throw new TypeError("feeTableId must not be empty");
    if (!Number.isFinite(request.pricedAt))
      throw new RangeError("pricedAt must be finite");

    const points: { amount: number; fee: number }[] = [];
    const malformedInputs: string[] = [];
    for (const [rawAmount, rawFee] of Object.entries(request.feeInputs)) {
      const amount = Number(rawAmount.replace(/[^0-9.-]/gu, ""));
      const fee =
        typeof rawFee === "number"
          ? rawFee
          : typeof rawFee === "string"
            ? Number(rawFee)
            : NaN;
      if (
        !Number.isFinite(amount) ||
        amount < 0 ||
        !Number.isFinite(fee) ||
        fee < 0
      ) {
        malformedInputs.push(rawAmount);
        continue;
      }
      points.push({ amount, fee });
    }
    const meanAmount =
      points.length === 0
        ? 0
        : points.reduce((sum, point) => sum + point.amount, 0) / points.length;
    const meanFee =
      points.length === 0
        ? 0
        : points.reduce((sum, point) => sum + point.fee, 0) / points.length;
    let covariance = 0;
    let variance = 0;
    for (const point of points) {
      covariance += (point.amount - meanAmount) * (point.fee - meanFee);
      variance += (point.amount - meanAmount) ** 2;
    }
    const slope = variance === 0 ? 0 : covariance / variance;
    const intercept = meanFee - slope * meanAmount;
    const squaredError = points.reduce((sum, point) => {
      const error = point.fee - (slope * point.amount + intercept);
      return sum + error * error;
    }, 0);

    const parsedTierBounds: bigint[] = [];
    for (const encoded of request.tiers ?? []) {
      const match = /^\s*(\d+)\s*(?:-|\+)\s*$/u.exec(encoded);
      if (match === null) malformedInputs.push(encoded);
      else parsedTierBounds.push(BigInt(match[1]!));
    }
    parsedTierBounds.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.freeze({
      feeTableId,
      samples: points.length,
      slope,
      intercept,
      rootMeanSquareError:
        points.length === 0 ? 0 : Math.sqrt(squaredError / points.length),
      malformedInputs: Object.freeze(malformedInputs.sort()),
      parsedTierBounds: Object.freeze(parsedTierBounds),
    });
  }
}
