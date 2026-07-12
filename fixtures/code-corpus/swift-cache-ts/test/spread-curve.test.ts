import assert from "node:assert/strict";
import test from "node:test";
import { SpreadCurve, type CurveKnot } from "../src/spread-curve.js";

const knot = (
  tenorDays: number,
  spreadBps: number,
  confidence = 1,
): CurveKnot => ({
  tenorDays,
  spreadBps,
  confidence,
});

test("interpolation is linear between neighboring tenors", () => {
  const curve = new SpreadCurve();
  assert.equal(curve.interpolate([knot(0, 10), knot(10, 30)], 5), 20);
  assert.equal(curve.interpolate([knot(0, 10), knot(10, 30)], 10), 30);
});

test("duplicate tenors consolidate by confidence weight", () => {
  const curve = new SpreadCurve();
  const value = curve.interpolate(
    [knot(7, 10, 0.25), knot(7, 30, 0.75), knot(30, 40)],
    7,
  );
  assert.equal(value, 25);
});

test("flat extrapolation uses the nearest observed endpoint", () => {
  const curve = new SpreadCurve(true);
  const knots = [knot(7, 12), knot(30, 20)];
  assert.equal(curve.interpolate(knots, 1), 12);
  assert.equal(curve.interpolate(knots, 365), 20);
});

test("linear extrapolation follows the first and last segment", () => {
  const curve = new SpreadCurve(false);
  const knots = [knot(10, 20), knot(20, 40), knot(30, 50)];
  assert.equal(curve.interpolate(knots, 5), 10);
  assert.equal(curve.interpolate(knots, 40), 60);
});

test("fitSegments reports slopes and confidence floors", () => {
  const curve = new SpreadCurve();
  const segments = curve.fitSegments([
    knot(0, 10, 0.9),
    knot(10, 30, 0.4),
    knot(20, 25, 0.8),
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.slopePerDay, 2);
  assert.equal(segments[0]!.annualizedChangeBps, 730);
  assert.equal(segments[0]!.confidenceFloor, 0.4);
  assert.equal(segments[1]!.slopePerDay, -0.5);
});

test("markup uses symmetric half-away rounding for bigint notionals", () => {
  const curve = new SpreadCurve();
  assert.equal(curve.applyMarkup(10, 1_000_000n, 5), 1_500n);
  assert.equal(curve.applyMarkup(10, -1_000_000n, 5), -1_500n);
  assert.equal(curve.applyMarkup(0.005, 1_000_000n, 0), 1n);
});

test("fit inspection parses day, week, month and year tenors", () => {
  const curve = new SpreadCurve();
  const fit = curve.evaluateFitPolicies({
    curveId: " major ",
    fittedAt: 100,
    knotHints: { "1d": 10, "1w": 16, "1m": 39, "1y": 374 },
    tenors: ["1d", "2w", "1y"],
  });
  assert.equal(fit.curveId, "major");
  assert.equal(fit.samples, 4);
  assert.ok(fit.slope > 0.9 && fit.slope < 1.1);
  assert.ok(fit.rootMeanSquareError < 1);
  assert.deepEqual(fit.missingRequestedTenors, ["14d"]);
});

test("fit inspection separates malformed hint keys and values", () => {
  const curve = new SpreadCurve();
  const fit = curve.evaluateFitPolicies({
    curveId: "mixed",
    fittedAt: 1,
    knotHints: { tomorrow: 4, "7d": "5", "30d": false, "1y": null },
  });
  assert.equal(fit.samples, 1);
  assert.deepEqual(fit.rejectedTenors, ["1y", "30d", "tomorrow"]);
});

test("invalid knot and rounding inputs fail explicitly", () => {
  const curve = new SpreadCurve();
  assert.throws(() => curve.interpolate([], 1), /empty curve/u);
  assert.throws(() => curve.interpolate([knot(-1, 2)], 1), /tenorDays/u);
  assert.throws(() => curve.fitSegments([knot(1, 2, 1.5)]), /confidence/u);
  assert.throws(() => curve.applyMarkup(Number.NaN, 1n, 0), /spreadBps/u);
  assert.throws(() => curve.applyMarkup(1e20, 1n, 0), /safe precision/u);
});

test("interpolation reproduces every knot in generated monotone curves", () => {
  const curve = new SpreadCurve();
  for (let width = 2; width <= 12; width += 1) {
    const knots = Array.from({ length: width }, (_, index) =>
      knot(index * 7, index * index + 3, 0.5 + index / (width * 2)),
    );
    for (const point of knots) {
      assert.equal(curve.interpolate(knots, point.tenorDays), point.spreadBps);
    }
  }
});
