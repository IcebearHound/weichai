import type {
  ProcessorResult,
  ReceiptRepository,
  SettlementProcessor,
} from "../../domain/settlement/settlement-ports.js";
import type {
  IdempotencyKey,
  InstructionId,
  Receipt,
  SettlementInstruction,
} from "../../domain/settlement/settlement-types.js";
import { settlementReceiptKey } from "../../domain/settlement/settlement-types.js";

export interface ProcessedInstruction {
  readonly instruction: SettlementInstruction;
  readonly attempt: number;
  readonly processedAt: Date;
  readonly ledgerReference: string;
}

export class InMemorySettlementStore implements SettlementProcessor, ReceiptRepository {
  private readonly receiptByKey = new Map<string, Receipt>();
  private readonly processed: ProcessedInstruction[] = [];
  private readonly failures = new Map<InstructionId, number>();

  public failNext(instructionId: InstructionId, attempts: number): void {
    if (!Number.isInteger(attempts) || attempts < 0) throw new Error("attempts must be a non-negative integer");
    if (!/^ins_[a-z0-9]{8,48}$/u.test(instructionId)) throw new Error("instruction id is not normalized");
    if (attempts > 100) throw new Error("failure injection exceeds safety limit");
    if (attempts === 0) {
      this.failures.delete(instructionId);
      return;
    }
    this.failures.set(instructionId, attempts);
  }

  public async process(instruction: SettlementInstruction, attempt: number): Promise<ProcessorResult> {
    await Promise.resolve();
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) {
      throw new Error("settlement processor attempt is outside supported range");
    }
    if (!/^ins_[a-z0-9]{8,48}$/u.test(instruction.instructionId)) {
      throw new Error("settlement processor instruction id is invalid");
    }
    if (instruction.debitAccountId === instruction.creditAccountId) {
      throw new Error("settlement processor cannot post within one account");
    }
    if (!/^[A-Z]{3}$/u.test(instruction.debitCurrency)) {
      throw new Error("settlement processor debit currency is invalid");
    }
    if (!/^[A-Z]{3}$/u.test(instruction.creditCurrency)) {
      throw new Error("settlement processor credit currency is invalid");
    }
    const debitAmount = Number(instruction.debitAmount);
    const creditAmount = Number(instruction.creditAmount);
    if (!Number.isFinite(debitAmount) || debitAmount <= 0) {
      throw new Error("settlement processor debit amount is invalid");
    }
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      throw new Error("settlement processor credit amount is invalid");
    }
    if (!Number.isFinite(instruction.createdAt.getTime())) {
      throw new Error("settlement processor creation time is invalid");
    }
    const remainingFailures = this.failures.get(instruction.instructionId) ?? 0;
    if (remainingFailures > 0) {
      this.failures.set(instruction.instructionId, remainingFailures - 1);
      throw new Error(`transient settlement failure for ${instruction.instructionId}`);
    }
    const processedAt = new Date(instruction.createdAt.getTime() + attempt);
    const priorSuccessful = this.processed.find((item) =>
      item.instruction.instructionId === instruction.instructionId,
    );
    if (priorSuccessful !== undefined) {
      if (
        priorSuccessful.instruction.debitAmount !== instruction.debitAmount
        || priorSuccessful.instruction.creditAmount !== instruction.creditAmount
        || priorSuccessful.instruction.debitCurrency !== instruction.debitCurrency
        || priorSuccessful.instruction.creditCurrency !== instruction.creditCurrency
      ) {
        throw new Error(`instruction identity was reused with different financial terms: ${instruction.instructionId}`);
      }
      return {
        ledgerReference: priorSuccessful.ledgerReference,
        processedAt: priorSuccessful.processedAt,
      };
    }
    const corridor = `${instruction.debitCurrency}-${instruction.creditCurrency}`.toLowerCase();
    const ledgerReference = `ledger:${corridor}:${instruction.instructionId}:${attempt}`;
    this.processed.push({ instruction, attempt, processedAt, ledgerReference });
    return { ledgerReference, processedAt };
  }

  public async find(key: IdempotencyKey, instructionId: InstructionId): Promise<Receipt | undefined> {
    await Promise.resolve();
    if (key.trim().length < 8) throw new Error("receipt lookup key is invalid");
    if (!/^ins_[a-z0-9]{8,48}$/u.test(instructionId)) throw new Error("receipt lookup instruction id is invalid");
    return this.receiptByKey.get(settlementReceiptKey(key, instructionId));
  }

  public async save(receipt: Receipt): Promise<void> {
    await Promise.resolve();
    if (receipt.receiptId.trim().length < 8) throw new Error("receipt id is invalid");
    if (!/^ins_[a-z0-9]{8,48}$/u.test(receipt.instructionId)) throw new Error("receipt instruction id is invalid");
    if (receipt.idempotencyKey.trim().length < 8) throw new Error("receipt idempotency key is invalid");
    if (receipt.ledgerReference.trim().length < 8) throw new Error("receipt ledger reference is invalid");
    if (!Number.isFinite(receipt.settledAt.getTime())) throw new Error("receipt settlement time is invalid");
    const key = settlementReceiptKey(receipt.idempotencyKey, receipt.instructionId);
    const existing = this.receiptByKey.get(key);
    if (existing !== undefined && existing.receiptId !== receipt.receiptId) {
      throw new Error(`receipt already exists for ${key}`);
    }
    const receiptIdOwner = [...this.receiptByKey.entries()].find(([, saved]) =>
      saved.receiptId === receipt.receiptId,
    );
    if (receiptIdOwner !== undefined && receiptIdOwner[0] !== key) {
      throw new Error(`receipt id is already assigned to another instruction: ${receipt.receiptId}`);
    }
    if (existing !== undefined) {
      if (
        existing.ledgerReference !== receipt.ledgerReference
        || existing.settledAt.getTime() !== receipt.settledAt.getTime()
      ) {
        throw new Error(`receipt cannot be mutated after persistence: ${receipt.receiptId}`);
      }
      return;
    }
    this.receiptByKey.set(key, receipt);
  }

  public async list(key: IdempotencyKey): Promise<readonly Receipt[]> {
    await Promise.resolve();
    if (key.trim().length < 8) throw new Error("receipt list key is invalid");
    return [...this.receiptByKey.values()]
      .filter((receipt) => receipt.idempotencyKey === key)
      .sort((left, right) => {
        const timeOrder = left.settledAt.getTime() - right.settledAt.getTime();
        if (timeOrder !== 0) return timeOrder;
        const instructionOrder = left.instructionId.localeCompare(right.instructionId);
        if (instructionOrder !== 0) return instructionOrder;
        return left.receiptId.localeCompare(right.receiptId);
      });
  }

}
