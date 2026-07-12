# Quote Fanout Go

Quote Fanout is a dependency-free synthetic Go library for a multi-venue currency
pricing gateway. It models the work around a quote request instead of relying on a
web framework: provider inventory, short-lived snapshots, health-aware routing,
multi-source price aggregation, account-ordered event handling, durable journal
batching, exposure netting, market sessions, and settlement-date selection.

The implementation is split across cohesive files in `fanout/`. Each subsystem has
its own input types and invariants. The two concurrency-heavy components use
different ownership models: quote snapshots coordinate per-pair in-flight loads,
while journal persistence is owned by one event loop. Account event lanes serialize
one account without blocking unrelated accounts.

Requirements:

- Go 1.22 or newer
- No third-party modules or generated source
- MIT license

Verification:

```text
go build ./...
go test ./...
go test -race ./...
go vet ./...
gofmt -w fanout/*.go
```

Tests exercise successful, invalid, timeout, stale-data, partial-outage, shutdown,
deduplication, ordering, and concurrent-call paths. This repository and its test
fixtures were authored as synthetic data; they do not contain copied open-source
implementation code.
