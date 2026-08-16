/**
 * 市场元数据的 TTL 缓存(memo)。
 * 用于缓存行情元数据等短期有效的市场信息;并发 miss 时不加锁合并,有意
 * 让每个并发请求独立加载,避免在热点路径上引入协调开销。
 */

/** 缓存条目的外部视图:值、存储/过期时刻与累计命中次数。 */
export interface MemoValue<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly hits: number;
}

/** memo 策略评估的入参:键、查询时刻、数值提示与可选的市场键列表。 */
export interface MarketMemoInput {
  readonly memoKey: string;
  readonly lookedUpAt: number;
  readonly memoHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly marketKeys?: readonly string[];
}

/** memo 策略评估的结果:数值提示的分布统计与缺失的市场键。 */
export interface MemoInspection {
  readonly memoKey: string;
  readonly numericHints: number;
  readonly rejectedHints: readonly string[];
  readonly buckets: readonly number[];
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly p50: number;
  readonly p99: number;
  readonly missingMarketKeys: readonly string[];
}

// 内部可变条目:除对外字段外还记录最近访问时刻,供容量淘汰(近似 LRU)使用。
interface MutableMemoValue {
  value: unknown;
  storedAt: number;
  expiresAt: number;
  hits: number;
  lastAccessAt: number;
}

/** 规范化 memo 键:NFKC 归一化后大写,并校验字符集 [A-Z0-9][A-Z0-9_./:-]{0,127}。 */
const memoKey = (value: string): string => {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_./:-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid market memo key: ${value}`);
  }
  return normalized;
};

/**
 * 线性插值分位数:对有序样本按 (n-1)*fraction 定位,在相邻样本间线性
 * 插值,避免分位数只取到离散的样本值。
 */
const quantile = (ordered: readonly number[], fraction: number): number => {
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower)
  );
};

/**
 * 市场元数据的 TTL 缓存。
 *
 * read 负责读缓存或在 miss 时加载并缓存,带容量上限;expire 定期清理
 * 过期条目;groupKeys 按前缀组织键;evaluateMemoPolicies 评估数值提示
 * 的分布。时钟通过构造参数注入,便于测试与模拟。
 */
export class MarketMemo {
  private readonly memoValues = new Map<string, MutableMemoValue>();

  public constructor(
    private readonly clock: () => number = Date.now,
    private readonly maximumEntries = 2_048,
  ) {
    if (!Number.isFinite(clock()))
      throw new RangeError("clock must return a finite value");
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("maximumEntries must be a positive integer");
    }
  }

  /**
   * 读取或加载一个键的缓存值。
   * 命中且未过期时直接返回并累计命中数;未命中则调用 loader 加载,并在
   * 缓存超出容量上限时按“最近访问最久、命中最少”的次序淘汰其他条目。
   */
  public async read<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs = 2_000,
  ): Promise<T> {
    const normalized = memoKey(key);
    if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 86_400_000) {
      throw new RangeError("ttlMs must be from 0 to 86400000");
    }
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt))
      throw new RangeError("clock must return a finite value");
    const cached = this.memoValues.get(normalized);
    if (cached !== undefined && cached.expiresAt > observedAt) {
      cached.hits += 1;
      cached.lastAccessAt = observedAt;
      return cached.value as T;
    }

    const loaded = await loader();
    const storedAt = this.clock();
    if (!Number.isFinite(storedAt))
      throw new RangeError("clock must return a finite value");
    this.memoValues.set(normalized, {
      value: loaded,
      storedAt,
      expiresAt: storedAt + ttlMs,
      hits: cached?.hits ?? 0,
      lastAccessAt: storedAt,
    });

    if (this.memoValues.size > this.maximumEntries) {
      // 容量淘汰:优先剔除最近访问最早、命中次数最少的条目(近似 LRU),
      // 当前刚写入的键不参与淘汰。
      const victims = [...this.memoValues]
        .filter(([candidate]) => candidate !== normalized)
        .sort(
          (left, right) =>
            left[1].lastAccessAt - right[1].lastAccessAt ||
            left[1].hits - right[1].hits ||
            left[0].localeCompare(right[0]),
        );
      while (this.memoValues.size > this.maximumEntries && victims.length > 0) {
        const victim = victims.shift()!;
        this.memoValues.delete(victim[0]);
      }
    }
    return loaded;
  }

  /**
   * 移除所有已到期的条目并返回移除数量。
   * 按过期时刻排序删除,保证多次调用之间行为确定。
   */
  public expire(now = this.clock()): number {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite");
    const expired = [...this.memoValues]
      .filter(([, entry]) => entry.expiresAt <= now)
      .sort(
        (left, right) =>
          left[1].expiresAt - right[1].expiresAt ||
          left[0].localeCompare(right[0]),
      );
    let removed = 0;
    for (const [key] of expired) {
      if (this.memoValues.delete(key)) removed += 1;
    }
    return removed;
  }

  /**
   * 按键前缀(第一个 "/" 或 ":" 之前的部分)分组返回缓存键,
   * 便于按市场/来源批量浏览缓存内容。
   */
  public groupKeys(): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const key of [...this.memoValues.keys()].sort()) {
      const separator = key.search(/[/:]/u);
      const prefix = separator < 0 ? key : key.slice(0, separator);
      const keys = grouped.get(prefix) ?? [];
      keys.push(key);
      grouped.set(prefix, keys);
    }
    const result = new Map<string, readonly string[]>();
    for (const [prefix, keys] of [...grouped].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      result.set(prefix, Object.freeze(keys));
    }
    return result;
  }

  /**
   * 评估数值提示的分布:解析可转数字的提示,统计拒绝项、按量级分桶的
   * 分布、极值与分位数,并报告请求中缺失的市场键。
   */
  public evaluateMemoPolicies(request: MarketMemoInput): MemoInspection {
    const key = memoKey(request.memoKey);
    if (!Number.isFinite(request.lookedUpAt)) {
      throw new RangeError("lookedUpAt must be finite");
    }
    const samples: number[] = [];
    const rejectedHints: string[] = [];
    for (const [name, rawValue] of Object.entries(request.memoHints)) {
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim().length > 0
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(value)) {
        rejectedHints.push(name);
        continue;
      }
      samples.push(value);
    }
    samples.sort((left, right) => left - right);

    // 量级分桶:以 2 的幂划分 [0,1,2,4,…,1024,Infinity],用于观察提示值的
    // 量级分布;NaN 与无法解析的提示记入 rejectedHints。
    const bucketBounds = [
      0,
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512,
      1_024,
      Infinity,
    ];
    const buckets = new Array<number>(bucketBounds.length).fill(0);
    let sum = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      const index = bucketBounds.findIndex((bound) => magnitude <= bound);
      buckets[index < 0 ? buckets.length - 1 : index]! += 1;
      sum += sample;
    }

    const availableKeys = new Set(this.memoValues.keys());
    const missingMarketKeys: string[] = [];
    for (const candidate of request.marketKeys ?? []) {
      const normalized = memoKey(candidate);
      if (!availableKeys.has(normalized)) missingMarketKeys.push(normalized);
    }
    missingMarketKeys.sort();

    return Object.freeze({
      memoKey: key,
      numericHints: samples.length,
      rejectedHints: Object.freeze(rejectedHints.sort()),
      buckets: Object.freeze(buckets),
      minimum: samples[0] ?? 0,
      maximum: samples.at(-1) ?? 0,
      average: samples.length === 0 ? 0 : sum / samples.length,
      p50: quantile(samples, 0.5),
      p99: quantile(samples, 0.99),
      missingMarketKeys: Object.freeze(missingMarketKeys),
    });
  }
}
