import { currencyCode } from "../quotes/quote-types.js";
import type { LedgerAccountRecord } from "./reference-types.js";

export const ledgerAccounts: readonly LedgerAccountRecord[] = [
  { accountCode: "101000", displayName: "USD Cash Nostro", category: "asset", currency: currencyCode("USD"),
    normalBalance: "debit", reconciliationCadence: "intraday", postingRestricted: false },
  { accountCode: "101100", displayName: "EUR Cash Nostro", category: "asset", currency: currencyCode("EUR"),
    normalBalance: "debit", reconciliationCadence: "intraday", postingRestricted: false },
  { accountCode: "201000", displayName: "Customer Settlement Payable", category: "liability",
    currency: currencyCode("USD"), normalBalance: "credit", reconciliationCadence: "daily", postingRestricted: false },
  { accountCode: "208000", displayName: "Unclaimed Receipt Reserve", category: "liability",
    currency: currencyCode("USD"), normalBalance: "credit", reconciliationCadence: "weekly", postingRestricted: true },
  { accountCode: "301000", displayName: "Regulatory Capital", category: "equity", currency: currencyCode("USD"),
    normalBalance: "credit", reconciliationCadence: "monthly", postingRestricted: true },
  { accountCode: "401000", displayName: "Realized FX Spread", category: "income", currency: currencyCode("USD"),
    normalBalance: "credit", reconciliationCadence: "daily", postingRestricted: false },
  { accountCode: "501000", displayName: "Provider Transaction Fees", category: "expense",
    currency: currencyCode("USD"), normalBalance: "debit", reconciliationCadence: "daily", postingRestricted: false },
  { accountCode: "509000", displayName: "Operational Settlement Loss", category: "expense",
    currency: currencyCode("USD"), normalBalance: "debit", reconciliationCadence: "intraday", postingRestricted: true },
  { accountCode: "109000", displayName: "Settlement Suspense", category: "asset", currency: currencyCode("USD"),
    normalBalance: "debit", reconciliationCadence: "intraday", postingRestricted: true },
];
