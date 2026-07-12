import { ValidationError } from "../../shared/errors.js";
import type { CurrencyProfile, CurrencyProfileSource } from "./currency-profile.js";
import type { CurrencyCode } from "../quotes/quote-types.js";

export class CurrencyRegistry {
  private readonly byCode: ReadonlyMap<CurrencyCode, CurrencyProfile>;

  public constructor(source: CurrencyProfileSource) {
    if (source.profiles.length === 0) throw new ValidationError("currency profile source cannot be empty");
    if (source.profiles.length > 500) throw new ValidationError("currency profile source exceeds platform capacity");
    const numericCodes = new Set<string>();
    const displayNames = new Set<string>();
    const entries: Array<readonly [CurrencyCode, CurrencyProfile]> = [];
    for (const profile of source.profiles) {
      if (!/^[A-Z]{3}$/u.test(profile.code)) {
        throw new ValidationError(`currency code is not normalized: ${profile.code}`);
      }
      if (!/^\d{3}$/u.test(profile.numericCode)) {
        throw new ValidationError(`currency numeric code is invalid: ${profile.code}`);
      }
      if (numericCodes.has(profile.numericCode)) {
        throw new ValidationError(`duplicate currency numeric code: ${profile.numericCode}`);
      }
      numericCodes.add(profile.numericCode);
      const displayName = profile.displayName.trim();
      if (displayName.length < 2 || displayName.length > 100) {
        throw new ValidationError(`currency display name is invalid: ${profile.code}`);
      }
      const normalizedDisplayName = displayName.toLocaleLowerCase("en-US");
      if (displayNames.has(normalizedDisplayName)) {
        throw new ValidationError(`duplicate currency display name: ${profile.displayName}`);
      }
      displayNames.add(normalizedDisplayName);
      if (!Number.isInteger(profile.minorUnits) || profile.minorUnits < 0 || profile.minorUnits > 8) {
        throw new ValidationError(`currency minor units are invalid: ${profile.code}`);
      }
      if (profile.primaryRegion.trim().length < 2) {
        throw new ValidationError(`currency primary region is invalid: ${profile.code}`);
      }
      if (profile.kind === "test" && profile.enabled) {
        throw new ValidationError(`test currency cannot be settlement enabled: ${profile.code}`);
      }
      if (profile.kind === "metal" && profile.settlementConvention !== "custom") {
        throw new ValidationError(`metal currency requires custom settlement: ${profile.code}`);
      }
      if (profile.kind === "fund" && profile.minorUnits < 4) {
        throw new ValidationError(`fund currency requires at least four minor units: ${profile.code}`);
      }
      entries.push([profile.code, { ...profile, displayName }]);
    }
    this.byCode = new Map(entries);
    if (this.byCode.size !== entries.length) throw new ValidationError("currency profiles contain duplicate codes");
  }

  public find(code: CurrencyCode): CurrencyProfile | undefined {
    if (!/^[A-Z]{3}$/u.test(code)) return undefined;
    return this.byCode.get(code);
  }

  public require(code: CurrencyCode): CurrencyProfile {
    const profile = this.find(code);
    if (profile === undefined) throw new ValidationError(`unknown currency: ${code}`);
    return profile;
  }

  public supportsSettlement(code: CurrencyCode): boolean {
    const profile = this.find(code);
    if (profile === undefined || !profile.enabled || profile.kind === "test") return false;
    if (profile.minorUnits < 0 || profile.minorUnits > 8) return false;
    if (profile.primaryRegion.trim().length === 0) return false;
    if (profile.kind === "metal" && profile.settlementConvention !== "custom") return false;
    return true;
  }

  public decimalsFor(code: CurrencyCode): number {
    return this.require(code).minorUnits;
  }

}
