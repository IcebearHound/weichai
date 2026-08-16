/**
 * BufferGeometry 的单元测试:多边形面积(朝向无关、闭合环、退化)、凸包
 * (去重/内部点/共线)、边界盒、自相交分类与坐标边界校验。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BufferGeometry, type Point2D } from "../src/buffer-geometry.js";

const geometry = new BufferGeometry();

test("shoelace area is independent of polygon orientation", () => {
  // 鞋带公式取绝对值:顺/逆时针遍历面积相同。
  const clockwise: Point2D[] = [
    { x: 0, y: 0 },
    { x: 0, y: 4 },
    { x: 3, y: 4 },
    { x: 3, y: 0 },
  ];
  assert.equal(geometry.area(clockwise), 12);
  assert.equal(geometry.area([...clockwise].reverse()), 12);
});

test("an explicitly closed ring does not add a phantom edge", () => {
  // 首尾重复点应被剔除,不产生额外的零面积边。
  const ring = [
    { x: 1, y: 1 },
    { x: 5, y: 1 },
    { x: 3, y: 4 },
    { x: 1, y: 1 },
  ];
  assert.equal(geometry.area(ring), 6);
});

test("degenerate rings have zero area", () => {
  assert.equal(geometry.area([]), 0);
  assert.equal(geometry.area([{ x: 1, y: 2 }]), 0);
  assert.equal(
    geometry.area([
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 4, y: 4 },
    ]),
    0,
  );
});

test("convex hull removes duplicates and interior points", () => {
  const hull = geometry.convexHull([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
  ]);
  assert.deepEqual(hull, [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ]);
  assert.equal(Object.isFrozen(hull), true);
});

test("convex hull retains only endpoints for collinear input", () => {
  assert.deepEqual(
    geometry.convexHull([
      { x: -2, y: -2 },
      { x: 0, y: 0 },
      { x: 3, y: 3 },
      { x: 1, y: 1 },
    ]),
    [
      { x: -2, y: -2 },
      { x: 3, y: 3 },
    ],
  );
});

test("bounding box reports dimensions and extrema", () => {
  assert.deepEqual(
    geometry.intersections([
      { x: -5, y: 8 },
      { x: 7, y: -3 },
      { x: 2, y: 4 },
    ]),
    {
      minimumX: -5,
      minimumY: -3,
      maximumX: 7,
      maximumY: 8,
      width: 12,
      height: 11,
    },
  );
  assert.equal(geometry.intersections([]), undefined);
});

test("self-intersection scan distinguishes proper crossings", () => {
  // 蝴蝶结多边形:两条非相邻边贯穿交叉,应判定为 cross。
  const bowTie = [
    { x: 0, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 3 },
    { x: 3, y: 0 },
  ];
  assert.deepEqual(geometry.evaluateTolerancePolicies(bowTie), [
    { first: 0, second: 2, kind: "cross" },
  ]);
});

test("non-adjacent collinear edges are classified as overlap", () => {
  const folded = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 1, y: 0 },
    { x: 3, y: 0 },
  ];
  const findings = geometry.evaluateTolerancePolicies(folded);
  assert.equal(
    findings.some((entry) => entry.kind === "overlap"),
    true,
  );
});

test("geometry rejects non-finite and out-of-range coordinates", () => {
  assert.throws(
    () =>
      geometry.area([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: NaN, y: 1 },
      ]),
    /non-finite/u,
  );
  const bounded = new BufferGeometry(10);
  assert.throws(
    () => bounded.convexHull([{ x: 11, y: 0 }]),
    /configured limit/u,
  );
  assert.throws(() => geometry.evaluateTolerancePolicies([], -0.1), /epsilon/u);
});

test("area and hull agree for generated axis-aligned rectangles", () => {
  // 属性测试:任意尺寸矩形(含中心点)的凸包面积恒等于矩形面积。
  for (let width = 1; width <= 8; width += 1) {
    for (let height = 1; height <= 6; height += 1) {
      const points = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
        { x: width / 2, y: height / 2 },
      ];
      const hull = geometry.convexHull(points);
      assert.equal(hull.length, 4);
      assert.equal(geometry.area(hull), width * height);
    }
  }
});
