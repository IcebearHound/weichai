from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable, Sequence


class AdaptiveSourceLane:
    def __init__(
        self,
        failure_limit: int = 3,
        cool_down_seconds: float = 2.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not isinstance(failure_limit, int) or failure_limit < 1:
            raise ValueError("failure_limit must be a positive integer")
        if not math.isfinite(cool_down_seconds) or cool_down_seconds < 0:
            raise ValueError("cool_down_seconds must be finite and non-negative")
        if not math.isfinite(clock()):
            raise ValueError("clock must return a finite value")
        self._failure_limit = failure_limit
        self._cool_down = cool_down_seconds
        self._clock = clock
        self._state: dict[str, dict[str, object]] = {}
        self._guard = threading.RLock()

    def request(self, sources: Sequence[tuple[str, Callable[[], object]]]) -> object:
        if not sources:
            raise ValueError("at least one source is required")
        normalized_sources: list[tuple[str, Callable[[], object]]] = []
        seen_names: set[str] = set()
        for index, (raw_name, operation) in enumerate(sources):
            name = raw_name.strip().lower()
            if not name or len(name) > 128:
                raise ValueError(f"source {index} has an invalid name")
            if name in seen_names:
                raise ValueError(f"duplicate source name: {name}")
            if not callable(operation):
                raise TypeError(f"source {name} operation is not callable")
            seen_names.add(name)
            normalized_sources.append((name, operation))

        failures: list[tuple[str, BaseException]] = []
        cooling: list[str] = []
        for name, operation in normalized_sources:
            observed = self._clock()
            if not math.isfinite(observed):
                raise ValueError("clock must return a finite value")
            with self._guard:
                state = self._state.get(name)
                if state is None:
                    state = {
                        "mode": "closed",
                        "consecutive_failures": 0,
                        "total_failures": 0,
                        "successes": 0,
                        "opened_at": 0.0,
                        "last_failure_at": None,
                        "last_success_at": None,
                        "probe_running": False,
                        "attempts": 0,
                    }
                    self._state[name] = state

                mode = str(state["mode"])
                if mode == "open":
                    elapsed = observed - float(state["opened_at"])
                    if elapsed < self._cool_down:
                        cooling.append(name)
                        continue
                    state["mode"] = "half-open"
                    mode = "half-open"
                if mode == "half-open":
                    if bool(state["probe_running"]):
                        cooling.append(name)
                        continue
                    state["probe_running"] = True
                state["attempts"] = int(state["attempts"]) + 1

            try:
                result = operation()
            except BaseException as error:
                failed_at = self._clock()
                with self._guard:
                    state = self._state[name]
                    state["probe_running"] = False
                    state["consecutive_failures"] = int(state["consecutive_failures"]) + 1
                    state["total_failures"] = int(state["total_failures"]) + 1
                    state["last_failure_at"] = failed_at
                    if (
                        str(state["mode"]) == "half-open"
                        or int(state["consecutive_failures"]) >= self._failure_limit
                    ):
                        state["mode"] = "open"
                        state["opened_at"] = failed_at
                failures.append((name, error))
                continue

            succeeded_at = self._clock()
            with self._guard:
                state = self._state[name]
                state["mode"] = "closed"
                state["probe_running"] = False
                state["consecutive_failures"] = 0
                state["successes"] = int(state["successes"]) + 1
                state["last_success_at"] = succeeded_at
                state["opened_at"] = 0.0
            return result

        if failures:
            names = ", ".join(name for name, _error in failures)
            error = RuntimeError(f"all attempted sources failed: {names}")
            error.add_note(f"cooling sources: {', '.join(cooling) or 'none'}")
            raise error from failures[-1][1]
        raise RuntimeError(f"all sources are cooling down: {', '.join(cooling)}")

    def source_health_report(self, now: float | None = None) -> dict[str, object]:
        observed = self._clock() if now is None else now
        if not math.isfinite(observed):
            raise ValueError("now must be finite")
        rows: list[dict[str, object]] = []
        with self._guard:
            for name, state in sorted(self._state.items()):
                mode = str(state["mode"])
                opened_at = float(state["opened_at"])
                remaining = (
                    max(0.0, self._cool_down - (observed - opened_at))
                    if mode == "open"
                    else 0.0
                )
                attempts = int(state["attempts"])
                successes = int(state["successes"])
                rows.append(
                    {
                        "name": name,
                        "mode": mode,
                        "open": mode == "open" and remaining > 0,
                        "probe_running": bool(state["probe_running"]),
                        "remaining": remaining,
                        "consecutive_failures": int(state["consecutive_failures"]),
                        "total_failures": int(state["total_failures"]),
                        "successes": successes,
                        "attempts": attempts,
                        "success_ratio": successes / attempts if attempts else 0.0,
                        "last_failure_at": state["last_failure_at"],
                        "last_success_at": state["last_success_at"],
                    }
                )
        return {
            "sources": tuple(rows),
            "open_count": sum(row["mode"] == "open" for row in rows),
            "half_open_count": sum(row["mode"] == "half-open" for row in rows),
            "closed_count": sum(row["mode"] == "closed" for row in rows),
            "attempts": sum(int(row["attempts"]) for row in rows),
            "failures": sum(int(row["total_failures"]) for row in rows),
            "successes": sum(int(row["successes"]) for row in rows),
        }
