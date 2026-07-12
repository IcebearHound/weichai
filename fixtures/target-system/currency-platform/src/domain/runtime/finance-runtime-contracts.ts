export type FeeRoundingMode = "up" | "down" | "nearest" | "bankers";
export type ReconciliationOutcome = "exact" | "tolerated" | "ambiguous" | "unmatched" | "invalid";

export interface FeeBand {
  readonly bandId: string;
  readonly fromAmount: string;
  readonly toAmount?: string;
  readonly fixedFee: string;
  readonly variableBps: number;
  readonly minimumFee?: string;
  readonly maximumFee?: string;
}

export interface FeeDiscount {
  readonly discountId: string;
  readonly customerSegment: string;
  readonly corridor?: string;
  readonly percentageBps: number;
  readonly fixedReduction?: string;
  readonly maximumReduction?: string;
  readonly effectiveFrom: Date;
  readonly effectiveUntil?: Date;
  readonly stackable: boolean;
}

export interface FeePricingInput {
  readonly transactionId: string;
  readonly amount: string;
  readonly sourceCurrency: string;
  readonly destinationCurrency: string;
  readonly customerSegment: string;
  readonly providerCost: string;
  readonly bands: readonly FeeBand[];
  readonly discounts: readonly FeeDiscount[];
  readonly taxBps: number;
  readonly minorUnits: number;
  readonly roundingMode: FeeRoundingMode;
  readonly pricedAt: Date;
}

export interface FeeComponent {
  readonly code: string;
  readonly amount: string;
  readonly taxable: boolean;
  readonly sourceId?: string;
  readonly description: string;
}

export interface FeePricingResult {
  readonly transactionId: string;
  readonly grossFee: string;
  readonly discount: string;
  readonly tax: string;
  readonly totalFee: string;
  readonly netAmount: string;
  readonly components: readonly FeeComponent[];
  readonly appliedBandId?: string;
  readonly appliedDiscountIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface ReconciliationExternalLine {
  readonly lineId: string;
  readonly externalReference?: string;
  readonly accountCode: string;
  readonly currency: string;
  readonly amount: string;
  readonly valueDate: string;
  readonly description: string;
  readonly counterparty?: string;
}

export interface ReconciliationInternalLine {
  readonly postingId: string;
  readonly ledgerReference?: string;
  readonly accountCode: string;
  readonly currency: string;
  readonly amount: string;
  readonly valueDate: string;
  readonly receiptId?: string;
  readonly settledAt: Date;
}

export interface ReconciliationMatch {
  readonly externalLineIds: readonly string[];
  readonly internalPostingIds: readonly string[];
  readonly outcome: ReconciliationOutcome;
  readonly confidenceScore: number;
  readonly amountDifference: string;
  readonly dateDifferenceDays: number;
  readonly reasons: readonly string[];
}

export interface ReconciliationResult {
  readonly matches: readonly ReconciliationMatch[];
  readonly unmatchedExternalLineIds: readonly string[];
  readonly unmatchedInternalPostingIds: readonly string[];
  readonly totalExternalAmount: string;
  readonly totalInternalAmount: string;
  readonly netDifference: string;
  readonly ambiguousGroups: number;
  readonly diagnostics: readonly string[];
}
