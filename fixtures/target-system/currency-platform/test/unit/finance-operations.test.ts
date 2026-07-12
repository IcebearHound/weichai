import assert from "node:assert/strict";
import test from "node:test";
import { compileFeePricing } from "../../src/domain/money/fee-pricing-compiler.js";
import { compileRetentionPlan } from "../../src/domain/operations/retention-plan-compiler.js";
import { reconcileLedgerLines } from "../../src/domain/reconciliation/reconciliation-engine.js";

test("fee pricing combines fixed, variable, and provider costs", () => {
  const result = compileFeePricing({
    transactionId: "transaction-1",
    amount: "100.00",
    sourceCurrency: "USD",
    destinationCurrency: "EUR",
    customerSegment: "standard",
    providerCost: "0.50",
    bands: [{
      bandId: "band-1",
      fromAmount: "0",
      fixedFee: "1.00",
      variableBps: 100,
    }],
    discounts: [],
    taxBps: 0,
    minorUnits: 2,
    roundingMode: "nearest",
    pricedAt: new Date("2026-07-12T08:00:00.000Z"),
  });
  assert.equal(result.grossFee, "2.50");
  assert.equal(result.totalFee, "2.50");
  assert.equal(result.netAmount, "97.50");
});

test("retention planning deletes an expired mutable record", () => {
  const result = compileRetentionPlan({
    records: [{
      recordId: "record-1",
      category: "transient-log",
      jurisdiction: "US",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      containsPersonalData: false,
      immutable: false,
      legalHoldIds: [],
      byteCount: 100,
      storageTier: "hot",
    }],
    rules: [{
      ruleId: "rule-1",
      category: "transient-log",
      jurisdiction: "US",
      retainDays: 30,
      deleteAllowed: true,
      immutable: false,
      priority: 1,
    }],
    evaluatedAt: new Date("2026-07-12T00:00:00.000Z"),
    capacity: {
      archiveTier: "archive",
      maximumArchiveBytes: 1_000,
      maximumDeleteRecords: 10,
      maximumAnonymizeRecords: 10,
      minimumLastAccessDays: 0,
      legalHoldIds: [],
      dryRun: false,
      requireRuleForDeletion: true,
      allowImmutableArchive: true,
    },
    previouslyProcessedRecordIds: [],
    protectedStorageTiers: [],
  });
  assert.equal(result.items[0]?.action, "delete");
  assert.equal(result.deletedCount, 1);
});

test("reconciliation matches equal reference, amount, and date", () => {
  const result = reconcileLedgerLines({
    external: [{
      lineId: "external-1",
      externalReference: "ledger-1",
      accountCode: "101000",
      currency: "USD",
      amount: "100.00",
      valueDate: "2026-07-11",
      description: "customer settlement ledger-1",
    }],
    internal: [{
      postingId: "posting-1",
      ledgerReference: "ledger-1",
      accountCode: "101000",
      currency: "USD",
      amount: "100.00",
      valueDate: "2026-07-11",
      settledAt: new Date("2026-07-11T10:00:00.000Z"),
    }],
    policy: {
      amountTolerance: "0.01",
      maximumDateDifferenceDays: 1,
      exactReferenceScore: 100,
      ledgerReferenceScore: 50,
      amountScore: 40,
      dateScore: 20,
      accountScore: 20,
      descriptionScore: 10,
      counterpartyScore: 10,
      minimumMatchScore: 50,
      ambiguousScoreDistance: 5,
      allowManyToOne: true,
      maximumCombinationSize: 3,
      caseInsensitiveReferences: true,
      ignoreReferencePunctuation: false,
    },
    evaluatedAt: new Date("2026-07-12T00:00:00.000Z"),
    expectedCurrencies: ["USD"],
    restrictedAccountCodes: [],
  });
  assert.equal(result.matches[0]?.outcome, "exact");
  assert.deepEqual(result.unmatchedExternalLineIds, []);
  assert.equal(result.netDifference, "0.00");
});
