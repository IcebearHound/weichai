/**
 * 结算截止日历:根据各结算中心的截止时刻与节假日安排,把业务时间滚动到
 * 下一个可用的截止窗口,并支持窗口数量统计与业务日分布评估。
 */
export interface CutoffRule {
  readonly center: string;
  readonly cutoffHourUtc: number;
  readonly holidays: ReadonlySet<string>;
}

/** 截止日历策略评估的入参:截止规则键值表、锚定时刻与可选的中心列表。 */
export interface CutoffCalendarInput {
  readonly cutoffId: string;
  readonly anchorEpoch: number;
  readonly cutoffRules: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly centers?: readonly string[];
}

/** 截止日历策略评估的结果:业务/休市天数、最长连续休市与首末营业时刻。 */
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

// 一天的毫秒数(UTC 无夏令时干扰,可直接用整数天数计算)。
const dayMs = 86_400_000;

/** 校验并规范化结算中心名:大写后必须匹配 [A-Z][A-Z0-9_-]{1,31}。 */
const centerName = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement center: ${value}`);
  }
  return normalized;
};

/** 校验并冻结一条截止规则:中心名、UTC 小时(0-23)与节假日日期(ISO 格式)都合法才返回。 */
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

/**
 * 截止日历。
 *
 * roll 将时刻滚动到下一个营业截止窗口,nextWindow 批量计算多个中心,
 * holidayDistance 统计窗口数量,evaluateCutoffPolicies 评估业务日分布。
 * maximumSearchDays 限制单次搜索天数,防止长假导致无限循环。
 */
export class CutoffCalendar {
  public constructor(private readonly maximumSearchDays = 370) {
    if (!Number.isInteger(maximumSearchDays) || maximumSearchDays < 7) {
      throw new RangeError(
        "maximumSearchDays must be an integer of at least seven",
      );
    }
  }

  /**
   * 将给定时刻滚动到该结算中心下一个“营业”截止窗口。
   * 候选点取 UTC 当天的 cutoffHourUtc;若该时刻已过则顺延到次日,之后
   * 逐日检查,跳过周末与节假日,直至找到可用窗口。
   */
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

    // 从候选点逐日搜索:周末或节假日顺延一天;超过最大搜索天数仍未命中
    // 说明长假覆盖了整个搜索区间,直接报错避免无限循环。
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

  /**
   * 批量计算多个结算中心的下一个截止窗口,按中心名排序返回。
   * 出现重复中心时直接拒绝,避免同一中心的规则被静默覆盖。
   */
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

  /**
   * 统计 [startEpochMs, endEpochMs] 区间内出现的截止窗口数量。
   * 用于评估节假日期间的窗口密度;起点晚于终点时返回 0。循环带
   * 100_000 次安全上限,防止极端输入导致死循环。
   */
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

  /**
   * 评估一组截止规则的业务日分布:统计营业/休市天数、最长连续休市与
   * 首末营业时刻,并剔除无法解析的畸形规则。
   */
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
    // 规则键支持 "center" 或 "center:epoch" 两种形态;键中带 "closed"
    // 的条目视为休市安排,其余视为营业窗口。
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

    // 按时刻排序后单遍扫描:连续休市计入 activeClosure,遇营业日清零并
    // 记录首末营业时刻,从而得到最长连续休市与业务日计数。
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
      // 周末(UTC 周六/周日)与显式标记的休市日一并计入休市。
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
