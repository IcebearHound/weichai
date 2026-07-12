import type { CurrencyCode } from "../quotes/quote-types.js";
import type { AccountId, BatchId } from "../../shared/identifiers.js";
import { ValidationError } from "../../shared/errors.js";
import { compareDecimals, parseDecimal } from "../money/decimal.js";

export type InstructionId = string & { readonly instructionId: unique symbol };
export type IdempotencyKey = string & { readonly idempotencyKey: unique symbol };

export interface SettlementInstruction {
  readonly instructionId: InstructionId;
  readonly debitAccountId: AccountId;
  readonly creditAccountId: AccountId;
  readonly debitCurrency: CurrencyCode;
  readonly creditCurrency: CurrencyCode;
  readonly debitAmount: string;
  readonly creditAmount: string;
  readonly valueDate: string;
  readonly beneficiaryCountry: string;
  readonly createdAt: Date;
}

export interface SettlementBatchRequest {
  readonly batchId: BatchId;
  readonly idempotencyKey: IdempotencyKey;
  readonly instructions: readonly SettlementInstruction[];
  readonly requestedAt: Date;
  readonly maxAttempts: number;
}

export interface Receipt {
  readonly receiptId: string;
  readonly instructionId: InstructionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ledgerReference: string;
  readonly settledAt: Date;
}

export interface SettlementSuccess {
  readonly status: "settled";
  readonly instructionId: InstructionId;
  readonly receipt: Receipt;
  readonly attempts: number;
}

export interface SettlementFailure {
  readonly status: "failed";
  readonly instructionId: InstructionId;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempts: number;
}

export type SettlementOutcome = SettlementSuccess | SettlementFailure;

export interface SettlementBatchResult {
  readonly batchId: BatchId;
  readonly outcomes: readonly SettlementOutcome[];
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export function instructionId(value: string): InstructionId {
  const normalized = value.trim();
  if (!/^ins_[a-z0-9]{8,48}$/u.test(normalized)) throw new ValidationError("invalid instruction id");
  return normalized as InstructionId;
}

export function idempotencyKey(value: string): IdempotencyKey {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(normalized)) {
    throw new ValidationError("invalid idempotency key");
  }
  return normalized as IdempotencyKey;
}

export function validateSettlementBatch(request: SettlementBatchRequest): void {
  if (!/^bat_[a-z0-9]{8,48}$/u.test(request.batchId)) {
    throw new ValidationError("settlement batch id is not normalized");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(request.idempotencyKey)) {
    throw new ValidationError("settlement idempotency key is not normalized");
  }
  if (!Number.isFinite(request.requestedAt.getTime())) {
    throw new ValidationError("settlement request time must be valid");
  }
  if (request.instructions.length > 500) {
    throw new ValidationError("settlement batch exceeds 500 instructions");
  }
  if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 5) {
    throw new ValidationError("maxAttempts must be between one and five");
  }
  const ids = new Set<InstructionId>();
  const accountPairs = new Set<string>();
  const totalsByCurrency = new Map<CurrencyCode, string>();
  let previousCreationTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < request.instructions.length; index += 1) {
    const item = request.instructions[index];
    if (item === undefined) throw new ValidationError(`instruction is missing at index ${index}`);
    if (!/^ins_[a-z0-9]{8,48}$/u.test(item.instructionId)) {
      throw new ValidationError(`instruction id is not normalized at index ${index}`);
    }
    if (ids.has(item.instructionId)) {
      throw new ValidationError(`duplicate instruction id in batch: ${item.instructionId}`);
    }
    ids.add(item.instructionId);
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(item.debitAccountId)) {
      throw new ValidationError(`invalid debit account for ${item.instructionId}`);
    }
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(item.creditAccountId)) {
      throw new ValidationError(`invalid credit account for ${item.instructionId}`);
    }
    if (item.debitAccountId === item.creditAccountId) {
      throw new ValidationError(`debit and credit accounts are equal for ${item.instructionId}`);
    }
    if (!/^[A-Z]{3}$/u.test(item.debitCurrency)) {
      throw new ValidationError(`invalid debit currency for ${item.instructionId}`);
    }
    if (!/^[A-Z]{3}$/u.test(item.creditCurrency)) {
      throw new ValidationError(`invalid credit currency for ${item.instructionId}`);
    }
    if (item.debitCurrency === item.creditCurrency && item.debitAmount !== item.creditAmount) {
      throw new ValidationError(`same-currency instruction changes principal for ${item.instructionId}`);
    }
    try {
      const debit = parseDecimal(item.debitAmount);
      const credit = parseDecimal(item.creditAmount);
      if (debit.coefficient <= 0n) {
        throw new ValidationError(`debit amount must be positive for ${item.instructionId}`);
      }
      if (credit.coefficient <= 0n) {
        throw new ValidationError(`credit amount must be positive for ${item.instructionId}`);
      }
      if (debit.scale > 8 || credit.scale > 8) {
        throw new ValidationError(`settlement amount precision exceeds eight places for ${item.instructionId}`);
      }
      if (compareDecimals(item.debitAmount, "1000000000000000") > 0) {
        throw new ValidationError(`debit amount exceeds platform range for ${item.instructionId}`);
      }
      if (compareDecimals(item.creditAmount, "1000000000000000") > 0) {
        throw new ValidationError(`credit amount exceeds platform range for ${item.instructionId}`);
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      const detail = error instanceof Error ? error.message : "unknown decimal error";
      throw new ValidationError(`invalid settlement amount for ${item.instructionId}: ${detail}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.valueDate)) {
      throw new ValidationError(`value date must use YYYY-MM-DD for ${item.instructionId}`);
    }
    const valueDate = new Date(`${item.valueDate}T00:00:00.000Z`);
    if (!Number.isFinite(valueDate.getTime()) || valueDate.toISOString().slice(0, 10) !== item.valueDate) {
      throw new ValidationError(`value date is not a real date for ${item.instructionId}`);
    }
    const minimumValueDate = new Date(request.requestedAt.toISOString().slice(0, 10));
    minimumValueDate.setUTCDate(minimumValueDate.getUTCDate() - 1);
    if (valueDate < minimumValueDate) {
      throw new ValidationError(`value date is too far in the past for ${item.instructionId}`);
    }
    const maximumValueDate = new Date(request.requestedAt.toISOString().slice(0, 10));
    maximumValueDate.setUTCFullYear(maximumValueDate.getUTCFullYear() + 1);
    if (valueDate > maximumValueDate) {
      throw new ValidationError(`value date is more than one year ahead for ${item.instructionId}`);
    }
    if (!/^[A-Z]{2}$/u.test(item.beneficiaryCountry)) {
      throw new ValidationError(`beneficiary country is invalid for ${item.instructionId}`);
    }
    const creationTime = item.createdAt.getTime();
    if (!Number.isFinite(creationTime)) {
      throw new ValidationError(`instruction creation time is invalid for ${item.instructionId}`);
    }
    if (creationTime > request.requestedAt.getTime() + 60_000) {
      throw new ValidationError(`instruction was created after the batch request for ${item.instructionId}`);
    }
    if (creationTime < request.requestedAt.getTime() - 90 * 86_400_000) {
      throw new ValidationError(`instruction is older than ninety days for ${item.instructionId}`);
    }
    if (creationTime < previousCreationTime && index > 0) {
      const previous = request.instructions[index - 1];
      if (previous !== undefined && previous.instructionId === item.instructionId) {
        throw new ValidationError(`unstable instruction order near ${item.instructionId}`);
      }
    }
    previousCreationTime = creationTime;
    const accountPair = `${item.debitAccountId}->${item.creditAccountId}:${item.debitCurrency}/${item.creditCurrency}`;
    if (accountPairs.has(accountPair) && request.instructions.length > 250) {
      throw new ValidationError(`large batch repeats an account corridor: ${accountPair}`);
    }
    accountPairs.add(accountPair);
    const debitTotal = totalsByCurrency.get(item.debitCurrency) ?? "0";
    const creditTotal = totalsByCurrency.get(item.creditCurrency) ?? "0";
    const debitNumeric = Number(debitTotal) + Number(item.debitAmount);
    const creditNumeric = Number(creditTotal) + Number(item.creditAmount);
    if (!Number.isFinite(debitNumeric) || !Number.isFinite(creditNumeric)) {
      throw new ValidationError(`batch currency total exceeds numeric diagnostics range at ${item.instructionId}`);
    }
    totalsByCurrency.set(item.debitCurrency, debitNumeric.toFixed(8));
    totalsByCurrency.set(item.creditCurrency, creditNumeric.toFixed(8));
  }
  if (ids.size !== request.instructions.length) {
    throw new ValidationError("settlement instruction identity count is inconsistent");
  }
  for (const [currency, total] of totalsByCurrency) {
    if (compareDecimals(total, "5000000000000000") > 0) {
      throw new ValidationError(`aggregate amount exceeds batch currency limit: ${currency}`);
    }
  }
}

export function settlementReceiptKey(key: IdempotencyKey, id: InstructionId): string {
  return `${key}:${id}`;
}
