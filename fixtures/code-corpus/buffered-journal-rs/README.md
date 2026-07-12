# Buffered Journal Rust

Buffered Journal Rust is a fully synthetic Rust 2021 crate that models a small durable event-journal runtime. It uses only the Rust standard library and performs real filesystem I/O in isolated segment, index, and checkpoint formats.

The crate includes:

- checksummed batch encoding with bounded decoding and corrupt-frame diagnostics;
- append-only segment envelopes, recovery scanning, tail truncation, and sparse indexes;
- concurrent buffered writes whose callbacks run outside the state lock;
- account-lane execution, durable-delivery deduplication, and broker acknowledgement control;
- per-endpoint circuit state, weighted routing, cooldown, and half-open probes;
- retry leasing with exponential backoff, jitter, fairness, deadlines, and lease recovery;
- compaction planning, retention protection, checkpoints, and runtime telemetry;
- a coordinating engine that connects storage, maintenance, retry, and shutdown paths.

## Requirements

- Rust stable with Cargo
- No service, database, network connection, code generator, or third-party crate

## Commands

```text
cargo build --all-targets
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The integration suite covers normal operation, malformed and truncated storage, size boundaries, injected writer/provider failures, ordering, deduplication, concurrent writers, shutdown waiting, scheduling fairness, and durable recovery.

## Layout

Production modules live in `src/`; integration tests and their synthetic fixtures live in `tests/`. Runtime files are created only in caller-provided directories. Tests use unique operating-system temporary directories and remove them on completion.

## License

MIT. The implementation and tests were authored as synthetic benchmark data.
