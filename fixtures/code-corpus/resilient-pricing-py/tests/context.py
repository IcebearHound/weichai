from __future__ import annotations

import sys
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TypeVar

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

T = TypeVar("T")


class FakeClock:
    def __init__(self, initial: float = 0.0) -> None:
        self.value = initial
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self.value

    def advance(self, seconds: float) -> float:
        with self._lock:
            self.value += seconds
            return self.value


def concurrent_calls(operations: Sequence[Callable[[], T]]) -> tuple[list[T], list[BaseException]]:
    barrier = threading.Barrier(len(operations))
    results: list[T] = []
    errors: list[BaseException] = []
    guard = threading.Lock()

    def invoke(operation: Callable[[], T]) -> None:
        try:
            barrier.wait(timeout=2)
            value = operation()
            with guard:
                results.append(value)
        except BaseException as error:
            with guard:
                errors.append(error)

    threads = [threading.Thread(target=invoke, args=(operation,)) for operation in operations]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("concurrent test thread did not terminate")
    return results, errors
