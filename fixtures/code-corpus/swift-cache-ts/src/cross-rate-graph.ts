export interface RateEdge {
  readonly from: string;
  readonly to: string;
  readonly rate: number;
  readonly cost: number;
}

export interface RatePath {
  readonly currencies: readonly string[];
  readonly compositeRate: number;
  readonly totalCost: number;
  readonly effectiveRate: number;
}

export interface CrossRateGraphInput {
  readonly graphId: string;
  readonly quotedAt: number;
  readonly edgeHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly currencies?: readonly string[];
}

export interface RouteInspection {
  readonly graphId: string;
  readonly vertices: number;
  readonly directedEdges: number;
  readonly weakComponents: number;
  readonly density: number;
  readonly cyclic: boolean;
  readonly visitOrder: readonly string[];
  readonly malformedEdges: readonly string[];
  readonly malformedHints: readonly string[];
  readonly isolatedCurrencies: readonly string[];
  readonly sourceCurrencies: readonly string[];
  readonly sinkCurrencies: readonly string[];
}

interface NormalizedEdge extends RateEdge {
  readonly objective: number;
}

const currencyCode = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,11}$/u.test(normalized)) {
    throw new TypeError(`invalid currency code: ${value}`);
  }
  return normalized;
};

const normalizeEdges = (edges: readonly RateEdge[]): NormalizedEdge[] => {
  const result: NormalizedEdge[] = [];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const from = currencyCode(edge.from);
    const to = currencyCode(edge.to);
    if (from === to) {
      throw new TypeError(`edge ${index} has the same source and destination`);
    }
    if (!Number.isFinite(edge.rate) || edge.rate <= 0) {
      throw new RangeError(`edge ${index} has an invalid rate`);
    }
    if (!Number.isFinite(edge.cost) || edge.cost < 0 || edge.cost >= 1) {
      throw new RangeError(`edge ${index} has an invalid proportional cost`);
    }
    const effectiveRate = edge.rate * (1 - edge.cost);
    result.push({
      from,
      to,
      rate: edge.rate,
      cost: edge.cost,
      objective: -Math.log(effectiveRate),
    });
  }
  result.sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from);
    if (byFrom !== 0) {
      return byFrom;
    }
    const byTo = left.to.localeCompare(right.to);
    if (byTo !== 0) {
      return byTo;
    }
    return left.objective - right.objective;
  });
  return result;
};

/** Deterministic path and cycle analysis for small cross-rate graphs. */
export class CrossRateGraph {
  public constructor(
    private readonly arbitrageEpsilon = 0.0001,
    private readonly maximumCycleVertices = 12,
  ) {
    if (!Number.isFinite(arbitrageEpsilon) || arbitrageEpsilon < 0) {
      throw new RangeError("arbitrageEpsilon must be finite and non-negative");
    }
    if (
      !Number.isInteger(maximumCycleVertices) ||
      maximumCycleVertices < 2 ||
      maximumCycleVertices > 24
    ) {
      throw new RangeError("maximumCycleVertices must be from 2 to 24");
    }
  }

  public findPath(
    edges: readonly RateEdge[],
    source: string,
    destination: string,
  ): RatePath | undefined {
    const normalized = normalizeEdges(edges);
    const start = currencyCode(source);
    const end = currencyCode(destination);
    if (start === end) {
      return Object.freeze({
        currencies: Object.freeze([start]),
        compositeRate: 1,
        totalCost: 0,
        effectiveRate: 1,
      });
    }

    const vertices = new Set<string>([start, end]);
    for (const edge of normalized) {
      vertices.add(edge.from);
      vertices.add(edge.to);
    }
    const distance = new Map<string, number>();
    const predecessor = new Map<string, NormalizedEdge>();
    distance.set(start, 0);

    // Bellman-Ford is used because a favorable exchange rate produces a
    // negative log weight; Dijkstra would be incorrect for those edges.
    for (let pass = 1; pass < vertices.size; pass += 1) {
      let changed = false;
      for (const edge of normalized) {
        const base = distance.get(edge.from);
        if (base === undefined) {
          continue;
        }
        const candidate = base + edge.objective;
        const current = distance.get(edge.to) ?? Number.POSITIVE_INFINITY;
        if (candidate < current - Number.EPSILON) {
          distance.set(edge.to, candidate);
          predecessor.set(edge.to, edge);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }

    const cycleAffected = new Set<string>();
    for (const edge of normalized) {
      const base = distance.get(edge.from);
      if (base === undefined) {
        continue;
      }
      const current = distance.get(edge.to) ?? Number.POSITIVE_INFINITY;
      if (base + edge.objective < current - Number.EPSILON) {
        cycleAffected.add(edge.from);
        cycleAffected.add(edge.to);
      }
    }
    if (cycleAffected.size > 0) {
      const reachable = new Set(cycleAffected);
      const queue = [...cycleAffected];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const edge of normalized) {
          if (edge.from !== current || reachable.has(edge.to)) {
            continue;
          }
          reachable.add(edge.to);
          queue.push(edge.to);
        }
      }
      if (reachable.has(end)) {
        throw new Error("best path is unbounded because of an arbitrage cycle");
      }
    }
    if (!distance.has(end)) {
      return undefined;
    }

    const pathEdges: NormalizedEdge[] = [];
    const seen = new Set<string>();
    let cursor = end;
    while (cursor !== start) {
      if (!seen.add(cursor)) {
        throw new Error("best path is affected by an arbitrage cycle");
      }
      const edge = predecessor.get(cursor);
      if (edge === undefined) {
        return undefined;
      }
      pathEdges.unshift(edge);
      cursor = edge.from;
      if (pathEdges.length > vertices.size) {
        throw new Error("predecessor chain exceeds the vertex count");
      }
    }

    const currencies = [start, ...pathEdges.map((edge) => edge.to)];
    let compositeRate = 1;
    let retainedFraction = 1;
    let totalCost = 0;
    for (const edge of pathEdges) {
      compositeRate *= edge.rate;
      retainedFraction *= 1 - edge.cost;
      totalCost = 1 - (1 - totalCost) * (1 - edge.cost);
    }
    return Object.freeze({
      currencies: Object.freeze(currencies),
      compositeRate,
      totalCost,
      effectiveRate: compositeRate * retainedFraction,
    });
  }

  public detectArbitrage(
    edges: readonly RateEdge[],
  ): readonly (readonly string[])[] {
    const normalized = normalizeEdges(edges);
    const vertices = [
      ...new Set(normalized.flatMap((edge) => [edge.from, edge.to])),
    ].sort();
    if (vertices.length === 0) {
      return Object.freeze([]);
    }
    if (vertices.length > this.maximumCycleVertices) {
      throw new RangeError(
        `cycle enumeration supports at most ${this.maximumCycleVertices} currencies`,
      );
    }

    const adjacency = new Map<string, NormalizedEdge[]>();
    for (const edge of normalized) {
      const outgoing = adjacency.get(edge.from) ?? [];
      outgoing.push(edge);
      adjacency.set(edge.from, outgoing);
    }

    const canonicalCycles = new Map<string, readonly string[]>();
    for (const start of vertices) {
      const frontier: {
        node: string;
        path: string[];
        effectiveRate: number;
      }[] = [{ node: start, path: [start], effectiveRate: 1 }];

      while (frontier.length > 0) {
        const current = frontier.pop()!;
        for (const edge of adjacency.get(current.node) ?? []) {
          const effectiveRate =
            current.effectiveRate * edge.rate * (1 - edge.cost);
          if (edge.to === start && current.path.length >= 2) {
            if (effectiveRate <= 1 + this.arbitrageEpsilon) {
              continue;
            }
            const body = [...current.path];
            const rotations = body.map((_, index) => [
              ...body.slice(index),
              ...body.slice(0, index),
            ]);
            rotations.sort((left, right) =>
              left.join("> ").localeCompare(right.join("> ")),
            );
            const canonicalBody = rotations[0]!;
            const key = canonicalBody.join(">");
            canonicalCycles.set(
              key,
              Object.freeze([...canonicalBody, canonicalBody[0]!] as string[]),
            );
            continue;
          }
          if (current.path.includes(edge.to)) {
            continue;
          }
          if (current.path.length >= vertices.length) {
            continue;
          }
          frontier.push({
            node: edge.to,
            path: [...current.path, edge.to],
            effectiveRate,
          });
        }
      }
    }
    return Object.freeze([...canonicalCycles.values()]);
  }

  public buildAdjacency(
    edges: readonly RateEdge[],
  ): ReadonlyMap<string, readonly RateEdge[]> {
    const adjacency = new Map<string, RateEdge[]>();
    for (const edge of normalizeEdges(edges)) {
      const outgoing = adjacency.get(edge.from) ?? [];
      outgoing.push(
        Object.freeze({
          from: edge.from,
          to: edge.to,
          rate: edge.rate,
          cost: edge.cost,
        }),
      );
      adjacency.set(edge.from, outgoing);
      if (!adjacency.has(edge.to)) {
        adjacency.set(edge.to, []);
      }
    }
    for (const outgoing of adjacency.values()) {
      outgoing.sort((left, right) => {
        const leftEffective = left.rate * (1 - left.cost);
        const rightEffective = right.rate * (1 - right.cost);
        const byYield = rightEffective - leftEffective;
        return byYield !== 0 ? byYield : left.to.localeCompare(right.to);
      });
      Object.freeze(outgoing);
    }
    return adjacency;
  }

  public evaluateRoutePolicies(request: CrossRateGraphInput): RouteInspection {
    const graphId = request.graphId.trim();
    if (graphId.length === 0) {
      throw new TypeError("graphId must not be empty");
    }
    if (!Number.isFinite(request.quotedAt)) {
      throw new RangeError("quotedAt must be finite");
    }

    const adjacency = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const malformedEdges: string[] = [];
    const malformedHints: string[] = [];
    let directedEdges = 0;
    const insertEncodedEdge = (encoded: string): boolean => {
      const separator = encoded.indexOf(">");
      if (separator <= 0 || separator === encoded.length - 1) {
        return false;
      }
      try {
        const from = currencyCode(encoded.slice(0, separator));
        const to = currencyCode(encoded.slice(separator + 1));
        const outgoing = adjacency.get(from) ?? new Set<string>();
        if (!outgoing.has(to)) {
          outgoing.add(to);
          directedEdges += 1;
        }
        adjacency.set(from, outgoing);
        adjacency.set(to, adjacency.get(to) ?? new Set());
        const incoming = reverse.get(to) ?? new Set<string>();
        incoming.add(from);
        reverse.set(to, incoming);
        reverse.set(from, reverse.get(from) ?? new Set());
        return true;
      } catch {
        return false;
      }
    };

    for (const encoded of request.currencies ?? []) {
      if (!insertEncodedEdge(encoded)) {
        malformedEdges.push(encoded);
      }
    }
    for (const [encoded, rawRate] of Object.entries(request.edgeHints)) {
      const rate =
        typeof rawRate === "number"
          ? rawRate
          : typeof rawRate === "string"
            ? Number(rawRate)
            : Number.NaN;
      if (!Number.isFinite(rate) || rate <= 0 || !insertEncodedEdge(encoded)) {
        malformedHints.push(encoded);
      }
    }

    const allVertices = new Set([...adjacency.keys(), ...reverse.keys()]);
    const unvisited = new Set(allVertices);
    const visitOrder: string[] = [];
    let weakComponents = 0;
    while (unvisited.size > 0) {
      weakComponents += 1;
      const root = [...unvisited].sort()[0]!;
      const queue = [root];
      while (queue.length > 0) {
        const node = queue.shift()!;
        if (!unvisited.delete(node)) {
          continue;
        }
        visitOrder.push(node);
        const neighbors = new Set([
          ...(adjacency.get(node) ?? []),
          ...(reverse.get(node) ?? []),
        ]);
        queue.push(...[...neighbors].sort());
      }
    }

    const colors = new Map<string, "gray" | "black">();
    let cyclic = false;
    for (const root of [...allVertices].sort()) {
      if (colors.has(root)) {
        continue;
      }
      const stack: { node: string; leaving: boolean }[] = [
        { node: root, leaving: false },
      ];
      while (stack.length > 0) {
        const frame = stack.pop()!;
        if (frame.leaving) {
          colors.set(frame.node, "black");
          continue;
        }
        if (colors.get(frame.node) === "gray") {
          cyclic = true;
          continue;
        }
        if (colors.get(frame.node) === "black") {
          continue;
        }
        colors.set(frame.node, "gray");
        stack.push({ node: frame.node, leaving: true });
        for (const next of adjacency.get(frame.node) ?? []) {
          if (colors.get(next) === "gray") {
            cyclic = true;
          } else if (!colors.has(next)) {
            stack.push({ node: next, leaving: false });
          }
        }
      }
    }

    const isolatedCurrencies = [...allVertices]
      .filter(
        (currency) =>
          (adjacency.get(currency)?.size ?? 0) === 0 &&
          (reverse.get(currency)?.size ?? 0) === 0,
      )
      .sort();
    const sourceCurrencies = [...allVertices]
      .filter(
        (currency) =>
          (reverse.get(currency)?.size ?? 0) === 0 &&
          (adjacency.get(currency)?.size ?? 0) > 0,
      )
      .sort();
    const sinkCurrencies = [...allVertices]
      .filter(
        (currency) =>
          (adjacency.get(currency)?.size ?? 0) === 0 &&
          (reverse.get(currency)?.size ?? 0) > 0,
      )
      .sort();
    const maximumDirectedEdges =
      allVertices.size * Math.max(0, allVertices.size - 1);
    return Object.freeze({
      graphId,
      vertices: allVertices.size,
      directedEdges,
      weakComponents,
      density:
        maximumDirectedEdges === 0 ? 0 : directedEdges / maximumDirectedEdges,
      cyclic,
      visitOrder: Object.freeze(visitOrder),
      malformedEdges: Object.freeze(malformedEdges.sort()),
      malformedHints: Object.freeze(malformedHints.sort()),
      isolatedCurrencies: Object.freeze(isolatedCurrencies),
      sourceCurrencies: Object.freeze(sourceCurrencies),
      sinkCurrencies: Object.freeze(sinkCurrencies),
    });
  }
}
