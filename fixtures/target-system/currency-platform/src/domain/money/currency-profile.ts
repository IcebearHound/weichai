import type { CurrencyCode } from "../quotes/quote-types.js";

export type CurrencyKind = "fiat" | "fund" | "metal" | "test";
export type SettlementConvention = "same-day" | "next-day" | "spot-two-day" | "custom";

export interface CurrencyProfile {
  readonly code: CurrencyCode;
  readonly numericCode: string;
  readonly displayName: string;
  readonly minorUnits: number;
  readonly kind: CurrencyKind;
  readonly settlementConvention: SettlementConvention;
  readonly primaryRegion: string;
  readonly enabled: boolean;
}

export interface CurrencyProfileSource {
  readonly profiles: readonly CurrencyProfile[];
}
