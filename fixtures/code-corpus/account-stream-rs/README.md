# Account Stream RS

An independently authored synthetic Rust library for account-partitioned delivery, payout retry bookkeeping, shutdown draining, framing, parsing, and sequence inspection.

- Language: Rust 2021 edition
- Build: `cargo build`
- Test: `cargo test`
- Lint: `cargo clippy --all-targets -- -D warnings`
- Format check: `cargo fmt --check`
- License: MIT
- Dependencies: Rust standard library only

Ownership is explicit in every concurrent component. Independent account lanes enforce sequence gates while allowing unrelated accounts to execute in parallel. Support modules cover stable partitioning, receipt checksums, retry timing, payout replay, and shutdown recovery.
