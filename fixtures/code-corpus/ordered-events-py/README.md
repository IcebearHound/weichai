# Ordered Events

Ordered Events is a fully synthetic asyncio package for durable, account-keyed
message consumption. It preserves admission order within an account while
allowing unrelated accounts to run in parallel, records acknowledgements only
after successful processing, and supports replay, checkpoint, dead-letter,
backpressure, and partition-rebalancing workflows.

## Toolchain

- Language: Python 3.11 or newer
- License: MIT
- Runtime dependencies: none
- Build check: `python -m compileall -q src tests`
- Tests: `python run_tests.py`
- Lint: `python -m compileall -q src tests`

All implementation and test data in this repository are independently
synthetic. The package relies only on the Python standard library.
