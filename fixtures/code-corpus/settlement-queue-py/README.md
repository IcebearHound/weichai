# Settlement Queue

Settlement Queue is a fully synthetic Python package for planning, executing,
reconciling, and funding batches of monetary transfers.  The modules use only
the Python standard library and communicate through immutable domain records.

## Toolchain

- Language: Python 3.11 or newer
- License: MIT
- Runtime dependencies: none
- Build check: `python -m compileall -q src tests`
- Tests: `python run_tests.py`
- Lint: `python -m compileall -q src tests`

The package contains independent receipt storage, account and currency
capacity planning, business-calendar adjustment, retry scheduling, netting,
reconciliation, funding-path analysis, and append-journal recovery. Tests cover
normal operation, input boundaries, worker failures, concurrency, and
deterministic property cases.
