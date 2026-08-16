"""自适应数据源泳道:按断路器语义在多个数据源之间做故障转移。

每个数据源维护独立状态机 closed → open → half-open:
连续失败达到 failure_limit 或半开探测失败时打开,冷却 cool_down_seconds
后进入 half-open 并放行单个探测请求;探测成功即恢复 closed。
多数据源按顺序尝试,全部失败/冷却时抛出聚合错误。
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable, Sequence


class AdaptiveSourceLane:
    """带断路器语义的按名分组数据源池。

    request 依次尝试各数据源,跳过处于冷却期的源;成功即返回该源结果。
    source_health_report 导出每个源的状态、剩余冷却与成功率统计。
    所有状态变更经 RLock 串行化。
    """

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
        """按顺序尝试各数据源,返回第一个成功源的结果。

        源名先归一化(小写、去空白)并查重,非法输入直接抛错;
        处于 open 冷却期的源跳过;half-open 时只放行一个探测请求
        (probe_running 互斥),其余等待者跳过本轮;
        全部失败时抛 RuntimeError(附带失败源名与冷却源列表)。
        """
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
                        # 冷却期未结束:跳过该源,不计入失败
                        cooling.append(name)
                        continue
                    # 冷却结束:转 half-open,允许一个探测请求
                    state["mode"] = "half-open"
                    mode = "half-open"
                if mode == "half-open":
                    if bool(state["probe_running"]):
                        # 已有探测在途,其余请求本轮跳过
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
                    # 半开探测失败立即打开;closed 态连续失败达阈值也打开
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
            # add_note 附加冷却源信息,便于排查故障转移被抑制的原因
            error.add_note(f"cooling sources: {', '.join(cooling) or 'none'}")
            raise error from failures[-1][1]
        raise RuntimeError(f"all sources are cooling down: {', '.join(cooling)}")

    def source_health_report(self, now: float | None = None) -> dict[str, object]:
        """导出所有数据源的健康报告。

        每个源包含当前模式、是否在冷却、剩余冷却秒数、连续/累计失败数、
        成功数、尝试数与成功率;顶层汇总各模式数量与总量统计。
        """
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
