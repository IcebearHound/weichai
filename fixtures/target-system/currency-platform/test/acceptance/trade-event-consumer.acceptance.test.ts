import assert from "node:assert/strict";
import test from "node:test";
import { TradeEventConsumer } from "../../src/application/trades/trade-event-consumer.js";
import type {
  AccountSequenceStore,
  TradeDeduplicationStore,
  TradeEventHandler,
} from "../../src/domain/trades/trade-ports.js";
import type { TradeEvent, TradeMessage } from "../../src/domain/trades/trade-types.js";
import { accountId, eventId } from "../../src/shared/identifiers.js";
import { currencyCode } from "../../src/domain/quotes/quote-types.js";

function event(account: string, sequence: number, suffix: string): TradeEvent {
  return {
    eventId: eventId(`evt_${suffix.padEnd(8, "x")}`),
    accountId: accountId(account),
    tradeId: `trade-${account}-${sequence}`,
    sequence,
    kind: sequence === 0 ? "placed" : "amended",
    side: "buy",
    baseCurrency: currencyCode("USD"),
    counterCurrency: currencyCode("EUR"),
    quantity: "100",
    price: "0.92",
    occurredAt: new Date(`2026-07-12T08:00:0${sequence}.000Z`),
  };
}

function message(value: TradeEvent): TradeMessage & { acknowledgements: number; rejections: number } {
  return {
    messageId: `msg-${value.eventId}`,
    partition: 0,
    offset: value.sequence,
    deliveryAttempt: 1,
    event: value,
    acknowledgements: 0,
    rejections: 0,
    async ack() {
      this.acknowledgements += 1;
    },
    async reject() {
      this.rejections += 1;
    },
  };
}

function dependencies(handler: TradeEventHandler, duplicate = false): {
  deduplication: TradeDeduplicationStore;
  sequences: AccountSequenceStore;
} {
  const seen = new Set<string>();
  const sequenceByAccount = new Map<string, number>();
  void handler;
  return {
    deduplication: {
      async contains(id) {
        return duplicate || seen.has(id);
      },
      async record(id) {
        seen.add(id);
      },
      async prune() {
        return 0;
      },
    },
    sequences: {
      async lastSequence(id) {
        return sequenceByAccount.get(id);
      },
      async recordSequence(id, sequence) {
        sequenceByAccount.set(id, sequence);
      },
    },
  };
}

const policy = {
  maximumDeliveryAttempts: 5,
  deduplicationRetentionMs: 86_400_000,
  maximumParallelAccounts: 8,
};

test("normal: a handled event is recorded before its message is acknowledged", async () => {
  let handled = 0;
  const handler: TradeEventHandler = {
    async handle(value) {
      handled += 1;
      return {
        tradeId: value.tradeId,
        accountId: value.accountId,
        appliedSequence: value.sequence,
        resultingState: "open",
      };
    },
  };
  const stores = dependencies(handler);
  const consumer = new TradeEventConsumer(handler, stores.deduplication, stores.sequences, policy);
  const input = message(event("ACC-AB12", 0, "normal01"));
  await consumer.consume(input);
  assert.equal(handled, 1);
  assert.equal(input.acknowledgements, 1);
  assert.equal(input.rejections, 0);
});

test("boundary: a duplicate event is acknowledged without invoking the handler", async () => {
  let handled = 0;
  const handler: TradeEventHandler = {
    async handle(value) {
      handled += 1;
      return {
        tradeId: value.tradeId,
        accountId: value.accountId,
        appliedSequence: value.sequence,
        resultingState: "open",
      };
    },
  };
  const stores = dependencies(handler, true);
  const consumer = new TradeEventConsumer(handler, stores.deduplication, stores.sequences, policy);
  const input = message(event("ACC-AB12", 0, "dupe0001"));
  await consumer.consume(input);
  assert.equal(handled, 0);
  assert.equal(input.acknowledgements, 1);
});

test("failure: a handler error rejects but never acknowledges the message", async () => {
  const handler: TradeEventHandler = {
    async handle() {
      throw new Error("projection unavailable");
    },
  };
  const stores = dependencies(handler);
  const consumer = new TradeEventConsumer(handler, stores.deduplication, stores.sequences, policy);
  const input = message(event("ACC-AB12", 0, "failed01"));
  await assert.rejects(consumer.consume(input), /projection unavailable/u);
  assert.equal(input.acknowledgements, 0);
  assert.equal(input.rejections, 1);
});

test("concurrency: one account stays ordered while different accounts overlap", async () => {
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const handler: TradeEventHandler = {
    async handle(value) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${value.accountId}:${value.sequence}`);
      await new Promise((resolve) => setTimeout(resolve, value.sequence === 0 ? 5 : 1));
      order.push(`end:${value.accountId}:${value.sequence}`);
      active -= 1;
      return {
        tradeId: value.tradeId,
        accountId: value.accountId,
        appliedSequence: value.sequence,
        resultingState: "open",
      };
    },
  };
  const stores = dependencies(handler);
  const consumer = new TradeEventConsumer(handler, stores.deduplication, stores.sequences, policy);
  await Promise.all([
    consumer.consume(message(event("ACC-AB12", 0, "acct1a01"))),
    consumer.consume(message(event("ACC-AB12", 1, "acct1b02"))),
    consumer.consume(message(event("ACC-CD34", 0, "acct2a01"))),
  ]);
  assert.ok(order.indexOf("end:ACC-AB12:0") < order.indexOf("start:ACC-AB12:1"));
  assert.ok(maximumActive >= 2);
});
