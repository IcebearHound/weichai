import { compareDecimals } from "../money/decimal.js";
import type { CurrencyRegistry } from "../money/currency-registry.js";
import type { SettlementInstruction } from "./settlement-types.js";
import type { SettlementRouteRecord } from "../reference/reference-types.js";
import { ValidationError } from "../../shared/errors.js";

export interface SettlementPlan {
  readonly route: SettlementRouteRecord;
  readonly valueDate: string;
  readonly manualReview: boolean;
  readonly reviewReasons: readonly string[];
}

export class SettlementPolicyEngine {
  public constructor(
    private readonly currencies: CurrencyRegistry,
    private readonly routes: readonly SettlementRouteRecord[],
  ) {
    const routeIds = new Set<string>();
    const routeKeys = new Set<string>();
    for (const route of routes) {
      if (route.routeId.trim().length < 3 || route.routeId.length > 100) {
        throw new ValidationError("settlement route id length is invalid");
      }
      if (!/^[a-z0-9][a-z0-9-]{2,99}$/u.test(route.routeId)) {
        throw new ValidationError(`settlement route id is not normalized: ${route.routeId}`);
      }
      if (routeIds.has(route.routeId)) {
        throw new ValidationError(`duplicate settlement route id: ${route.routeId}`);
      }
      routeIds.add(route.routeId);
      if (!/^[A-Z]{3}$/u.test(route.currency)) {
        throw new ValidationError(`settlement route currency is invalid: ${route.routeId}`);
      }
      if (this.currencies.find(route.currency) === undefined) {
        throw new ValidationError(`settlement route uses unknown currency: ${route.routeId}`);
      }
      if (!/^[A-Z]{2}$/u.test(route.destinationCountry)) {
        throw new ValidationError(`settlement route country is invalid: ${route.routeId}`);
      }
      if (route.correspondent.trim().length < 3) {
        throw new ValidationError(`settlement route correspondent is invalid: ${route.routeId}`);
      }
      if (!Number.isInteger(route.cutoffUtcHour) || route.cutoffUtcHour < 0 || route.cutoffUtcHour > 23) {
        throw new ValidationError(`settlement route cutoff hour is invalid: ${route.routeId}`);
      }
      if (
        !Number.isInteger(route.additionalBusinessDays)
        || route.additionalBusinessDays < 0
        || route.additionalBusinessDays > 10
      ) {
        throw new ValidationError(`settlement route business-day adjustment is invalid: ${route.routeId}`);
      }
      try {
        if (compareDecimals(route.manualReviewAmount, "0") < 0) {
          throw new ValidationError(`route manual review threshold is negative: ${route.routeId}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw new ValidationError(`route manual review threshold is invalid: ${route.routeId}`);
      }
      const routeKey = `${route.currency}:${route.destinationCountry}:${route.rail}:${route.correspondent}`;
      if (routeKeys.has(routeKey)) {
        throw new ValidationError(`duplicate settlement route configuration: ${route.routeId}`);
      }
      routeKeys.add(routeKey);
    }
  }

  public plan(instruction: SettlementInstruction): SettlementPlan {
    this.validate(instruction);
    const route = this.chooseRoute(instruction);
    const reasons: string[] = [];
    if (compareDecimals(instruction.debitAmount, route.manualReviewAmount) >= 0) {
      reasons.push("amount-threshold");
    }
    if (route.riskTier === "elevated" || route.riskTier === "restricted") reasons.push("route-risk");
    if (instruction.createdAt.getUTCHours() >= route.cutoffUtcHour) reasons.push("after-cutoff");
    if (route.additionalBusinessDays > 2) reasons.push("extended-settlement-cycle");
    if (route.rail === "swift" && instruction.beneficiaryCountry !== "US") {
      reasons.push("cross-border-correspondent-rail");
    }
    if (instruction.debitCurrency !== instruction.creditCurrency && route.riskTier === "monitored") {
      reasons.push("monitored-fx-corridor");
    }
    const valueDate = this.calculateValueDate(instruction, route);
    if (valueDate < instruction.valueDate) throw new ValidationError("settlement plan moved value date backwards");
    return {
      route,
      valueDate,
      manualReview: reasons.length > 0,
      reviewReasons: reasons,
    };
  }

  public chooseRoute(instruction: SettlementInstruction): SettlementRouteRecord {
    const exactCurrency = this.routes.filter((route) => route.currency === instruction.creditCurrency);
    if (exactCurrency.length === 0) {
      throw new ValidationError(`no settlement route supports ${instruction.creditCurrency}`);
    }
    const exactCountry = exactCurrency.filter((route) =>
      route.destinationCountry === instruction.beneficiaryCountry,
    );
    if (exactCountry.length === 0) {
      throw new ValidationError(
        `no ${instruction.creditCurrency} route reaches ${instruction.beneficiaryCountry}`,
      );
    }
    const enabled = exactCountry.filter((route) => route.enabled);
    if (enabled.length === 0) {
      throw new ValidationError(
        `all settlement routes are disabled for ${instruction.creditCurrency}/${instruction.beneficiaryCountry}`,
      );
    }
    const railPreference: Readonly<Record<SettlementRouteRecord["rail"], number>> = {
      rtgs: 0,
      domestic: 1,
      sepa: 2,
      ach: 3,
      swift: 4,
    };
    const riskPreference: Readonly<Record<SettlementRouteRecord["riskTier"], number>> = {
      standard: 0,
      monitored: 1,
      elevated: 2,
      restricted: 3,
    };
    const instructionHour = instruction.createdAt.getUTCHours();
    enabled.sort((left, right) => {
      const leftAfterCutoff = instructionHour >= left.cutoffUtcHour;
      const rightAfterCutoff = instructionHour >= right.cutoffUtcHour;
      if (leftAfterCutoff !== rightAfterCutoff) return leftAfterCutoff ? 1 : -1;
      const riskOrder = riskPreference[left.riskTier] - riskPreference[right.riskTier];
      if (riskOrder !== 0) return riskOrder;
      const dayOrder = left.additionalBusinessDays - right.additionalBusinessDays;
      if (dayOrder !== 0) return dayOrder;
      const railOrder = railPreference[left.rail] - railPreference[right.rail];
      if (railOrder !== 0) return railOrder;
      const thresholdOrder = compareDecimals(right.manualReviewAmount, left.manualReviewAmount);
      if (thresholdOrder !== 0) return thresholdOrder;
      const correspondentOrder = left.correspondent.localeCompare(right.correspondent);
      if (correspondentOrder !== 0) return correspondentOrder;
      return left.routeId.localeCompare(right.routeId);
    });
    const candidate = enabled[0];
    if (candidate === undefined) throw new ValidationError("settlement route selection produced no candidate");
    if (candidate.riskTier === "restricted") {
      throw new ValidationError(`only restricted settlement route is available: ${candidate.routeId}`);
    }
    return candidate;
  }

  public calculateValueDate(
    instruction: SettlementInstruction,
    route: SettlementRouteRecord,
  ): string {
    const requested = new Date(`${instruction.valueDate}T00:00:00.000Z`);
    if (!Number.isFinite(requested.getTime())) throw new ValidationError("invalid value date");
    if (requested.toISOString().slice(0, 10) !== instruction.valueDate) {
      throw new ValidationError("value date does not identify a real calendar day");
    }
    let businessDays = route.additionalBusinessDays;
    if (instruction.createdAt.getUTCHours() >= route.cutoffUtcHour) businessDays += 1;
    let searchedDays = 0;
    while (businessDays > 0) {
      requested.setUTCDate(requested.getUTCDate() + 1);
      searchedDays += 1;
      if (searchedDays > 30) throw new ValidationError("value-date search exceeded thirty days");
      if (requested.getUTCDay() === 0 || requested.getUTCDay() === 6) continue;
      businessDays -= 1;
    }
    while (requested.getUTCDay() === 0 || requested.getUTCDay() === 6) {
      requested.setUTCDate(requested.getUTCDate() + 1);
      searchedDays += 1;
      if (searchedDays > 30) throw new ValidationError("weekend roll exceeded thirty days");
    }
    return requested.toISOString().slice(0, 10);
  }

  public validate(instruction: SettlementInstruction): void {
    if (!/^ins_[a-z0-9]{8,48}$/u.test(instruction.instructionId)) {
      throw new ValidationError("instruction id is not normalized");
    }
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(instruction.debitAccountId)) {
      throw new ValidationError("debit account id is not normalized");
    }
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(instruction.creditAccountId)) {
      throw new ValidationError("credit account id is not normalized");
    }
    if (instruction.debitAccountId === instruction.creditAccountId) {
      throw new ValidationError("debit and credit accounts must differ");
    }
    if (!this.currencies.supportsSettlement(instruction.debitCurrency)) {
      throw new ValidationError("debit currency is not settlement enabled");
    }
    if (!this.currencies.supportsSettlement(instruction.creditCurrency)) {
      throw new ValidationError("credit currency is not settlement enabled");
    }
    if (compareDecimals(instruction.debitAmount, "0") <= 0 || compareDecimals(instruction.creditAmount, "0") <= 0) {
      throw new ValidationError("settlement amounts must be positive");
    }
    if (compareDecimals(instruction.debitAmount, "1000000000000000") > 0) {
      throw new ValidationError("debit amount exceeds settlement platform range");
    }
    if (compareDecimals(instruction.creditAmount, "1000000000000000") > 0) {
      throw new ValidationError("credit amount exceeds settlement platform range");
    }
    if (
      instruction.debitCurrency === instruction.creditCurrency
      && compareDecimals(instruction.debitAmount, instruction.creditAmount) !== 0
    ) {
      throw new ValidationError("same-currency settlement must preserve principal");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(instruction.valueDate)) {
      throw new ValidationError("settlement value date must use YYYY-MM-DD");
    }
    const valueDate = new Date(`${instruction.valueDate}T00:00:00.000Z`);
    if (!Number.isFinite(valueDate.getTime()) || valueDate.toISOString().slice(0, 10) !== instruction.valueDate) {
      throw new ValidationError("settlement value date is invalid");
    }
    if (!/^[A-Z]{2}$/u.test(instruction.beneficiaryCountry)) {
      throw new ValidationError("beneficiary country must be a normalized two-letter code");
    }
    if (!Number.isFinite(instruction.createdAt.getTime())) {
      throw new ValidationError("instruction creation time is invalid");
    }
    const oldestSupportedDate = new Date("2000-01-01T00:00:00.000Z");
    if (instruction.createdAt < oldestSupportedDate) {
      throw new ValidationError("instruction creation time predates platform support");
    }
  }

}
