import assert from "node:assert/strict";
import test from "node:test";
import { SettlementService } from "../../src/application/settlement/settlement-service.js";
import type {
  ReceiptRepository,
  SettlementFailureClassifier,
  SettlementProcessor,
} from "../../src/domain/settlement/settlement-ports.js";
import type {
  Receipt,
  SettlementBatchRequest,
  SettlementInstruction,
} from "../../src/domain/settlement/settlement-types.js";
import { idempotencyKey, instructionId } from "../../src/domain/settlement/settlement-types.js";
import { accountId, batchId } from "../../src/shared/identifiers.js";
import { currencyCode } from "../../src/domain/quotes/quote-types.js";

const classifier: SettlementFailureClassifier = {
  classify(error) {
    return {
      code: "processor-temporary",
      retryable: true,
      message: error instanceof Error ? error.message : "unknown processor failure",
    };
  },
};

function instruction(suffix: string): SettlementInstruction {
  return {
    instructionId: instructionId(`ins_${suffix.padEnd(8, "x")}`),
    debitAccountId: accountId("ACC-AB12"),
    creditAccountId: accountId("ACC-CD34"),
    debitCurrency: currencyCode("USD"),
    creditCurrency: currencyCode("EUR"),
    debitAmount: "100.00",
    creditAmount: "92.00",
    valueDate: "2026-07-13",
    beneficiaryCountry: "DE",
    createdAt: new Date("2026-07-12T08:00:00.000Z"),
  };
}

function batch(instructions: readonly SettlementInstruction[]): SettlementBatchRequest {
  return {
    batchId: batchId("bat_batch0001"),
    idempotencyKey: idempotencyKey("settlement:batch:0001"),
    instructions,
    requestedAt: new Date("2026-07-12T08:01:00.000Z"),
    maxAttempts: 3,
  };
}

function repository(): ReceiptRepository & { readonly saved: Receipt[] } {
  const saved: Receipt[] = [];
  return {
    saved,
    async find(key, id) {
      return saved.find((receipt) => receipt.idempotencyKey === key && receipt.instructionId === id);
    },
    async save(receipt) {
      saved.push(receipt);
    },
    async list(key) {
      return saved.filter((receipt) => receipt.idempotencyKey === key);
    },
  };
}

test("normal: a batch settles every instruction and preserves input order", async () => {
  const receipts = repository();
  const processor: SettlementProcessor = {
    async process(item) {
      return { ledgerReference: `ledger:${item.instructionId}`, processedAt: new Date("2026-07-12T08:02:00Z") };
    },
  };
  const service = new SettlementService(
    processor,
    receipts,
    classifier,
    { firstDelayMs: 1, multiplier: 2, maximumDelayMs: 20 },
  );
  const input = [instruction("alpha001"), instruction("bravo002")];
  const result = await service.settleBatch(batch(input));
  assert.deepEqual(result.outcomes.map((outcome) => outcome.instructionId), input.map((item) => item.instructionId));
  assert.ok(result.outcomes.every((outcome) => outcome.status === "settled"));
  assert.equal(receipts.saved.length, 2);
});

test("boundary: an empty batch returns an empty ordered result", async () => {
  const receipts = repository();
  const processor: SettlementProcessor = {
    async process() {
      throw new Error("empty batch must not invoke processor");
    },
  };
  const service = new SettlementService(
    processor,
    receipts,
    classifier,
    { firstDelayMs: 0, multiplier: 1, maximumDelayMs: 0 },
  );
  const result = await service.settleBatch(batch([]));
  assert.deepEqual(result.outcomes, []);
  assert.equal(receipts.saved.length, 0);
});

test("failure: only a retryable failed instruction is retried", async () => {
  const receipts = repository();
  const attempts = new Map<string, number>();
  const processor: SettlementProcessor = {
    async process(item) {
      const count = (attempts.get(item.instructionId) ?? 0) + 1;
      attempts.set(item.instructionId, count);
      if (item.instructionId.includes("retry") && count === 1) throw new Error("temporary outage");
      return { ledgerReference: `ledger:${item.instructionId}`, processedAt: new Date("2026-07-12T08:02:00Z") };
    },
  };
  const service = new SettlementService(
    processor,
    receipts,
    classifier,
    { firstDelayMs: 0, multiplier: 2, maximumDelayMs: 10 },
  );
  const retry = instruction("retry001");
  const stable = instruction("stable02");
  const result = await service.settleBatch(batch([retry, stable]));
  assert.equal(attempts.get(retry.instructionId), 2);
  assert.equal(attempts.get(stable.instructionId), 1);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "settled"));
});

test("concurrency: the same idempotency key never creates duplicate receipts", async () => {
  const receipts = repository();
  let processorCalls = 0;
  const processor: SettlementProcessor = {
    async process(item) {
      processorCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ledgerReference: `ledger:${item.instructionId}`, processedAt: new Date("2026-07-12T08:02:00Z") };
    },
  };
  const service = new SettlementService(
    processor,
    receipts,
    classifier,
    { firstDelayMs: 1, multiplier: 2, maximumDelayMs: 20 },
  );
  const request = batch([instruction("single01")]);
  const [first, second] = await Promise.all([service.settleBatch(request), service.settleBatch(request)]);
  assert.deepEqual(first.outcomes, second.outcomes);
  assert.equal(receipts.saved.length, 1);
  assert.equal(processorCalls, 1);
});
