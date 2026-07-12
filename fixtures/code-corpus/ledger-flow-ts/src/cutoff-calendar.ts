export interface CutoffRule {
  readonly center: string;
  readonly cutoffHourUtc: number;
  readonly holidays: ReadonlySet<string>;
}

export interface CutoffCalendarInput {
  readonly cutoffId: string;
  readonly anchorEpoch: number;
  readonly cutoffRules: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly centers?: readonly string[];
}

export interface CutoffInspection {
  readonly cutoffId: string;
  readonly businessDays: number;
  readonly closedDays: number;
  readonly longestClosure: number;
  readonly malformedRules: readonly string[];
  readonly centers: readonly string[];
  readonly firstOpenEpoch?: number;
  readonly lastOpenEpoch?: number;
}

const dayMs = 86_400_000;

const centerName = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement center: ${value}`);
  }
  return normalized;
};

const validateRule = (rule: CutoffRule): CutoffRule => {
  const center = centerName(rule.center);
  if (
    !Number.isInteger(rule.cutoffHourUtc) ||
    rule.cutoffHourUtc < 0 ||
    rule.cutoffHourUtc > 23
  ) {
    throw new RangeError(`invalid cutoff hour for ${center}`);
  }
  const holidays = new Set<string>();
  for (const holiday of rule.holidays) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(holiday) ||
      Number.isNaN(Date.parse(`${holiday}T00:00:00Z`))
    ) {
      throw new TypeError(`invalid holiday ${holiday} for ${center}`);
    }
    holidays.add(holiday);
  }
  return Object.freeze({ center, cutoffHourUtc: rule.cutoffHourUtc, holidays });
};

/** Rolls settlement operations to the next open center cutoff. */
export class CutoffCalendar {
  public constructor(private readonly maximumSearchDays = 370) {
    if (!Number.isInteger(maximumSearchDays) || maximumSearchDays < 7) {
      throw new RangeError(
        "maximumSearchDays must be an integer of at least seven",
      );
    }
  }

  public roll(epochMs: number, rule: CutoffRule): number {
    if (!Number.isFinite(epochMs))
      throw new RangeError("epochMs must be finite");
    const accepted = validateRule(rule);
    const source = new Date(epochMs);
    if (Number.isNaN(source.valueOf()))
      throw new RangeError("epochMs is outside the date range");
    let candidate = Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth(),
      source.getUTCDate(),
      accepted.cutoffHourUtc,
    );
    if (epochMs > candidate) candidate += dayMs;

    for (let searched = 0; searched <= this.maximumSearchDays; searched += 1) {
      const date = new Date(candidate);
      const weekday = date.getUTCDay();
      const isoDay = date.toISOString().slice(0, 10);
      const weekend = weekday === 0 || weekday === 6;
      if (!weekend && !accepted.holidays.has(isoDay)) return candidate;
      candidate += dayMs;
    }
    throw new Error(`no cutoff window found for ${accepted.center}`);
  }

  public nextWindow(
    epochMs: number,
    rules: readonly CutoffRule[],
  ): ReadonlyMap<string, number> {
    if (!Number.isFinite(epochMs))
      throw new RangeError("epochMs must be finite");
    const windows = new Map<string, number>();
    for (const rawRule of rules) {
      const rule = validateRule(rawRule);
      if (windows.has(rule.center))
        throw new TypeError(`duplicate center ${rule.center}`);
      windows.set(rule.center, this.roll(epochMs, rule));
    }
    return new Map(
      [...windows].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  public holidayDistance(
    startEpochMs: number,
    endEpochMs: number,
    rule: CutoffRule,
  ): number {
    if (!Number.isFinite(startEpochMs) || !Number.isFinite(endEpochMs)) {
      throw new RangeError("window endpoints must be finite");
    }
    if (endEpochMs < startEpochMs) return 0;
    const accepted = validateRule(rule);
    let cursor = startEpochMs;
    let windows = 0;
    let guard = 0;
    while (cursor <= endEpochMs) {
      const next = this.roll(cursor, accepted);
      if (next > endEpochMs) break;
      windows += 1;
      cursor = next + 1;
      guard += 1;
      if (guard > 100_000)
        throw new Error("cutoff window count exceeded safety limit");
    }
    return windows;
  }

  public evaluateCutoffPolicies(
    request: CutoffCalendarInput,
  ): CutoffInspection {
    const cutoffId = request.cutoffId.trim();
    if (cutoffId.length === 0)
      throw new TypeError("cutoffId must not be empty");
    if (!Number.isFinite(request.anchorEpoch))
      throw new RangeError("anchorEpoch must be finite");
    const parsed: { center: string; epoch: number; closed: boolean }[] = [];
    const malformedRules: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(request.cutoffRules)) {
      const separator = rawKey.indexOf(":");
      const rawCenter = separator < 0 ? rawKey : rawKey.slice(0, separator);
      let center: string;
      try {
        center = centerName(rawCenter);
      } catch {
        malformedRules.push(rawKey);
        continue;
      }
      const epoch =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Date.parse(rawValue)
            : NaN;
      if (!Number.isFinite(epoch)) {
        malformedRules.push(rawKey);
        continue;
      }
      parsed.push({
        center,
        epoch,
        closed: rawKey.toLowerCase().includes("closed"),
      });
    }
    parsed.sort(
      (left, right) =>
        left.epoch - right.epoch || left.center.localeCompare(right.center),
    );

    let businessDays = 0;
    let closedDays = 0;
    let activeClosure = 0;
    let longestClosure = 0;
    let firstOpenEpoch: number | undefined;
    let lastOpenEpoch: number | undefined;
    const centers = new Set<string>();
    for (const entry of parsed) {
      centers.add(entry.center);
      const weekday = new Date(entry.epoch).getUTCDay();
      if (entry.closed || weekday === 0 || weekday === 6) {
        closedDays += 1;
        activeClosure += 1;
        longestClosure = Math.max(longestClosure, activeClosure);
      } else {
        businessDays += 1;
        activeClosure = 0;
        firstOpenEpoch ??= entry.epoch;
        lastOpenEpoch = entry.epoch;
      }
    }
    for (const rawCenter of request.centers ?? [])
      centers.add(centerName(rawCenter));
    return Object.freeze({
      cutoffId,
      businessDays,
      closedDays,
      longestClosure,
      malformedRules: Object.freeze(malformedRules.sort()),
      centers: Object.freeze([...centers].sort()),
      firstOpenEpoch,
      lastOpenEpoch,
    });
  }
}
