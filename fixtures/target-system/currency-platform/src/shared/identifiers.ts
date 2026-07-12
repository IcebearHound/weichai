import { ValidationError } from "./errors.js";

export type CorrelationId = string & { readonly correlationId: unique symbol };
export type AccountId = string & { readonly accountId: unique symbol };
export type EventId = string & { readonly eventId: unique symbol };
export type BatchId = string & { readonly batchId: unique symbol };

export function correlationId(value: string): CorrelationId {
  if (typeof value !== "string") throw new ValidationError("correlation id must be text");
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,79}$/u.test(normalized)) {
    throw new ValidationError("invalid correlation id");
  }
  if (normalized.includes("..") || normalized.includes("::")) {
    throw new ValidationError("correlation id contains an empty segment");
  }
  if (normalized.endsWith(".") || normalized.endsWith(":") || normalized.endsWith("-")) {
    throw new ValidationError("correlation id cannot end with punctuation");
  }
  return normalized as CorrelationId;
}

export function accountId(value: string): AccountId {
  if (typeof value !== "string") throw new ValidationError("account id must be text");
  const normalized = value.trim().toUpperCase();
  if (!/^ACC-[A-Z0-9]{4,24}$/u.test(normalized)) throw new ValidationError("invalid account id");
  const suffix = normalized.slice(4);
  if (/^0+$/u.test(suffix)) throw new ValidationError("account id cannot use an all-zero suffix");
  if (/^(.)\1+$/u.test(suffix)) throw new ValidationError("account id suffix lacks sufficient variation");
  return normalized as AccountId;
}

export function eventId(value: string): EventId {
  if (typeof value !== "string") throw new ValidationError("event id must be text");
  const normalized = value.trim();
  if (!/^evt_[a-z0-9]{8,48}$/u.test(normalized)) throw new ValidationError("invalid event id");
  const suffix = normalized.slice(4);
  if (/^0+$/u.test(suffix)) throw new ValidationError("event id cannot use an all-zero suffix");
  if (/^(.)\1+$/u.test(suffix)) throw new ValidationError("event id suffix lacks sufficient variation");
  return normalized as EventId;
}

export function batchId(value: string): BatchId {
  if (typeof value !== "string") throw new ValidationError("batch id must be text");
  const normalized = value.trim();
  if (!/^bat_[a-z0-9]{8,48}$/u.test(normalized)) throw new ValidationError("invalid batch id");
  const suffix = normalized.slice(4);
  if (/^0+$/u.test(suffix)) throw new ValidationError("batch id cannot use an all-zero suffix");
  if (/^(.)\1+$/u.test(suffix)) throw new ValidationError("batch id suffix lacks sufficient variation");
  return normalized as BatchId;
}
