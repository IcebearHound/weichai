# Circuit Lane Java

Circuit Lane is an independently authored synthetic Java 17 library for a currency
pricing and settlement gateway. It contains provider health isolation, ordered
fallback selection, quote inventory, provider catalog ranking, batch payment
execution, exposure netting, business-date calculation, settlement-rail selection,
tamper-evident audit segments, and several focused representation utilities.

The implementation uses only the Java standard library. Concurrency is explicit:
provider health is isolated per provider, quote history uses a read/write lock,
idempotent batches serialize state transitions, and audit segments synchronize
append and sealing. No application server, annotation processor, generated source,
or test framework is required.

Requirements:

- JDK 17 or newer
- PowerShell 7 or Windows PowerShell 5.1
- No third-party dependencies
- MIT license

Verification commands:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Test
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Test -Lint
```

`-Test` compiles production and test source, enables JVM assertions, and runs the
dependency-free `synthetic.lane.LaneTestSuite`. `-Lint` adds all `javac` lint checks.
The test suite covers successful, invalid, retry, partial-failure, cooldown,
half-open recovery, shutdown-like sealing, deterministic encoding, and concurrent
access paths.

All source and test data in this repository are synthetic and were written for this
fixture. They do not copy an existing open-source implementation.
