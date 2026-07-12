from __future__ import annotations

import heapq
from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from types import MappingProxyType

from .model import FundingEdge


class FundingGraph:
    def route(
        self,
        edges: Sequence[FundingEdge],
        source: str,
        demands: Mapping[str, Decimal],
        currency: str,
        at: datetime,
    ) -> Mapping[str, object]:
        code = currency.upper()
        adjacency: dict[str, list[FundingEdge]] = defaultdict(list)
        for edge in edges:
            if edge.currency.upper() != code:
                continue
            if edge.capacity <= 0:
                continue
            if not edge.available_from <= at <= edge.available_until:
                continue
            adjacency[edge.source].append(edge)
        remaining_capacity = {(edge.source, edge.target): edge.capacity for edge in edges if edge.currency.upper() == code}
        allocations: list[Mapping[str, object]] = []
        unmet: dict[str, Decimal] = {}
        total_cost = Decimal(0)
        for target, requested in sorted(demands.items(), key=lambda row: (-row[1], row[0])):
            remaining = max(Decimal(0), requested)
            while remaining > 0:
                distance: dict[str, Decimal] = {source: Decimal(0)}
                predecessor: dict[str, FundingEdge] = {}
                queue: list[tuple[Decimal, str]] = [(Decimal(0), source)]
                visited: set[str] = set()
                while queue:
                    cost, current = heapq.heappop(queue)
                    if current in visited:
                        continue
                    visited.add(current)
                    if current == target:
                        break
                    for edge in adjacency.get(current, []):
                        residual = remaining_capacity.get((edge.source, edge.target), Decimal(0))
                        if residual <= 0:
                            continue
                        penalty = edge.cost
                        if "slow" in edge.labels:
                            penalty += Decimal("0.25")
                        if "preferred" in edge.labels:
                            penalty = max(Decimal(0), penalty - Decimal("0.10"))
                        proposed = cost + penalty
                        if proposed >= distance.get(edge.target, Decimal("Infinity")):
                            continue
                        distance[edge.target] = proposed
                        predecessor[edge.target] = edge
                        heapq.heappush(queue, (proposed, edge.target))
                if target not in predecessor:
                    break
                path: list[FundingEdge] = []
                cursor = target
                guarded: set[str] = set()
                while cursor != source:
                    if cursor in guarded or cursor not in predecessor:
                        path = []
                        break
                    guarded.add(cursor)
                    edge = predecessor[cursor]
                    path.append(edge)
                    cursor = edge.source
                if not path:
                    break
                path.reverse()
                bottleneck = min(
                    [remaining]
                    + [remaining_capacity[(edge.source, edge.target)] for edge in path]
                )
                if bottleneck <= 0:
                    break
                for edge in path:
                    key = (edge.source, edge.target)
                    remaining_capacity[key] -= bottleneck
                path_cost = sum((edge.cost for edge in path), Decimal(0))
                total_cost += bottleneck * path_cost
                remaining -= bottleneck
                allocations.append(
                    MappingProxyType(
                        {
                            "target": target,
                            "amount": bottleneck,
                            "path": tuple([source] + [edge.target for edge in path]),
                            "unit_cost": path_cost,
                            "labels": tuple(sorted(set().union(*(edge.labels for edge in path)))),
                        }
                    )
                )
            if remaining > 0:
                unmet[target] = remaining
        utilization: dict[str, str] = {}
        for edge in edges:
            if edge.currency.upper() != code or edge.capacity <= 0:
                continue
            residual = remaining_capacity.get((edge.source, edge.target), edge.capacity)
            used = edge.capacity - residual
            utilization[f"{edge.source}->{edge.target}"] = str(used / edge.capacity)
        return MappingProxyType(
            {
                "currency": code,
                "allocations": tuple(allocations),
                "unmet": MappingProxyType(unmet),
                "total_cost": total_cost,
                "utilization": MappingProxyType(utilization),
            }
        )

    def cut(
        self,
        edges: Sequence[FundingEdge],
        sources: Sequence[str],
        protected: frozenset[str],
        currency: str,
        at: datetime,
    ) -> Mapping[str, object]:
        code = currency.upper()
        outgoing: dict[str, list[FundingEdge]] = defaultdict(list)
        incoming: dict[str, list[FundingEdge]] = defaultdict(list)
        for edge in edges:
            if edge.currency.upper() != code or edge.capacity <= 0:
                continue
            if not edge.available_from <= at <= edge.available_until:
                continue
            outgoing[edge.source].append(edge)
            incoming[edge.target].append(edge)
        reachable: set[str] = set()
        queue = deque(source for source in sources if source)
        while queue:
            current = queue.popleft()
            if current in reachable:
                continue
            reachable.add(current)
            for edge in outgoing.get(current, []):
                if edge.target not in reachable:
                    queue.append(edge.target)
        unreachable = tuple(sorted(node for node in protected if node not in reachable))
        candidates: list[tuple[Decimal, str, FundingEdge]] = []
        for node in protected:
            for edge in incoming.get(node, []):
                redundancy = len(incoming.get(node, []))
                adjusted = edge.capacity / max(1, redundancy)
                candidates.append((adjusted, f"{edge.source}->{edge.target}", edge))
        candidates.sort(key=lambda row: (row[0], row[1]))
        selected: list[FundingEdge] = []
        covered: set[str] = set(unreachable)
        for _adjusted, _identity, edge in candidates:
            if edge.target in covered:
                continue
            selected.append(edge)
            covered.add(edge.target)
        total_capacity = sum((edge.capacity for edge in selected), Decimal(0))
        return MappingProxyType(
            {
                "currency": code,
                "edges": tuple(f"{edge.source}->{edge.target}" for edge in selected),
                "capacity": total_capacity,
                "unreachable": unreachable,
                "reachable": tuple(sorted(reachable)),
            }
        )
