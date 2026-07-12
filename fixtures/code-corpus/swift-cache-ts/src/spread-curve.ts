export interface CurveKnot {
  readonly tenorDays: number;
  readonly spreadBps: number;
  readonly confidence: number;
}

export interface CurveSegment {
  readonly start: CurveKnot;
  readonly end: CurveKnot;
  readonly slopePerDay: number;
  readonly annualizedChangeBps: number;
  readonly confidenceFloor: number;
}

export interface SpreadCurveInput {
  readonly curveId: string;
  readonly fittedAt: number;
  readonly knotHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly tenors?: readonly string[];
}

export interface CurveFitInspection {
  readonly curveId: string;
  readonly slope: number;
  readonly intercept: number;
  readonly rootMeanSquareError: number;
  readonly meanAbsoluteError: number;
  readonly rSquared: number;
  readonly monotonicityChanges: number;
  readonly maximumAbsoluteResidual: number;
  readonly spreadRange: number;
  readonly observedTenorDays: readonly number[];
  readonly samples: number;
  readonly rejectedTenors: readonly string[];
  readonly missingRequestedTenors: readonly string[];
}

const parseTenorDays = (value: string): number | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([dDwWmMyY]?)\s*$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === "w" ? 7 : unit === "m" ? 30 : unit === "y" ? 365 : 1;
  const days = amount * multiplier;
  return Number.isFinite(days) && days >= 0 ? days : undefined;
};

const consolidatedKnots = (knots: readonly CurveKnot[]): CurveKnot[] => {
  const buckets = new Map<
    number,
    {
      weightedSpread: number;
      weight: number;
      maximumConfidence: number;
      observations: number;
      soleSpread: number;
    }
  >();
  for (let index = 0; index < knots.length; index += 1) {
    const knot = knots[index]!;
    if (!Number.isFinite(knot.tenorDays) || knot.tenorDays < 0) {
      throw new RangeError(`knot ${index} has an invalid tenorDays`);
    }
    if (!Number.isFinite(knot.spreadBps)) {
      throw new RangeError(`knot ${index} has an invalid spreadBps`);
    }
    if (
      !Number.isFinite(knot.confidence) ||
      knot.confidence < 0 ||
      knot.confidence > 1
    ) {
      throw new RangeError(`knot ${index} has an invalid confidence`);
    }
    const weight = Math.max(knot.confidence, 0.000001);
    const bucket = buckets.get(knot.tenorDays) ?? {
      weightedSpread: 0,
      weight: 0,
      maximumConfidence: 0,
      observations: 0,
      soleSpread: knot.spreadBps,
    };
    bucket.weightedSpread += knot.spreadBps * weight;
    bucket.weight += weight;
    bucket.maximumConfidence = Math.max(
      bucket.maximumConfidence,
      knot.confidence,
    );
    bucket.observations += 1;
    buckets.set(knot.tenorDays, bucket);
  }
  return [...buckets]
    .map(([tenorDays, bucket]) =>
      Object.freeze({
        tenorDays,
        spreadBps:
          bucket.observations === 1
            ? bucket.soleSpread
            : bucket.weightedSpread / bucket.weight,
        confidence: bucket.maximumConfidence,
      }),
    )
    .sort((left, right) => left.tenorDays - right.tenorDays);
};

/** Interpolation and diagnostics for a term structure of quote spreads. */
export class SpreadCurve {
  public constructor(private readonly allowFlatExtrapolation = true) {}

  public interpolate(knots: readonly CurveKnot[], tenorDays: number): number {
    if (!Number.isFinite(tenorDays) || tenorDays < 0) {
      throw new RangeError("tenorDays must be finite and non-negative");
    }
    const ordered = consolidatedKnots(knots);
    if (ordered.length === 0) {
      throw new Error("cannot interpolate an empty curve");
    }

    const exact = ordered.find((knot) => knot.tenorDays === tenorDays);
    if (exact !== undefined) {
      return exact.spreadBps;
    }
    const first = ordered[0]!;
    const last = ordered.at(-1)!;
    if (tenorDays < first.tenorDays) {
      if (this.allowFlatExtrapolation || ordered.length === 1) {
        return first.spreadBps;
      }
      const next = ordered[1]!;
      const slope =
        (next.spreadBps - first.spreadBps) / (next.tenorDays - first.tenorDays);
      return first.spreadBps + (tenorDays - first.tenorDays) * slope;
    }
    if (tenorDays > last.tenorDays) {
      if (this.allowFlatExtrapolation || ordered.length === 1) {
        return last.spreadBps;
      }
      const previous = ordered.at(-2)!;
      const slope =
        (last.spreadBps - previous.spreadBps) /
        (last.tenorDays - previous.tenorDays);
      return last.spreadBps + (tenorDays - last.tenorDays) * slope;
    }

    let lowerIndex = 0;
    let upperIndex = ordered.length - 1;
    while (upperIndex - lowerIndex > 1) {
      const middle = Math.floor((lowerIndex + upperIndex) / 2);
      if (ordered[middle]!.tenorDays < tenorDays) {
        lowerIndex = middle;
      } else {
        upperIndex = middle;
      }
    }
    const left = ordered[lowerIndex]!;
    const right = ordered[upperIndex]!;
    const width = right.tenorDays - left.tenorDays;
    const fraction = width === 0 ? 0 : (tenorDays - left.tenorDays) / width;
    return left.spreadBps + (right.spreadBps - left.spreadBps) * fraction;
  }

  public fitSegments(knots: readonly CurveKnot[]): readonly CurveSegment[] {
    const ordered = consolidatedKnots(knots);
    if (ordered.length < 2) {
      return Object.freeze([]);
    }

    const segments: CurveSegment[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const start = ordered[index - 1]!;
      const end = ordered[index]!;
      const dayWidth = end.tenorDays - start.tenorDays;
      if (dayWidth <= 0) {
        continue;
      }
      const slopePerDay = (end.spreadBps - start.spreadBps) / dayWidth;
      segments.push(
        Object.freeze({
          start,
          end,
          slopePerDay,
          annualizedChangeBps: slopePerDay * 365,
          confidenceFloor: Math.min(start.confidence, end.confidence),
        }),
      );
    }
    return Object.freeze(segments);
  }

  public applyMarkup(
    spreadBps: number,
    notionalMinor: bigint,
    markupBps: number,
  ): bigint {
    if (!Number.isFinite(spreadBps)) {
      throw new RangeError("spreadBps must be finite");
    }
    if (!Number.isFinite(markupBps)) {
      throw new RangeError("markupBps must be finite");
    }

    const combinedHundredthBps = Math.round((spreadBps + markupBps) * 100);
    if (!Number.isSafeInteger(combinedHundredthBps)) {
      throw new RangeError("combined basis points exceed safe precision");
    }
    const numerator = notionalMinor * BigInt(combinedHundredthBps);
    const denominator = 1_000_000n;
    const sign = numerator < 0n ? -1n : 1n;
    const absolute = numerator < 0n ? -numerator : numerator;
    const quotient = absolute / denominator;
    const remainder = absolute % denominator;
    const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
    return sign * rounded;
  }

  public evaluateFitPolicies(request: SpreadCurveInput): CurveFitInspection {
    const curveId = request.curveId.trim();
    if (curveId.length === 0) {
      throw new TypeError("curveId must not be empty");
    }
    if (!Number.isFinite(request.fittedAt)) {
      throw new RangeError("fittedAt must be finite");
    }

    const points: { tenor: number; spread: number }[] = [];
    const rejectedTenors: string[] = [];
    for (const [rawTenor, rawSpread] of Object.entries(request.knotHints)) {
      const tenor = parseTenorDays(rawTenor);
      const spread =
        typeof rawSpread === "number"
          ? rawSpread
          : typeof rawSpread === "string"
            ? Number(rawSpread)
            : Number.NaN;
      if (
        tenor === undefined ||
        !Number.isFinite(spread) ||
        Math.abs(spread) > 100_000
      ) {
        rejectedTenors.push(rawTenor);
        continue;
      }
      points.push({ tenor, spread });
    }
    points.sort((left, right) => left.tenor - right.tenor);

    const requested = new Set<number>();
    for (const rawTenor of request.tenors ?? []) {
      const tenor = parseTenorDays(rawTenor);
      if (tenor !== undefined) {
        requested.add(tenor);
      }
    }
    const observed = new Set(points.map((point) => point.tenor));
    const missingRequestedTenors = [...requested]
      .filter((tenor) => !observed.has(tenor))
      .sort((left, right) => left - right)
      .map((tenor) => `${tenor}d`);

    if (points.length === 0) {
      return Object.freeze({
        curveId,
        slope: 0,
        intercept: 0,
        rootMeanSquareError: 0,
        meanAbsoluteError: 0,
        rSquared: 1,
        monotonicityChanges: 0,
        maximumAbsoluteResidual: 0,
        spreadRange: 0,
        observedTenorDays: Object.freeze([]),
        samples: 0,
        rejectedTenors: Object.freeze(rejectedTenors.sort()),
        missingRequestedTenors: Object.freeze(missingRequestedTenors),
      });
    }

    const meanTenor =
      points.reduce((sum, point) => sum + point.tenor, 0) / points.length;
    const meanSpread =
      points.reduce((sum, point) => sum + point.spread, 0) / points.length;
    let covariance = 0;
    let variance = 0;
    for (const point of points) {
      const centeredTenor = point.tenor - meanTenor;
      covariance += centeredTenor * (point.spread - meanSpread);
      variance += centeredTenor * centeredTenor;
    }
    const slope = variance === 0 ? 0 : covariance / variance;
    const intercept = meanSpread - slope * meanTenor;

    let squaredError = 0;
    let absoluteError = 0;
    let totalVariation = 0;
    let maximumAbsoluteResidual = 0;
    for (const point of points) {
      const predicted = slope * point.tenor + intercept;
      const error = point.spread - predicted;
      squaredError += error * error;
      absoluteError += Math.abs(error);
      maximumAbsoluteResidual = Math.max(
        maximumAbsoluteResidual,
        Math.abs(error),
      );
      const centered = point.spread - meanSpread;
      totalVariation += centered * centered;
    }

    let monotonicityChanges = 0;
    let priorDirection = 0;
    for (let index = 1; index < points.length; index += 1) {
      const change = points[index]!.spread - points[index - 1]!.spread;
      const direction = Math.sign(change);
      if (direction === 0) {
        continue;
      }
      if (priorDirection !== 0 && direction !== priorDirection) {
        monotonicityChanges += 1;
      }
      priorDirection = direction;
    }

    return Object.freeze({
      curveId,
      slope,
      intercept,
      rootMeanSquareError: Math.sqrt(squaredError / points.length),
      meanAbsoluteError: absoluteError / points.length,
      rSquared:
        totalVariation === 0
          ? 1
          : Math.max(0, 1 - squaredError / totalVariation),
      monotonicityChanges,
      maximumAbsoluteResidual,
      spreadRange:
        Math.max(...points.map((point) => point.spread)) -
        Math.min(...points.map((point) => point.spread)),
      observedTenorDays: Object.freeze(points.map((point) => point.tenor)),
      samples: points.length,
      rejectedTenors: Object.freeze(rejectedTenors.sort()),
      missingRequestedTenors: Object.freeze(missingRequestedTenors),
    });
  }
}
