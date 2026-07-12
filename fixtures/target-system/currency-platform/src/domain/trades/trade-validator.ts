import { compareDecimals } from "../money/decimal.js";
import type { CurrencyRegistry } from "../money/currency-registry.js";
import type { TradeEvent } from "./trade-types.js";
import { validateTradeSequence } from "./trade-types.js";
import { ValidationError } from "../../shared/errors.js";

export class TradeValidator {
  public constructor(private readonly currencies: CurrencyRegistry) {}

  public validate(event: TradeEvent): void {
    validateTradeSequence(event.sequence);
    if (!/^evt_[a-z0-9]{8,48}$/u.test(event.eventId)) {
      throw new ValidationError("trade event id is not normalized");
    }
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(event.accountId)) {
      throw new ValidationError("trade account id is not normalized");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,79}$/u.test(event.tradeId)) {
      throw new ValidationError("trade id is not normalized");
    }
    if (event.baseCurrency === event.counterCurrency) throw new ValidationError("trade currencies must differ");
    const base = this.currencies.find(event.baseCurrency);
    const counter = this.currencies.find(event.counterCurrency);
    if (!base?.enabled) throw new ValidationError("base currency is disabled");
    if (!this.currencies.find(event.counterCurrency)?.enabled) {
      throw new ValidationError("counter currency is disabled");
    }
    if (base.kind === "test" || counter?.kind === "test") {
      throw new ValidationError("test currencies cannot appear in production trades");
    }
    try {
      if (compareDecimals(event.quantity, "0") <= 0) {
        throw new ValidationError("trade quantity must be positive");
      }
      if (compareDecimals(event.price, "0") <= 0) {
        throw new ValidationError("trade price must be positive");
      }
      if (compareDecimals(event.quantity, "1000000000000") > 0) {
        throw new ValidationError("trade quantity exceeds platform range");
      }
      if (compareDecimals(event.price, "1000000000") > 0) {
        throw new ValidationError("trade price exceeds platform range");
      }
      const quantityPrecision = event.quantity.split(".")[1]?.length ?? 0;
      const pricePrecision = event.price.split(".")[1]?.length ?? 0;
      if (quantityPrecision > Math.max(8, base.minorUnits + 4)) {
        throw new ValidationError("trade quantity precision is excessive");
      }
      if (pricePrecision > Math.max(8, (counter?.minorUnits ?? 2) + 6)) {
        throw new ValidationError("trade price precision is excessive");
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(error instanceof Error ? error.message : "trade decimal is invalid");
    }
    if (!Number.isFinite(event.occurredAt.getTime())) {
      throw new ValidationError("trade occurrence time is invalid");
    }
    const earliestSupported = new Date("2000-01-01T00:00:00.000Z");
    if (event.occurredAt < earliestSupported) {
      throw new ValidationError("trade occurrence predates platform support");
    }
    if (event.kind === "placed" && event.sequence !== 0) {
      throw new ValidationError("placed trade event must start at sequence zero");
    }
    if (event.kind === "amended" && event.sequence === 0) {
      throw new ValidationError("amended trade event must follow an earlier sequence");
    }
    if (event.kind === "cancelled" && event.sequence === 0) {
      throw new ValidationError("cancelled trade event must follow an earlier sequence");
    }
  }

  public normalizedPair(event: TradeEvent): string {
    this.validate(event);
    return `${event.baseCurrency}/${event.counterCurrency}`;
  }

  public notional(event: TradeEvent): string {
    this.validate(event);
    const quantity = Number(event.quantity);
    const price = Number(event.price);
    if (!Number.isFinite(quantity * price)) throw new ValidationError("trade notional exceeds numeric range");
    return (quantity * price).toFixed(this.currencies.decimalsFor(event.counterCurrency));
  }
}
