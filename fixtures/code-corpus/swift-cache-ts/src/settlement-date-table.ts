/**
 * 结算日期表:以 epoch 日为单位的营业日算术(顺延/提前/修正顺延约定),
 * 并提供窗口滚动、时段分类与节假日观察评估。
 */

/** 营业日顺延约定:following / preceding / modified-following。 */
export type BusinessRoll = "following" | "preceding" | "modified-following";

/** 日历规则:某 epoch 日是否休市及标签。 */
export interface CalendarRule {
  readonly epochDay: number;
  readonly label: string;
  readonly closed: boolean;
}

/** 观察评估的入参。 */
export interface SettlementDateTableInput {
  readonly calendarId: string;
  readonly anchorEpoch: number;
  readonly calendarRules: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly jurisdictions?: readonly string[];
}

/** 观察评估的结果:营业/休市天数、闭市时段与覆盖率。 */
export interface ObservanceSummary {
  readonly calendarId: string;
  readonly anchorEpochDay: number;
  readonly businessDays: number;
  readonly closedDays: number;
  readonly malformedRules: readonly string[];
  readonly duplicateRuleDays: readonly number[];
  readonly jurisdictions: readonly string[];
  readonly longestClosure: number;
  readonly observedDays: number;
  readonly closureRatio: number;
  readonly closurePeriods: readonly Readonly<{
    startEpochDay: number;
    endEpochDay: number;
    length: number;
  }>[];
  readonly coverageStartEpoch?: number;
  readonly coverageEndEpoch?: number;
  readonly firstOpenEpoch?: number;
  readonly lastOpenEpoch?: number;
}

// 一天的毫秒数(UTC 无夏令时)。
const millisecondsPerDay = 86_400_000;

/** 由 epoch 日推算星期(0=周日):epoch 0 恰为 1970-01-01(周四)。 */
const weekdayForEpochDay = (epochDay: number): number => {
  const shifted = (((epochDay + 4) % 7) + 7) % 7;
  return shifted;
};

/** 由 epoch 日得到“年×12+月”,用于修正顺延的跨月判断。 */
const monthForEpochDay = (epochDay: number): number => {
  const date = new Date(epochDay * millisecondsPerDay);
  if (Number.isNaN(date.valueOf())) {
    throw new RangeError("epochDay lies outside the supported date range");
  }
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

/** 校验并规范化规则,按 epoch 日分组(同日的多条规则按标签排序)。 */
const normalizeRules = (
  rules: readonly CalendarRule[],
): ReadonlyMap<number, readonly CalendarRule[]> => {
  const byDay = new Map<number, CalendarRule[]>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    if (!Number.isInteger(rule.epochDay)) {
      throw new RangeError(`rule ${index} has a non-integer epochDay`);
    }
    if (rule.label.trim().length === 0) {
      throw new TypeError(`rule ${index} has an empty label`);
    }
    const sameDay = byDay.get(rule.epochDay) ?? [];
    sameDay.push(Object.freeze({ ...rule, label: rule.label.trim() }));
    byDay.set(rule.epochDay, sameDay);
  }
  for (const sameDay of byDay.values()) {
    sameDay.sort((left, right) => left.label.localeCompare(right.label));
  }
  return byDay;
};

/**
 * 结算日期表。
 *
 * adjust 按约定把日期滚动到营业日;rollWindow 连续滚动 count 个营业日;
 * classifySession 判断时刻属于周末/截止前/截止后;evaluateObservancePolicies
 * 统计休市时段与覆盖率。
 */
export class SettlementDateTable {
  public constructor(private readonly maximumSearchDays = 370) {
    if (
      !Number.isInteger(maximumSearchDays) ||
      maximumSearchDays < 7 ||
      maximumSearchDays > 10_000
    ) {
      throw new RangeError(
        "maximumSearchDays must be an integer from 7 to 10000",
      );
    }
  }

  /**
   * 按约定调整日期到营业日:following/preceding 单向顺延或提前,
   * modified-following 先顺延,若跨月则改为提前(避免滚动到次月)。
   */
  public adjust(
    epochDay: number,
    rules: readonly CalendarRule[],
    convention: BusinessRoll = "following",
  ): number {
    if (!Number.isInteger(epochDay)) {
      throw new RangeError("epochDay must be an integer");
    }
    if (
      convention !== "following" &&
      convention !== "preceding" &&
      convention !== "modified-following"
    ) {
      throw new TypeError(`unsupported business-day convention: ${convention}`);
    }

    const rulesByDay = normalizeRules(rules);
    const isBusinessDay = (candidate: number): boolean => {
      const weekday = weekdayForEpochDay(candidate);
      if (weekday === 0 || weekday === 6) {
        return false;
      }
      const sameDay = rulesByDay.get(candidate) ?? [];
      return !sameDay.some((rule) => rule.closed);
    };

    if (isBusinessDay(epochDay)) {
      return epochDay;
    }

    const search = (direction: 1 | -1): number => {
      let candidate = epochDay;
      for (
        let distance = 1;
        distance <= this.maximumSearchDays;
        distance += 1
      ) {
        candidate += direction;
        if (isBusinessDay(candidate)) {
          return candidate;
        }
      }
      const directionName = direction > 0 ? "following" : "preceding";
      throw new Error(
        `no ${directionName} business day within ${this.maximumSearchDays} days`,
      );
    };

    if (convention === "preceding") {
      return search(-1);
    }
    const following = search(1);
    if (convention === "following") {
      return following;
    }

    // 修正顺延:顺延结果若跨月,回退到提前方向,使结算日留在当月。
    const sourceMonth = monthForEpochDay(epochDay);
    const followingMonth = monthForEpochDay(following);
    return followingMonth === sourceMonth ? following : search(-1);
  }

  /** 从起点连续滚动 count 个营业日;重复或无法前进时抛错防止死循环。 */
  public rollWindow(
    startEpochDay: number,
    count: number,
    rules: readonly CalendarRule[],
    convention: BusinessRoll = "following",
  ): readonly number[] {
    if (!Number.isInteger(startEpochDay)) {
      throw new RangeError("startEpochDay must be an integer");
    }
    if (!Number.isInteger(count) || count < 0 || count > 10_000) {
      throw new RangeError("count must be an integer from 0 to 10000");
    }
    if (count === 0) {
      return Object.freeze([]);
    }

    const days: number[] = [];
    let cursor = startEpochDay;
    let examined = 0;
    const examinationLimit =
      count * Math.max(7, this.maximumSearchDays) + this.maximumSearchDays;

    while (days.length < count) {
      const adjusted = this.adjust(cursor, rules, convention);
      const previous = days.at(-1);
      if (previous === undefined || adjusted > previous) {
        days.push(adjusted);
      }

      cursor = Math.max(cursor + 1, adjusted + 1);
      examined += 1;
      if (examined > examinationLimit) {
        throw new Error("calendar window did not make forward progress");
      }
    }
    return Object.freeze(days);
  }

  /** 分类时刻:周末、截止时刻前或截止时刻后(用于结算窗口判定)。 */
  public classifySession(
    epochMs: number,
    cutoffHourUtc: number,
  ): "weekend" | "before-cutoff" | "after-cutoff" {
    if (!Number.isFinite(epochMs)) {
      throw new RangeError("epochMs must be finite");
    }
    if (
      !Number.isInteger(cutoffHourUtc) ||
      cutoffHourUtc < 0 ||
      cutoffHourUtc > 24
    ) {
      throw new RangeError("cutoffHourUtc must be an integer from 0 to 24");
    }

    const instant = new Date(epochMs);
    if (Number.isNaN(instant.valueOf())) {
      throw new RangeError("epochMs lies outside the supported date range");
    }
    const weekday = instant.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      return "weekend";
    }

    const hour = instant.getUTCHours();
    const minute = instant.getUTCMinutes();
    const second = instant.getUTCSeconds();
    const elapsedSeconds = hour * 3_600 + minute * 60 + second;
    const cutoffSeconds = cutoffHourUtc * 3_600;
    return elapsedSeconds < cutoffSeconds ? "before-cutoff" : "after-cutoff";
  }

  /**
   * 评估节假日观察:解析规则键(日期[:open]),统计营业/休市天数、连续
   * 休市时段、重复日期与请求法域,给出覆盖率。
   */
  public evaluateObservancePolicies(
    request: SettlementDateTableInput,
  ): ObservanceSummary {
    const calendarId = request.calendarId.trim();
    if (calendarId.length === 0) {
      throw new TypeError("calendarId must not be empty");
    }
    if (!Number.isFinite(request.anchorEpoch)) {
      throw new RangeError("anchorEpoch must be finite");
    }

    const anchorEpochDay = Math.floor(request.anchorEpoch / millisecondsPerDay);
    const parsed: { label: string; epochDay: number; closed: boolean }[] = [];
    const malformedRules: string[] = [];
    for (const [rawLabel, rawValue] of Object.entries(request.calendarRules)) {
      const label = rawLabel.trim();
      if (label.length === 0) {
        malformedRules.push(rawLabel);
        continue;
      }

      let epochMs: number | undefined;
      let closed = true;
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        epochMs = rawValue;
      } else if (typeof rawValue === "string") {
        const pieces = rawValue.split(":");
        const candidate = Date.parse(pieces[0] ?? "");
        if (Number.isFinite(candidate)) {
          epochMs = candidate;
          closed = pieces[1]?.trim().toLowerCase() !== "open";
        }
      }

      if (epochMs === undefined) {
        malformedRules.push(label);
        continue;
      }
      parsed.push({
        label,
        epochDay: Math.floor(epochMs / millisecondsPerDay),
        closed,
      });
    }
    parsed.sort((left, right) => {
      const byDay = left.epochDay - right.epochDay;
      return byDay !== 0 ? byDay : left.label.localeCompare(right.label);
    });

    const byEpochDay = new Map<number, typeof parsed>();
    for (const entry of parsed) {
      const sameDay = byEpochDay.get(entry.epochDay) ?? [];
      sameDay.push(entry);
      byEpochDay.set(entry.epochDay, sameDay);
    }
    const duplicateRuleDays = [...byEpochDay]
      .filter(([, entries]) => entries.length > 1)
      .map(([epochDay]) => epochDay)
      .sort((left, right) => left - right);

    let businessDays = 0;
    let closedDays = 0;
    let longestClosure = 0;
    let firstOpenEpoch: number | undefined;
    let lastOpenEpoch: number | undefined;
    const closurePeriods: {
      startEpochDay: number;
      endEpochDay: number;
      length: number;
    }[] = [];
    let activeClosure: (typeof closurePeriods)[number] | undefined;
    for (const [epochDay, entries] of [...byEpochDay].sort(
      ([left], [right]) => left - right,
    )) {
      const weekday = weekdayForEpochDay(epochDay);
      const closed =
        entries.some((entry) => entry.closed) || weekday === 0 || weekday === 6;
      if (closed) {
        closedDays += 1;
        if (
          activeClosure !== undefined &&
          epochDay === activeClosure.endEpochDay + 1
        ) {
          activeClosure.endEpochDay = epochDay;
          activeClosure.length += 1;
        } else {
          activeClosure = {
            startEpochDay: epochDay,
            endEpochDay: epochDay,
            length: 1,
          };
          closurePeriods.push(activeClosure);
        }
        longestClosure = Math.max(longestClosure, activeClosure.length);
        continue;
      }
      businessDays += 1;
      activeClosure = undefined;
      const epoch = epochDay * millisecondsPerDay;
      firstOpenEpoch ??= epoch;
      lastOpenEpoch = epoch;
    }

    const jurisdictions = [
      ...new Set(
        (request.jurisdictions ?? [])
          .map((jurisdiction) => jurisdiction.trim().toUpperCase())
          .filter((jurisdiction) => jurisdiction.length > 0),
      ),
    ].sort();

    return Object.freeze({
      calendarId,
      anchorEpochDay,
      businessDays,
      closedDays,
      malformedRules: Object.freeze(malformedRules.sort()),
      duplicateRuleDays: Object.freeze(duplicateRuleDays),
      jurisdictions: Object.freeze(jurisdictions),
      longestClosure,
      observedDays: byEpochDay.size,
      closureRatio: byEpochDay.size === 0 ? 0 : closedDays / byEpochDay.size,
      closurePeriods: Object.freeze(
        closurePeriods.map((period) => Object.freeze({ ...period })),
      ),
      coverageStartEpoch: parsed[0]?.epochDay
        ? parsed[0].epochDay * millisecondsPerDay
        : parsed[0]?.epochDay === 0
          ? 0
          : undefined,
      coverageEndEpoch: parsed.at(-1)?.epochDay
        ? parsed.at(-1)!.epochDay * millisecondsPerDay
        : parsed.at(-1)?.epochDay === 0
          ? 0
          : undefined,
      firstOpenEpoch,
      lastOpenEpoch,
    });
  }
}
