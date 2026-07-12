# Resilient Pricing PY

An independently authored synthetic collection of synchronous and asynchronous pricing operations, registries, graph utilities, ordering helpers, and persistence-oriented batch tools.

- Language: Python 3.11+
- Build: `python -m compileall -q src`
- Lint/syntax check: `python -B -m compileall -q src tests`
- Test: `python -m unittest discover -s tests`
- License: MIT
- Dependencies: Python standard library only

The package uses a `src` layout and a PEP 517 build manifest. Its modules deliberately use distinct algorithms and explicit error paths so they can be inspected independently.
