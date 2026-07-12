import type {
  IdempotencyKey,
  InstructionId,
  Receipt,
  SettlementInstruction,
} from "./settlement-types.js";

export interface ProcessorResult {
  readonly ledgerReference: string;
  readonly processedAt: Date;
}

export interface SettlementProcessor {
  process(instruction: SettlementInstruction, attempt: number): Promise<ProcessorResult>;
}

export interface ReceiptRepository {
  find(key: IdempotencyKey, instructionId: InstructionId): Promise<Receipt | undefined>;
  save(receipt: Receipt): Promise<void>;
  list(key: IdempotencyKey): Promise<readonly Receipt[]>;
}

export interface SettlementFailureClassifier {
  classify(error: unknown): { readonly code: string; readonly retryable: boolean; readonly message: string };
}
