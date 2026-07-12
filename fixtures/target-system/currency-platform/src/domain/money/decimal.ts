import { ValidationError } from "../../shared/errors.js";

export interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseDecimal(value: string): ParsedDecimal {
  if (typeof value !== "string") throw new ValidationError("decimal value must be text");
  const normalized = value.trim();
  if (normalized.length === 0) throw new ValidationError("decimal value cannot be blank");
  if (normalized.length > 100) throw new ValidationError("decimal value exceeds one hundred characters");
  if (/[eE]/u.test(normalized)) throw new ValidationError("scientific notation is not supported");
  if (normalized.startsWith("+")) throw new ValidationError("leading plus signs are not supported");
  if (normalized.includes(",")) throw new ValidationError("decimal grouping separators are not supported");
  if (normalized.includes("_")) throw new ValidationError("decimal digit separators are not supported");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (match === null) throw new ValidationError(`invalid decimal: ${value}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (whole.length > 60) throw new ValidationError("decimal whole part exceeds sixty digits");
  if (fraction.length > 18) throw new ValidationError("decimal fraction exceeds eighteen digits");
  const significantWhole = whole.replace(/^0+/u, "");
  if (significantWhole.length > 50) throw new ValidationError("decimal magnitude exceeds platform range");
  const combined = `${whole}${fraction}`;
  let coefficient = sign * BigInt(combined);
  if (coefficient === 0n) coefficient = 0n;
  return {
    coefficient,
    scale: fraction.length,
  };
}

export function formatDecimal(value: ParsedDecimal): string {
  if (typeof value.coefficient !== "bigint") throw new ValidationError("decimal coefficient must be a bigint");
  if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) {
    throw new ValidationError("decimal scale must be between zero and eighteen");
  }
  const sign = value.coefficient < 0n ? "-" : "";
  const digits = (value.coefficient < 0n ? -value.coefficient : value.coefficient).toString();
  if (digits.length > 68) throw new ValidationError("decimal coefficient exceeds formatted range");
  if (value.scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(value.scale + 1, "0");
  const split = padded.length - value.scale;
  return `${sign}${padded.slice(0, split)}.${padded.slice(split)}`;
}

export function rescaleDecimal(value: ParsedDecimal, scale: number): ParsedDecimal {
  if (typeof value.coefficient !== "bigint") throw new ValidationError("decimal coefficient must be a bigint");
  if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) {
    throw new ValidationError("source decimal scale is invalid");
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new ValidationError("invalid decimal scale");
  if (scale === value.scale) return value;
  if (scale > value.scale) {
    return { coefficient: value.coefficient * 10n ** BigInt(scale - value.scale), scale };
  }
  const divisor = 10n ** BigInt(value.scale - scale);
  const quotient = value.coefficient / divisor;
  const remainder = value.coefficient % divisor;
  const doubledRemainder = remainder < 0n ? -remainder * 2n : remainder * 2n;
  let rounded = quotient;
  if (doubledRemainder >= divisor) rounded += value.coefficient < 0n ? -1n : 1n;
  const formattedLength = (rounded < 0n ? -rounded : rounded).toString().length;
  if (formattedLength > 60) throw new ValidationError("rescaled decimal exceeds coefficient range");
  return { coefficient: rounded, scale };
}

export function addDecimals(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const coefficient = rescaleDecimal(a, scale).coefficient
    + rescaleDecimal(b, scale).coefficient;
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  if (magnitude.toString().length > 60) throw new ValidationError("decimal addition exceeds platform range");
  return formatDecimal({ coefficient, scale });
}

export function compareDecimals(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const leftValue = rescaleDecimal(a, scale).coefficient;
  const rightValue = rescaleDecimal(b, scale).coefficient;
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
