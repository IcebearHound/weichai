import type { PairLimitRecord } from "./reference-types.js";

export const pairLimits: readonly PairLimitRecord[] = [
  { pair: "EUR/USD", desk: "spot-major", maximumNotional: "5000000.00", maximumSpreadBps: 8,
    maximumQuoteAgeMs: 1000, tradingHours: "00:00-23:00Z", riskTier: "standard" },
  { pair: "GBP/USD", desk: "spot-major", maximumNotional: "4000000.00", maximumSpreadBps: 10,
    maximumQuoteAgeMs: 1000, tradingHours: "00:00-23:00Z", riskTier: "standard" },
  { pair: "USD/JPY", desk: "spot-major", maximumNotional: "5000000.00", maximumSpreadBps: 9,
    maximumQuoteAgeMs: 1000, tradingHours: "00:00-23:00Z", riskTier: "standard" },
  { pair: "USD/CNY", desk: "spot-emerging", maximumNotional: "1500000.00", maximumSpreadBps: 35,
    maximumQuoteAgeMs: 2000, tradingHours: "01:00-10:00Z", riskTier: "monitored" },
  { pair: "USD/INR", desk: "spot-emerging", maximumNotional: "750000.00", maximumSpreadBps: 55,
    maximumQuoteAgeMs: 5000, tradingHours: "03:00-12:00Z", riskTier: "elevated" },
  { pair: "AUD/USD", desk: "treasury-hedge", maximumNotional: "2000000.00", maximumSpreadBps: 18,
    maximumQuoteAgeMs: 2000, tradingHours: "00:00-14:00Z", riskTier: "standard" },
  { pair: "USD/ZAR", desk: "corporate-flow", maximumNotional: "500000.00", maximumSpreadBps: 80,
    maximumQuoteAgeMs: 5000, tradingHours: "06:00-16:00Z", riskTier: "elevated" },
  { pair: "XAU/USD", desk: "treasury-hedge", maximumNotional: "1000000.00", maximumSpreadBps: 45,
    maximumQuoteAgeMs: 2000, tradingHours: "01:00-22:00Z", riskTier: "monitored" },
];
