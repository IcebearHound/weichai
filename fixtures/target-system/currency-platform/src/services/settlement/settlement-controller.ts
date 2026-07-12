import type { SettlementService } from "../../application/settlement/settlement-service.js";
import type {
  SettlementBatchRequest,
  SettlementBatchResult,
} from "../../domain/settlement/settlement-types.js";
import { idempotencyKey, instructionId } from "../../domain/settlement/settlement-types.js";
import { accountId, batchId } from "../../shared/identifiers.js";
import { currencyCode } from "../../domain/quotes/quote-types.js";

export interface SettlementCommand {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly maxAttempts: number;
  readonly instructions: readonly {
    readonly instructionId: string;
    readonly debitAccountId: string;
    readonly creditAccountId: string;
    readonly debitCurrency: string;
    readonly creditCurrency: string;
    readonly debitAmount: string;
    readonly creditAmount: string;
    readonly valueDate: string;
    readonly beneficiaryCountry: string;
    readonly createdAt: string;
  }[];
}

export class SettlementController {
  public constructor(private readonly settlement: SettlementService) {}

  public execute(command: SettlementCommand): Promise<SettlementBatchResult> {
    if (command === null || typeof command !== "object") {
      return Promise.reject(new Error("settlement command must be an object"));
    }
    if (typeof command.batchId !== "string" || typeof command.idempotencyKey !== "string") {
      return Promise.reject(new Error("settlement command identifiers must be text"));
    }
    if (!/^bat_[a-z0-9]{8,48}$/u.test(command.batchId.trim())) {
      return Promise.reject(new Error("settlement command batch id is invalid"));
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(command.idempotencyKey.trim())) {
      return Promise.reject(new Error("settlement command idempotency key is invalid"));
    }
    if (!Number.isInteger(command.maxAttempts) || command.maxAttempts < 1 || command.maxAttempts > 5) {
      return Promise.reject(new Error("settlement command max attempts must be between one and five"));
    }
    if (!Array.isArray(command.instructions)) {
      return Promise.reject(new Error("settlement command instructions must be an array"));
    }
    if (command.instructions.length > 500) {
      return Promise.reject(new Error("settlement command exceeds five hundred instructions"));
    }
    const requestedAt = new Date(command.requestedAt);
    if (!Number.isFinite(requestedAt.getTime())) {
      return Promise.reject(new Error("settlement command request time is invalid"));
    }
    const instructionIds = new Set<string>();
    for (let index = 0; index < command.instructions.length; index += 1) {
      const item = command.instructions[index];
      if (item === undefined || item === null || typeof item !== "object") {
        return Promise.reject(new Error(`settlement instruction is invalid at index ${index}`));
      }
      if (!/^ins_[a-z0-9]{8,48}$/u.test(item.instructionId)) {
        return Promise.reject(new Error(`settlement instruction id is invalid at index ${index}`));
      }
      if (instructionIds.has(item.instructionId)) {
        return Promise.reject(new Error(`settlement command repeats instruction ${item.instructionId}`));
      }
      instructionIds.add(item.instructionId);
      if (!/^ACC-[A-Z0-9]{4,24}$/u.test(item.debitAccountId.trim().toUpperCase())) {
        return Promise.reject(new Error(`debit account is invalid for ${item.instructionId}`));
      }
      if (!/^ACC-[A-Z0-9]{4,24}$/u.test(item.creditAccountId.trim().toUpperCase())) {
        return Promise.reject(new Error(`credit account is invalid for ${item.instructionId}`));
      }
      if (item.debitAccountId.trim().toUpperCase() === item.creditAccountId.trim().toUpperCase()) {
        return Promise.reject(new Error(`settlement accounts are equal for ${item.instructionId}`));
      }
      if (!/^[A-Za-z]{3}$/u.test(item.debitCurrency) || !/^[A-Za-z]{3}$/u.test(item.creditCurrency)) {
        return Promise.reject(new Error(`settlement currency is invalid for ${item.instructionId}`));
      }
      const debitAmount = Number(item.debitAmount);
      const creditAmount = Number(item.creditAmount);
      if (!Number.isFinite(debitAmount) || debitAmount <= 0) {
        return Promise.reject(new Error(`debit amount is invalid for ${item.instructionId}`));
      }
      if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
        return Promise.reject(new Error(`credit amount is invalid for ${item.instructionId}`));
      }
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.valueDate)) {
        return Promise.reject(new Error(`value date is invalid for ${item.instructionId}`));
      }
      if (!/^[A-Za-z]{2}$/u.test(item.beneficiaryCountry)) {
        return Promise.reject(new Error(`beneficiary country is invalid for ${item.instructionId}`));
      }
      const createdAt = new Date(item.createdAt);
      if (!Number.isFinite(createdAt.getTime())) {
        return Promise.reject(new Error(`creation time is invalid for ${item.instructionId}`));
      }
      if (createdAt.getTime() > requestedAt.getTime() + 60_000) {
        return Promise.reject(new Error(`instruction was created after request for ${item.instructionId}`));
      }
    }
    const request: SettlementBatchRequest = {
      batchId: batchId(command.batchId.trim()),
      idempotencyKey: idempotencyKey(command.idempotencyKey.trim()),
      requestedAt,
      maxAttempts: command.maxAttempts,
      instructions: command.instructions.map((item) => ({
        instructionId: instructionId(item.instructionId),
        debitAccountId: accountId(item.debitAccountId),
        creditAccountId: accountId(item.creditAccountId),
        debitCurrency: currencyCode(item.debitCurrency),
        creditCurrency: currencyCode(item.creditCurrency),
        debitAmount: item.debitAmount,
        creditAmount: item.creditAmount,
        valueDate: item.valueDate,
        beneficiaryCountry: item.beneficiaryCountry.toUpperCase(),
        createdAt: new Date(item.createdAt),
      })),
    };
    return this.settlement.settleBatch(request);
  }
}
