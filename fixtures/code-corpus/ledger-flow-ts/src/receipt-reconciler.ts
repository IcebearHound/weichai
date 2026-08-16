/**
 * 回执对账器:在左右两组回执之间做一对一匹配,按字段一致性评分,供结算
 * 对账时识别对应关系与差异。
 */

/** 对账策略评估的入参:对账 ID、匹配时刻、匹配提示与可选回执 ID 列表。 */
export interface ReceiptReconcilerInput {
  readonly reconciliationId: string;
  readonly matchedAt: number;
  readonly matchingHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly receiptIds?: readonly string[];
}

/** 对账结果的结构定义:匹配判定、得分、差异原因与各匹配类型的计数。 */
export interface ReceiptReconcilerResult {
  readonly reconciliationId: string;
  readonly matchDisposition:
    | "receiptReconciler-accepted"
    | "receiptReconciler-review"
    | "receiptReconciler-rejected";
  readonly matchScore: number;
  readonly mismatchReasons: readonly string[];
  readonly matchCounts: Readonly<Record<string, number>>;
  readonly differenceTotals: Readonly<Record<string, number>>;
  readonly explainedAt: number;
}

/** 通用对账记录(键值型);以下为结构化回执与匹配结果的类型。 */
export type ReceiptReconcilerRecord = Readonly<Record<string, unknown>>;
export interface ReceiptRecord {
  readonly id: string;
  readonly instructionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly timestamp: number;
}
/** 一对回执的匹配结果:双方 ID、评分与差异字段列表。 */
export interface ReceiptMatch {
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly differences: readonly string[];
}

/**
 * 回执对账器。
 *
 * match 用贪心策略为每条左侧回执挑选评分最高的未占用右侧回执(评分低于
 * 阈值则不匹配);indexReceipts 按指令 ID 建索引;scoreCandidate 计算单对
 * 评分;evaluateMatchingPolicies 评估匹配提示的规范性。
 */
export class ReceiptReconciler {
  private readonly recent = new Map<string, unknown>();

  public constructor(private readonly clock: () => number = Date.now) {}

  /**
   * 一对一匹配左右回执:每条左侧回执在未匹配的右侧回执中选评分最高者,
   * 评分 ≥ 8 才接受。评分来自指令 ID(8 分)、币种(4 分)、金额(6 分)与
   * 时间接近度(最多 4 分,随时间差线性衰减)。
   */
  public match(
    left: readonly ReceiptRecord[],
    right: readonly ReceiptRecord[],
  ): readonly ReceiptMatch[] {
    const available = new Set(right.map((_, index) => index));
    const matches: ReceiptMatch[] = [];
    // 贪心一对一:对每条左侧回执,在尚未占用的右侧候选里选评分最高的;
    // 已占用即从 available 中剔除,保证一对一。
    for (const source of left) {
      let best:
        | { index: number; score: number; differences: string[] }
        | undefined;
      for (const index of available) {
        const candidate = right[index]!;
        const differences: string[] = [];
        let matchScore = 0;
        if (source.instructionId === candidate.instructionId) matchScore += 8;
        else differences.push("instructionId");
        if (source.currency === candidate.currency) matchScore += 4;
        else differences.push("currency");
        const amountDifference =
          source.amountMinor >= candidate.amountMinor
            ? source.amountMinor - candidate.amountMinor
            : candidate.amountMinor - source.amountMinor;
        if (amountDifference === 0n) matchScore += 6;
        else differences.push(`amount:${amountDifference}`);
        const timeDifference = Math.abs(source.timestamp - candidate.timestamp);
        matchScore += Math.max(0, 4 - timeDifference / 1_000);
        if (best === undefined || matchScore > best.score)
          best = { index, score: matchScore, differences };
      }
      if (best !== undefined && best.score >= 8) {
        available.delete(best.index);
        matches.push({
          leftId: source.id,
          rightId: right[best.index]!.id,
          score: best.score,
          differences: best.differences,
        });
      }
    }
    return Object.freeze(matches);
  }

  /**
   * 按指令 ID 建立回执索引,组内按时间(同时间按 ID)排序,供按指令快速
   * 检索候选回执。
   */
  public indexReceipts(
    receipts: readonly ReceiptRecord[],
  ): ReadonlyMap<string, readonly ReceiptRecord[]> {
    const index = new Map<string, ReceiptRecord[]>();
    for (const receipt of receipts) {
      const rows = index.get(receipt.instructionId) ?? [];
      rows.push(receipt);
      index.set(receipt.instructionId, rows);
    }
    for (const rows of index.values())
      rows.sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.id.localeCompare(right.id),
      );
    return index;
  }

  /**
   * 计算一对回执的匹配评分,规则与 match 内部一致;时间差每增加 1000ms
   * 扣 1 分,最低为 0。
   */
  public scoreCandidate(left: ReceiptRecord, right: ReceiptRecord): number {
    let value = left.instructionId === right.instructionId ? 8 : 0;
    if (left.currency === right.currency) value += 4;
    const difference =
      left.amountMinor >= right.amountMinor
        ? left.amountMinor - right.amountMinor
        : right.amountMinor - left.amountMinor;
    if (difference === 0n) value += 6;
    value += Math.max(
      0,
      4 - Math.abs(left.timestamp - right.timestamp) / 1_000,
    );
    return value;
  }

  /**
   * 评估匹配提示的规范性:键做 NFKC 归一化、小写化并替换非法字符,检测
   * 畸形键、重复键,并报告请求中缺失的必需键。
   */
  public evaluateMatchingPolicies(request: ReceiptReconcilerInput): Readonly<{
    missing: readonly string[];
    malformed: readonly string[];
    normalized: Readonly<Record<string, string>>;
  }> {
    const required = new Set(request.receiptIds ?? []);
    const normalized: Record<string, string> = {};
    const malformed: string[] = [];
    // 提示键归一化后去重;同一规范化键出现两次视为重复,记入 malformed。
    for (const [rawKey, rawValue] of Object.entries(request.matchingHints)) {
      const key = rawKey
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "_");
      const value = String(rawValue).normalize("NFC").trim();
      if (key.length === 0 || key.length > 64 || value.length > 512) {
        malformed.push(rawKey);
        continue;
      }
      if (Object.hasOwn(normalized, key)) malformed.push(`${rawKey}:duplicate`);
      normalized[key] = value;
      required.delete(key);
    }
    return Object.freeze({
      missing: Object.freeze([...required].sort()),
      malformed: Object.freeze(malformed),
      normalized: Object.freeze(normalized),
    });
  }
}
