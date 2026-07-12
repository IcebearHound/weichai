from __future__ import annotations

import collections
from collections.abc import Mapping


class FetchRouteTable:
    def __init__(self, edges: Mapping[str, set[str]] | None = None) -> None:
        self._edges: dict[str, set[str]] = {}
        for raw_node, raw_neighbors in (edges or {}).items():
            node = raw_node.strip().upper()
            if not node or len(node) > 32:
                raise ValueError(f"invalid route node: {raw_node}")
            neighbors: set[str] = set()
            for raw_neighbor in raw_neighbors:
                neighbor = raw_neighbor.strip().upper()
                if not neighbor or len(neighbor) > 32:
                    raise ValueError(f"invalid neighbor from {node}")
                if neighbor == node:
                    raise ValueError(f"self route at {node}")
                neighbors.add(neighbor)
            self._edges[node] = neighbors

    def path(self, start: str, destination: str) -> tuple[str, ...]:
        source = start.strip().upper()
        target = destination.strip().upper()
        if not source or not target:
            raise ValueError("route endpoints must not be empty")
        if source == target:
            return (source,)
        frontier: collections.deque[tuple[str, tuple[str, ...]]] = collections.deque(
            [(source, (source,))]
        )
        visited = {source}
        while frontier:
            node, route = frontier.popleft()
            for neighbor in sorted(self._edges.get(node, set())):
                if neighbor == target:
                    return (*route, neighbor)
                if neighbor in visited:
                    continue
                visited.add(neighbor)
                frontier.append((neighbor, (*route, neighbor)))
        return ()

    def route_topology_report(self) -> dict[str, object]:
        vertices = set(self._edges)
        reverse: dict[str, set[str]] = collections.defaultdict(set)
        for node, neighbors in self._edges.items():
            vertices.update(neighbors)
            for neighbor in neighbors:
                reverse[neighbor].add(node)
        indegree = collections.Counter(
            neighbor
            for neighbors in self._edges.values()
            for neighbor in neighbors
        )
        roots = sorted(vertex for vertex in vertices if indegree[vertex] == 0)
        leaves = sorted(vertex for vertex in vertices if not self._edges.get(vertex))
        unvisited = set(vertices)
        components: list[tuple[str, ...]] = []
        while unvisited:
            root = min(unvisited)
            queue = collections.deque([root])
            component: list[str] = []
            while queue:
                node = queue.popleft()
                if node not in unvisited:
                    continue
                unvisited.remove(node)
                component.append(node)
                neighbors = self._edges.get(node, set()) | reverse.get(node, set())
                queue.extend(sorted(neighbors))
            components.append(tuple(component))

        colors: dict[str, str] = {}
        cyclic = False
        for root in sorted(vertices):
            if root in colors:
                continue
            stack: list[tuple[str, bool]] = [(root, False)]
            while stack:
                node, leaving = stack.pop()
                if leaving:
                    colors[node] = "black"
                    continue
                if colors.get(node) == "gray":
                    cyclic = True
                    continue
                if colors.get(node) == "black":
                    continue
                colors[node] = "gray"
                stack.append((node, True))
                for neighbor in sorted(self._edges.get(node, set()), reverse=True):
                    if colors.get(neighbor) == "gray":
                        cyclic = True
                    elif neighbor not in colors:
                        stack.append((neighbor, False))
        edge_count = sum(len(neighbors) for neighbors in self._edges.values())
        maximum_edges = len(vertices) * max(0, len(vertices) - 1)
        return {
            "vertices": len(vertices),
            "edges": edge_count,
            "roots": tuple(roots),
            "leaves": tuple(leaves),
            "components": tuple(components),
            "component_count": len(components),
            "cyclic": cyclic,
            "density": edge_count / maximum_edges if maximum_edges else 0.0,
            "indegree": dict(sorted(indegree.items())),
        }
