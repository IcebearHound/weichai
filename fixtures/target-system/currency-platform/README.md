# Currency Platform Synthetic Target

This repository is a fully synthetic TypeScript benchmark target for a currency quotation, settlement,
trade-event, and audit platform. It is intentionally self-contained and does not contain copied open-source code.

## Architecture

- `src/domain` contains monetary primitives, business policies, executable planners, and port contracts.
- `src/application` contains the five application targets whose signatures are immutable.
- `src/infrastructure` contains deterministic provider, settlement, trade-state, and audit adapters.
- `src/services` contains transport-facing controllers, workers, factories, and health reporting.
- `test/unit` verifies completed support logic and must remain green.
- `test/acceptance` describes required behavior for the five intentionally incomplete targets.

The intentionally incomplete methods are:

1. `RateQuoteService.getQuote`
2. `SettlementService.settleBatch`
3. `ProviderRouter.fetchQuote`
4. `TradeEventConsumer.consume`
5. `AuditLogBuffer.flush`

Each method keeps its complete public signature and call chain but throws `NotImplementedError`. No other source
location throws that error. Implementations must preserve the existing interfaces and must not weaken or replace
the acceptance tests.

## Commands

```text
npm install
npm run build
npm test
npm run lint
npm run verify
npm run test:acceptance
```

`npm run build`, `npm test`, `npm run lint`, and `npm run verify` are expected to succeed in the initial fixture.
`npm run test:acceptance` is expected to fail until all five target methods are implemented. Acceptance failures
are therefore part of the benchmark fixture, while unit-test failures are not.

The `verify` command counts concrete classes and implemented function/method declarations with the TypeScript AST;
constructors, interface signatures, and anonymous callbacks are not reported as benchmark symbols. It also counts
nonblank, non-comment source lines, checks the five stub sites, checks acceptance categories, and screens for
mechanically repeated seven-line windows.

## Immutable behavior contracts

- Quote requests retain the `QuoteRequest -> Promise<Quote>` interface, use a five-second fresh TTL, coalesce one
  pair's concurrent requests, enforce provider timeouts, and may fall back to eligible stale data.
- Settlement batches use one idempotency key, retry only retryable item failures, produce at most one receipt per
  instruction, and return outcomes in input order.
- Provider routing isolates circuit state per provider, fails over in priority order, and permits bounded half-open
  recovery probes.
- Trade delivery deduplicates events, serializes work within one account, permits different accounts to overlap,
  and never acknowledges a failed handler invocation.
- Audit buffering writes bounded batches on time or size triggers, serializes concurrent flush callers, retains data
  after failed writes, and drains outstanding records before shutdown completes.

The fixture uses only the TypeScript compiler and Node.js built-in test runner, so no external runtime service is
required for build or unit-test execution.
