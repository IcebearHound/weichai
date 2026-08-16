"""资金路由图:按需求在资金边构成的图上做最小成本路由。

route 对每个 (目标账户, 需求) 用 Dijkstra(边成本带标签惩罚/奖励)求最短路径,
按瓶颈容量分块分配,直到需求满足或无法再路由,并汇总未满足(unmet)需求、
总成本与各边利用率;cut 计算保护节点集合的最小割候选边(按入边冗余度
调整后的容量升序选取,覆盖不可达节点)。
"""

from __future__ import annotations

import heapq
from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from types import MappingProxyType

from .model import FundingEdge


class FundingGraph:
    """资金路由与割集分析。

    route 做最小成本资金分配;cut 输出保护关键节点所需的最小容量边集。
    """

    def route(
        self,
        edges: Sequence[FundingEdge],
        source: str,
        demands: Mapping[str, Decimal],
        currency: str,
        at: datetime,
    ) -> Mapping[str, object]:
        """按需求在可用边网络上路由资金,返回分配结果(只读映射)。

        过滤:仅保留指定币种、容量 > 0、且在 [available_from, available_until]
        窗口内的边。需求按金额降序逐个处理;每次用 Dijkstra 求当前残量网络
        下的最短路径(慢速边 +0.25 惩罚,preferred 边 -0.10 奖励),
        按瓶颈(路径最小残量)分块划拨,直至满足或无可达路径。
        """
        code = currency.upper()
        adjacency: dict[str, list[FundingEdge]] = defaultdict(list)
        for edge in edges:
            if edge.currency.upper() != code:
                continue
            if edge.capacity <= 0:
                continue
            if not edge.available_from <= at <= edge.available_until:
                continue
            # 只保留当前可用的同币种正容量边
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
                # Dijkstra:以调整后成本为权重,找当前残量网络下的最短路径
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
                        # 标签调整:慢速边加罚,preferred 边减奖(但不为负)
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
                # 沿前驱链回溯路径,guarded 防环
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
                # 瓶颈 = 需求与路径各边残量的最小值,按此分块划拨
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
        """计算保护 protected 节点集所需的最小容量边集。

        先做 BFS 求从 sources 出发可达的节点,不可达的保护节点列入
        unreachable;再按"入边容量 / 入边冗余度"升序选取入边,覆盖所有
        unreachable 节点,返回所选边的总容量与可达节点集合。
        """
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
