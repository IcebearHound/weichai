import assert from "node:assert/strict";
import test from "node:test";
import { CrossRateGraph, type RateEdge } from "../src/cross-rate-graph.js";

const edge = (from: string, to: string, rate: number, cost = 0): RateEdge => ({
  from,
  to,
  rate,
  cost,
});

test("best path maximizes the exchange yield after proportional costs", () => {
  const graph = new CrossRateGraph();
  const path = graph.findPath(
    [
      edge("EUR", "JPY", 160, 0.01),
      edge("EUR", "GBP", 0.86, 0.001),
      edge("GBP", "JPY", 190, 0.001),
    ],
    "eur",
    "jpy",
  );
  assert.deepEqual(path?.currencies, ["EUR", "GBP", "JPY"]);
  assert.equal(path?.compositeRate, 0.86 * 190);
  assert.ok((path?.effectiveRate ?? 0) > 160);
  assert.ok((path?.totalCost ?? 1) < 0.01);
});

test("same-currency path has identity rate and no edges", () => {
  const graph = new CrossRateGraph();
  assert.deepEqual(graph.findPath([], "USD", "usd"), {
    currencies: ["USD"],
    compositeRate: 1,
    totalCost: 0,
    effectiveRate: 1,
  });
});

test("unreachable destinations return undefined", () => {
  const graph = new CrossRateGraph();
  assert.equal(
    graph.findPath([edge("EUR", "GBP", 0.8)], "EUR", "CAD"),
    undefined,
  );
});

test("arbitrage cycles are canonicalized without rotation duplicates", () => {
  const graph = new CrossRateGraph();
  const cycles = graph.detectArbitrage([
    edge("USD", "EUR", 0.95),
    edge("EUR", "GBP", 0.9),
    edge("GBP", "USD", 1.2),
  ]);
  assert.deepEqual(cycles, [["EUR", "GBP", "USD", "EUR"]]);
});

test("costs can eliminate an apparent arbitrage opportunity", () => {
  const graph = new CrossRateGraph();
  const cycles = graph.detectArbitrage([
    edge("USD", "EUR", 0.95, 0.03),
    edge("EUR", "USD", 1.08, 0.03),
  ]);
  assert.deepEqual(cycles, []);
});

test("adjacency includes sink vertices and sorts by effective yield", () => {
  const graph = new CrossRateGraph();
  const adjacency = graph.buildAdjacency([
    edge("USD", "JPY", 150, 0.02),
    edge("USD", "EUR", 0.93, 0),
    edge("USD", "JPY", 152, 0),
  ]);
  assert.deepEqual(
    adjacency.get("USD")?.map((item) => item.to),
    ["JPY", "JPY", "EUR"],
  );
  assert.deepEqual(adjacency.get("EUR"), []);
});

test("route inspection distinguishes DAGs from directed cycles", () => {
  const graph = new CrossRateGraph();
  const dag = graph.evaluateRoutePolicies({
    graphId: "dag",
    quotedAt: 1,
    edgeHints: {},
    currencies: ["USD>EUR", "USD>GBP", "EUR>JPY", "GBP>JPY"],
  });
  assert.equal(dag.cyclic, false);
  assert.equal(dag.vertices, 4);
  assert.equal(dag.directedEdges, 4);
  assert.equal(dag.weakComponents, 1);

  const cycle = graph.evaluateRoutePolicies({
    graphId: "cycle",
    quotedAt: 1,
    edgeHints: {},
    currencies: ["USD>EUR", "EUR>USD"],
  });
  assert.equal(cycle.cyclic, true);
});

test("malformed encoded routes are reported rather than inserted", () => {
  const graph = new CrossRateGraph();
  const result = graph.evaluateRoutePolicies({
    graphId: "mixed",
    quotedAt: 1,
    edgeHints: {},
    currencies: ["USD>EUR", "broken", "?>JPY", "EUR>"],
  });
  assert.deepEqual(result.malformedEdges, ["?>JPY", "EUR>", "broken"]);
  assert.deepEqual(result.visitOrder, ["EUR", "USD"]);
});

test("invalid edge rates, costs and codes are rejected", () => {
  const graph = new CrossRateGraph();
  assert.throws(
    () => graph.findPath([edge("?", "USD", 1)], "EUR", "USD"),
    /currency/u,
  );
  assert.throws(() => graph.detectArbitrage([edge("EUR", "USD", 0)]), /rate/u);
  assert.throws(
    () => graph.buildAdjacency([edge("EUR", "USD", 1, 1)]),
    /cost/u,
  );
  assert.throws(
    () => graph.findPath([edge("EUR", "EUR", 1)], "EUR", "USD"),
    /same source/u,
  );
});

test("a neutral reciprocal graph never reports a profitable cycle", () => {
  const graph = new CrossRateGraph();
  for (const rate of [0.1, 0.5, 0.9, 1, 1.5, 10]) {
    const cycles = graph.detectArbitrage([
      edge("AAA", "BBB", rate),
      edge("BBB", "AAA", 1 / rate),
    ]);
    assert.deepEqual(cycles, [], `neutral rate ${rate}`);
  }
});
