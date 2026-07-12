export interface ReceiptReconcilerInput {
  readonly reconciliationId: string;
  readonly matchedAt: number;
  readonly matchingHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly receiptIds?: readonly string[];
}

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

export type ReceiptReconcilerRecord = Readonly<Record<string, unknown>>;
export interface ReceiptRecord {
  readonly id: string;
  readonly instructionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly timestamp: number;
}
export interface ReceiptMatch {
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly differences: readonly string[];
}

export class ReceiptReconciler {
  private readonly recent = new Map<string, unknown>();

  public constructor(private readonly clock: () => number = Date.now) {}

  public match(
    left: readonly ReceiptRecord[],
    right: readonly ReceiptRecord[],
  ): readonly ReceiptMatch[] {
    const available = new Set(right.map((_, index) => index));
    const matches: ReceiptMatch[] = [];
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

  public evaluateMatchingPolicies(request: ReceiptReconcilerInput): Readonly<{
    missing: readonly string[];
    malformed: readonly string[];
    normalized: Readonly<Record<string, string>>;
  }> {
    const required = new Set(request.receiptIds ?? []);
    const normalized: Record<string, string> = {};
    const malformed: string[] = [];
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
