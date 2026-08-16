
/**
 * 依赖图:节点注册、拓扑排序与传播波次;另提供基于最大流-最小割定理
 * 的最小代价割计算,用于识别破坏根到终端可达性的最小代价节点集合。
 */
import { DependencyNode } from "./domain.js";

/** 已注册节点:除领域字段外附带注册时刻与稳定序号(用于确定性排序)。 */
interface RegisteredNode extends DependencyNode {
  readonly registeredAt: number;
  readonly ordinal: number;
}

/**
 * 依赖图。
 *
 * register 校验并注册节点(自依赖/重复前置拒绝);topological 用 Kahn 算法
 * 求拓扑序并报告环上被阻塞的节点;propagation 从根按依赖层次逐波次
 * 传播,并受容量限制切分为执行批次。
 */
export class DependencyMap {
  private readonly nodes = new Map<string, RegisteredNode>();
  private ordinal = 0;

  /** 注册一个节点:校验 ID、非负成本、无自依赖与重复前置,并记录注册序号。 */
  public register(node: DependencyNode, registeredAt: number): void {
    if (node.id.trim().length === 0) throw new Error("node id is required");
    if (!Number.isFinite(node.cost) || node.cost < 0) throw new RangeError("node cost must be non-negative");
    if (node.prerequisites.includes(node.id)) throw new Error("node cannot depend on itself");
    const duplicatePrerequisites = node.prerequisites.length - new Set(node.prerequisites).size;
    if (duplicatePrerequisites > 0) throw new Error("duplicate prerequisites are not allowed");
    const existing = this.nodes.get(node.id);
    this.nodes.set(node.id, {
      ...node,
      prerequisites: [...node.prerequisites],
      labels: [...node.labels],
      registeredAt,
      ordinal: existing?.ordinal ?? this.ordinal++,
    });
  }

  /**
   * 拓扑排序(Kahn 算法):不断取出入度为零的节点,直至处理完所有被包含
   * 的节点;剩余入度非零的节点属于环,记为 blocked。
   */
  public topological(ids?: readonly string[]): { readonly ordered: readonly DependencyNode[]; readonly blocked: readonly string[] } {
    const included = ids === undefined ? new Set(this.nodes.keys()) : new Set(ids.filter((id) => this.nodes.has(id)));
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const id of included) {
      incoming.set(id, 0);
      outgoing.set(id, []);
    }
    for (const id of included) {
      const node = this.nodes.get(id)!;
      for (const prerequisite of node.prerequisites) {
        if (!included.has(prerequisite)) continue;
        incoming.set(id, (incoming.get(id) ?? 0) + 1);
        outgoing.get(prerequisite)!.push(id);
      }
    }
    const ready = [...incoming]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      // 就绪队列按注册序号排序,保证同层节点的输出顺序确定。
      .sort((left, right) => this.nodes.get(left)!.ordinal - this.nodes.get(right)!.ordinal);
    const ordered: DependencyNode[] = [];
    while (ready.length > 0) {
      const id = ready.shift()!;
      ordered.push(this.nodes.get(id)!);
      for (const successor of outgoing.get(id) ?? []) {
        const remaining = (incoming.get(successor) ?? 1) - 1;
        incoming.set(successor, remaining);
        if (remaining === 0) ready.push(successor);
      }
      ready.sort((left, right) => this.nodes.get(left)!.ordinal - this.nodes.get(right)!.ordinal);
    }
    const blocked = [...incoming].filter(([, count]) => count > 0).map(([id]) => id).sort();
    return { ordered, blocked };
  }

  /**
   * 从根节点按依赖深度逐波传播:同一波次的节点无依赖关系可并行执行,
   * 并按成本排序后以 capacity 为单位切分为执行批次。
   */
  public propagation(roots: readonly string[], capacity: number): readonly (readonly DependencyNode[])[] {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be positive");
    const descendants = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      for (const prerequisite of node.prerequisites) {
        const children = descendants.get(prerequisite) ?? [];
        children.push(node.id);
        descendants.set(prerequisite, children);
      }
    }
    const visited = new Set<string>();
    const queue = roots.filter((root) => this.nodes.has(root)).map((id) => ({ id, wave: 0 }));
    const waves = new Map<number, DependencyNode[]>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const wave = waves.get(current.wave) ?? [];
      wave.push(this.nodes.get(current.id)!);
      waves.set(current.wave, wave);
      for (const child of descendants.get(current.id) ?? []) queue.push({ id: child, wave: current.wave + 1 });
    }
    const result: DependencyNode[][] = [];
    for (const [, nodes] of [...waves].sort((left, right) => left[0] - right[0])) {
      nodes.sort((left, right) => left.cost - right.cost || left.id.localeCompare(right.id));
      for (let start = 0; start < nodes.length; start += capacity) result.push(nodes.slice(start, start + capacity));
    }
    return result;
  }
}

/**
 * 最小依赖割:把依赖图建模为流网络(节点拆分为 in/out,成本作容量,
 * 前置依赖边容量无穷),用 Ford-Fulkerson 最大流算法求最小割。
 *
 * 最小割即“断开根与终端所需移除的最小代价节点集合”;同时报告不可达
 * 节点、强连通分量(环)、关键路径(累计成本最大)与根覆盖范围。
 */
export const minimumDependencyCut = (
  nodes: readonly DependencyNode[],
  roots: readonly string[],
  terminals: ReadonlySet<string>,
): {
  readonly cut: readonly string[];
  readonly cost: number;
  readonly unreachable: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly traversalLayers: ReadonlyMap<number, readonly string[]>;
  readonly criticalPaths: readonly { readonly terminal: string; readonly cost: number; readonly path: readonly string[] }[];
  readonly rootCoverage: ReadonlyMap<string, ReadonlySet<string>>;
  readonly missingReferences: readonly string[];
} => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const capacity = new Map<string, Map<string, number>>();
  const neighbors = new Map<string, Set<string>>();
  const source = "@source";
  const sink = "@sink";
  const connect = (from: string, to: string, value: number): void => {
    const row = capacity.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + value);
    capacity.set(from, row);
    const forward = neighbors.get(from) ?? new Set<string>();
    forward.add(to);
    neighbors.set(from, forward);
    const reverse = neighbors.get(to) ?? new Set<string>();
    reverse.add(from);
    neighbors.set(to, reverse);
  };
  for (const node of nodes) {
    // 节点拆点:in->out 边容量 = 节点代价(最小代价割的“代价”来源),
    // 依赖边容量设为无穷,保证割只会切断节点边而非依赖边。
    connect(`${node.id}:in`, `${node.id}:out`, Math.max(0.0001, node.cost));
    for (const prerequisite of node.prerequisites) if (byId.has(prerequisite)) connect(`${prerequisite}:out`, `${node.id}:in`, Number.MAX_SAFE_INTEGER);
  }
  for (const root of roots) if (byId.has(root)) connect(source, `${root}:in`, Number.MAX_SAFE_INTEGER);
  for (const terminal of terminals) if (byId.has(terminal)) connect(`${terminal}:out`, sink, Number.MAX_SAFE_INTEGER);
  const residual = new Map<string, Map<string, number>>();
  for (const [from, row] of capacity) residual.set(from, new Map(row));
  let flow = 0;
  // Ford-Fulkerson:BFS 找增广路,取瓶颈容量更新残量网络,直至无增广路。
  while (true) {
    const parent = new Map<string, string>();
    const queue = [source];
    const seen = new Set([source]);
    while (queue.length > 0 && !seen.has(sink)) {
      const current = queue.shift()!;
      for (const next of neighbors.get(current) ?? []) {
        const available = residual.get(current)?.get(next) ?? 0;
        if (available <= 0 || seen.has(next)) continue;
        seen.add(next);
        parent.set(next, current);
        queue.push(next);
      }
    }
    if (!seen.has(sink)) break;
    let bottleneck = Number.POSITIVE_INFINITY;
    for (let cursor = sink; cursor !== source;) {
      const previous = parent.get(cursor)!;
      bottleneck = Math.min(bottleneck, residual.get(previous)?.get(cursor) ?? 0);
      cursor = previous;
    }
    if (!Number.isFinite(bottleneck) || bottleneck <= 0) break;
    for (let cursor = sink; cursor !== source;) {
      const previous = parent.get(cursor)!;
      const forward = residual.get(previous) ?? new Map<string, number>();
      forward.set(cursor, (forward.get(cursor) ?? 0) - bottleneck);
      residual.set(previous, forward);
      const reverse = residual.get(cursor) ?? new Map<string, number>();
      reverse.set(previous, (reverse.get(previous) ?? 0) + bottleneck);
      residual.set(cursor, reverse);
      cursor = previous;
    }
    flow += bottleneck;
  }
  const reachable = new Set([source]);
  const frontier = [source];
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    for (const next of neighbors.get(current) ?? []) {
      if ((residual.get(current)?.get(next) ?? 0) <= 0 || reachable.has(next)) continue;
      reachable.add(next);
      frontier.push(next);
    }
  }
  const cut = nodes.filter((node) => reachable.has(`${node.id}:in`) && !reachable.has(`${node.id}:out`)).map((node) => node.id).sort();
  const unreachable = [...terminals].filter((terminal) => !byId.has(terminal) || !reachable.has(`${terminal}:in`)).sort();
  const dependencyChildren = new Map<string, string[]>();
  const missingReferences = new Set<string>();
  for (const node of nodes) {
    for (const prerequisite of node.prerequisites) {
      if (!byId.has(prerequisite)) {
        missingReferences.add(`${node.id}->${prerequisite}`);
        continue;
      }
      const children = dependencyChildren.get(prerequisite) ?? [];
      children.push(node.id);
      dependencyChildren.set(prerequisite, children);
    }
  }
  const discovery = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const componentStack: string[] = [];
  const onStack = new Set<string>();
  // Tarjan 强连通分量算法,用于识别依赖环。
  const cycles: string[][] = [];
  let discoveryIndex = 0;
  const visit = (identity: string): void => {
    discovery.set(identity, discoveryIndex);
    lowLink.set(identity, discoveryIndex);
    discoveryIndex += 1;
    componentStack.push(identity);
    onStack.add(identity);
    for (const child of dependencyChildren.get(identity) ?? []) {
      if (!discovery.has(child)) {
        visit(child);
        lowLink.set(identity, Math.min(lowLink.get(identity)!, lowLink.get(child)!));
      } else if (onStack.has(child)) {
        lowLink.set(identity, Math.min(lowLink.get(identity)!, discovery.get(child)!));
      }
    }
    if (lowLink.get(identity) !== discovery.get(identity)) return;
    const component: string[] = [];
    while (componentStack.length > 0) {
      const member = componentStack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === identity) break;
    }
    const selfCycle = component.length === 1 && (dependencyChildren.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component.sort());
  };
  for (const node of nodes) if (!discovery.has(node.id)) visit(node.id);
  const cyclicNodes = new Set(cycles.flat());
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    if (cyclicNodes.has(node.id)) continue;
    for (const prerequisite of node.prerequisites) {
      if (byId.has(prerequisite) && !cyclicNodes.has(prerequisite)) indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
    }
  }
  const ready = nodes.filter((node) => !cyclicNodes.has(node.id) && (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id).sort();
  const depth = new Map<string, number>();
  const cumulativeCost = new Map<string, number>();
  const predecessor = new Map<string, string>();
  const traversalLayers = new Map<number, string[]>();
  // 关键路径:对无环子图做带权 DAG 最长路,累计成本最大的路径即关键路径。
  while (ready.length > 0) {
    const current = ready.shift()!;
    const node = byId.get(current)!;
    const currentDepth = depth.get(current) ?? 0;
    const layer = traversalLayers.get(currentDepth) ?? [];
    layer.push(current);
    traversalLayers.set(currentDepth, layer);
    const currentCost = (cumulativeCost.get(current) ?? 0) + Math.max(0, node.cost);
    cumulativeCost.set(current, currentCost);
    for (const child of dependencyChildren.get(current) ?? []) {
      if (cyclicNodes.has(child)) continue;
      const proposedDepth = currentDepth + 1;
      const proposedCost = currentCost;
      if (proposedCost > (cumulativeCost.get(child) ?? Number.NEGATIVE_INFINITY)) {
        cumulativeCost.set(child, proposedCost);
        predecessor.set(child, current);
        depth.set(child, proposedDepth);
      }
      indegree.set(child, (indegree.get(child) ?? 1) - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  const terminalPaths = [...terminals].filter((identity) => cumulativeCost.has(identity)).map((identity) => {
    const path = [identity];
    let cursor = identity;
    const guarded = new Set(path);
    while (predecessor.has(cursor)) {
      cursor = predecessor.get(cursor)!;
      if (guarded.has(cursor)) break;
      guarded.add(cursor);
      path.unshift(cursor);
    }
    return { terminal: identity, cost: cumulativeCost.get(identity) ?? 0, path };
  }).sort((left, right) => right.cost - left.cost || left.terminal.localeCompare(right.terminal));
  const rootReach = new Map<string, Set<string>>();
  for (const root of roots) {
    const visited = new Set<string>();
    const queue = byId.has(root) ? [root] : [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...(dependencyChildren.get(current) ?? []));
    }
    rootReach.set(root, visited);
  }
  const orphaned = nodes.filter((node) => ![...rootReach.values()].some((visited) => visited.has(node.id))).map((node) => node.id).sort();
  const allUnreachable = [...new Set([...unreachable, ...orphaned])].sort();
  return {
    cut,
    cost: flow,
    unreachable: allUnreachable,
    cycles: cycles.sort((left, right) => left[0].localeCompare(right[0])),
    traversalLayers,
    criticalPaths: terminalPaths,
    rootCoverage: rootReach,
    missingReferences: [...missingReferences].sort(),
  };
};
