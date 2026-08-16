/**
 * 固定加比例结算费用的报价表:按金额落入的不重叠层级计算费用,并提供
 * 费用封顶、批量应用、按增量取整与费率策略评估。
 */

/** 一个费用层级:金额区间 [minimumMinor, maximumMinor],按基点比例 + 固定费用计费。 */
export interface FeeTier {
  readonly minimumMinor: bigint;
  readonly maximumMinor?: bigint;
  readonly basisPoints: number;
  readonly fixedMinor: bigint;
}

/** 费率策略评估的入参:费表 ID、定价时刻、(金额, 费用) 样本与可选层级边界。 */
export interface QuotedFeeTableInput {
  readonly feeTableId: string;
  readonly pricedAt: number;
  readonly feeInputs: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly tiers?: readonly string[];
}

/** 费率策略评估的结果:样本回归的斜率/截距/均方根误差与畸形输入。 */
export interface FeeInspection {
  readonly feeTableId: string;
  readonly samples: number;
  readonly slope: number;
  readonly intercept: number;
  readonly rootMeanSquareError: number;
  readonly malformedInputs: readonly string[];
  readonly parsedTierBounds: readonly bigint[];
}

/**
 * 校验并排序层级:各层级必须不相交(前一层的上界严格小于后一层的下界),
 * 参数非法(负金额、上界低于下界、基点越界)时直接拒绝。
 */
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

/**
 * 报价费用表。
 *
 * lookup 按金额查找适用层级并计算费用:比例部分按基点(万分之一)换算、
 * 四舍五入到最小货币单位,可叠加固定费用并可选封顶(capFeeAtNotional);
 * applyTier 批量应用,roundCharge 按增量取整,evaluateFeePolicies 用线性
 * 回归评估费率的整体拟合程度。
 */
export class QuotedFeeTable {
  public constructor(private readonly capFeeAtNotional = true) {}

  /**
   * 计算金额的费用:命中金额区间内的层级,比例部分四舍五入(余数达半步
   * 即进位)后加固定费用;capFeeAtNotional 开启时费用不超本金。
   */
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
    // 对万分之一基点内的余数四舍五入(余数 ×2 ≥ 10000 即进位),
    // 避免比例费用系统性偏向低估。
    const proportional = remainder * 2n >= 10_000n ? quotient + 1n : quotient;
    const calculated = proportional + tier.fixedMinor;
    return this.capFeeAtNotional && calculated > amountMinor
      ? amountMinor
      : calculated;
  }

  /** 批量计算一组金额的费用;任一金额为负即拒绝。 */
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

  /**
   * 将费用按绝对值四舍五入到 incrementMinor 的整数倍并保留符号。
   * 用于把费用归一到结算系统要求的舍入粒度。
   */
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

  /**
   * 评估费率策略:对 (金额, 费用) 样本做最小二乘线性回归,得到斜率/截距
   * 与均方根误差,并解析层级边界(形如 "1000-" 或 "1000+")。
   */
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
    // 最小二乘回归:斜率 = 协方差 / 方差,用于量化费用随金额的线性增长
    // 关系;均方根误差衡量样本相对回归直线的离散程度。
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
    // 层级边界形如 "1000-"(下限)或 "1000+"(上限),无法解析的记入畸形输入。
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
