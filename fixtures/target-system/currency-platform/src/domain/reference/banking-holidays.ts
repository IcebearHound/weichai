import { currencyCode } from "../quotes/quote-types.js";
import type { HolidayRecord } from "./reference-types.js";

export const bankingHolidays: readonly HolidayRecord[] = [
  { calendar: "US-FED-2026", date: "2026-01-01", name: "New Year Closure", scope: "banking",
    affectedCurrencies: [currencyCode("USD")], fullClosure: true },
  { calendar: "US-FED-2026", date: "2026-07-03", name: "Independence Day Observed", scope: "national",
    affectedCurrencies: [currencyCode("USD")], fullClosure: true },
  { calendar: "TARGET-2026", date: "2026-04-03", name: "Good Friday", scope: "market",
    affectedCurrencies: [currencyCode("EUR")], fullClosure: true },
  { calendar: "TARGET-2026", date: "2026-12-25", name: "Christmas Closure", scope: "banking",
    affectedCurrencies: [currencyCode("EUR")], fullClosure: true },
  { calendar: "GB-BANK-2026", date: "2026-08-31", name: "Summer Bank Holiday", scope: "national",
    affectedCurrencies: [currencyCode("GBP")], fullClosure: true },
  { calendar: "JP-BOJ-2026", date: "2026-05-04", name: "Greenery Day Observed", scope: "banking",
    affectedCurrencies: [currencyCode("JPY")], fullClosure: true },
  { calendar: "CN-CNAPS-2026", date: "2026-10-02", name: "National Day Banking Holiday", scope: "national",
    affectedCurrencies: [currencyCode("CNY")], fullClosure: true },
  { calendar: "HK-CHATS-2026", date: "2026-09-26", name: "Regional Market Holiday", scope: "regional",
    affectedCurrencies: [currencyCode("HKD"), currencyCode("CNY")], fullClosure: false },
  { calendar: "SG-MEPS-2026", date: "2026-08-10", name: "National Day Observed", scope: "banking",
    affectedCurrencies: [currencyCode("SGD")], fullClosure: true },
  { calendar: "IN-RBI-2026", date: "2026-10-02", name: "Gandhi Jayanti", scope: "national",
    affectedCurrencies: [currencyCode("INR")], fullClosure: true },
  { calendar: "AU-RBA-2026", date: "2026-12-28", name: "Boxing Day Observed", scope: "banking",
    affectedCurrencies: [currencyCode("AUD")], fullClosure: true },
];
