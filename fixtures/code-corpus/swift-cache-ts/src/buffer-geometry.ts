export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Bounds2D {
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgeIntersection {
  readonly first: number;
  readonly second: number;
  readonly kind: "cross" | "touch" | "overlap";
}

interface IndexedPoint extends Point2D {
  readonly originalIndex: number;
}

const signedTurn = (origin: Point2D, a: Point2D, b: Point2D): number =>
  (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

const coordinatesEqual = (
  left: Point2D,
  right: Point2D,
  epsilon: number,
): boolean =>
  Math.abs(left.x - right.x) <= epsilon &&
  Math.abs(left.y - right.y) <= epsilon;

const pointOnSegment = (
  point: Point2D,
  start: Point2D,
  end: Point2D,
  epsilon: number,
): boolean => {
  if (Math.abs(signedTurn(start, end, point)) > epsilon) {
    return false;
  }
  const minimumX = Math.min(start.x, end.x) - epsilon;
  const maximumX = Math.max(start.x, end.x) + epsilon;
  const minimumY = Math.min(start.y, end.y) - epsilon;
  const maximumY = Math.max(start.y, end.y) + epsilon;
  return (
    point.x >= minimumX &&
    point.x <= maximumX &&
    point.y >= minimumY &&
    point.y <= maximumY
  );
};

/** Polygon calculations used by a map-buffering sample, not an audit buffer. */
export class BufferGeometry {
  public constructor(private readonly coordinateLimit = 1_000_000_000) {
    if (!Number.isFinite(coordinateLimit) || coordinateLimit <= 0) {
      throw new RangeError("coordinateLimit must be finite and positive");
    }
  }

  public area(points: readonly Point2D[]): number {
    if (points.length < 3) {
      return 0;
    }

    const ring = [...points];
    const first = ring[0]!;
    const last = ring.at(-1)!;
    if (coordinatesEqual(first, last, Number.EPSILON)) {
      ring.pop();
    }
    if (ring.length < 3) {
      return 0;
    }

    const origin = ring[0]!;
    let minimumX = origin.x;
    let maximumX = origin.x;
    let minimumY = origin.y;
    let maximumY = origin.y;
    for (let index = 0; index < ring.length; index += 1) {
      const point = ring[index]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new TypeError(`non-finite coordinate at vertex ${index}`);
      }
      if (
        Math.abs(point.x) > this.coordinateLimit ||
        Math.abs(point.y) > this.coordinateLimit
      ) {
        throw new RangeError(`coordinate outside configured limit at ${index}`);
      }
      minimumX = Math.min(minimumX, point.x);
      maximumX = Math.max(maximumX, point.x);
      minimumY = Math.min(minimumY, point.y);
      maximumY = Math.max(maximumY, point.y);
    }
    if (maximumX === minimumX || maximumY === minimumY) {
      return 0;
    }

    let twiceArea = 0;
    let compensation = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index]!;
      const next = ring[(index + 1) % ring.length]!;
      for (const coordinate of [current.x, current.y, next.x, next.y]) {
        if (!Number.isFinite(coordinate)) {
          throw new TypeError(`non-finite coordinate near vertex ${index}`);
        }
        if (Math.abs(coordinate) > this.coordinateLimit) {
          throw new RangeError(
            `coordinate outside configured limit at ${index}`,
          );
        }
      }

      // Translating by the first point preserves area and reduces cancellation
      // for small polygons expressed in large world coordinates.
      const currentX = current.x - origin.x;
      const currentY = current.y - origin.y;
      const nextX = next.x - origin.x;
      const nextY = next.y - origin.y;
      const determinant = currentX * nextY - nextX * currentY;
      const corrected = determinant - compensation;
      const updated = twiceArea + corrected;
      compensation = updated - twiceArea - corrected;
      twiceArea = updated;
    }

    const result = Math.abs(twiceArea) / 2;
    if (!Number.isFinite(result)) {
      throw new RangeError("polygon area overflowed");
    }
    return result;
  }

  public convexHull(points: readonly Point2D[]): readonly Point2D[] {
    const indexed: IndexedPoint[] = [];
    for (
      let originalIndex = 0;
      originalIndex < points.length;
      originalIndex += 1
    ) {
      const point = points[originalIndex]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new TypeError(`non-finite point at ${originalIndex}`);
      }
      if (
        Math.abs(point.x) > this.coordinateLimit ||
        Math.abs(point.y) > this.coordinateLimit
      ) {
        throw new RangeError(
          `point outside configured limit at ${originalIndex}`,
        );
      }
      indexed.push({ ...point, originalIndex });
    }

    indexed.sort((left, right) => {
      const horizontal = left.x - right.x;
      if (horizontal !== 0) {
        return horizontal;
      }
      const vertical = left.y - right.y;
      if (vertical !== 0) {
        return vertical;
      }
      return left.originalIndex - right.originalIndex;
    });

    const unique: IndexedPoint[] = [];
    for (const point of indexed) {
      const previous = unique.at(-1);
      if (
        previous !== undefined &&
        previous.x === point.x &&
        previous.y === point.y
      ) {
        continue;
      }
      unique.push(point);
    }
    if (unique.length <= 2) {
      return Object.freeze(unique.map(({ x, y }) => Object.freeze({ x, y })));
    }

    const lower: IndexedPoint[] = [];
    for (const point of unique) {
      while (lower.length >= 2) {
        const turn = signedTurn(lower.at(-2)!, lower.at(-1)!, point);
        if (turn > 0) {
          break;
        }
        lower.pop();
      }
      lower.push(point);
    }

    const upper: IndexedPoint[] = [];
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      const point = unique[index]!;
      while (upper.length >= 2) {
        const turn = signedTurn(upper.at(-2)!, upper.at(-1)!, point);
        if (turn > 0) {
          break;
        }
        upper.pop();
      }
      upper.push(point);
    }

    lower.pop();
    upper.pop();
    const hull = [...lower, ...upper].map(({ x, y }) =>
      Object.freeze({ x, y }),
    );
    return Object.freeze(hull);
  }

  public intersections(points: readonly Point2D[]): Bounds2D | undefined {
    if (points.length === 0) {
      return undefined;
    }

    let minimumX = Number.POSITIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new TypeError(`non-finite point at ${index}`);
      }
      if (
        Math.abs(point.x) > this.coordinateLimit ||
        Math.abs(point.y) > this.coordinateLimit
      ) {
        throw new RangeError(`point outside configured limit at ${index}`);
      }
      minimumX = Math.min(minimumX, point.x);
      minimumY = Math.min(minimumY, point.y);
      maximumX = Math.max(maximumX, point.x);
      maximumY = Math.max(maximumY, point.y);
    }

    return Object.freeze({
      minimumX,
      minimumY,
      maximumX,
      maximumY,
      width: maximumX - minimumX,
      height: maximumY - minimumY,
    });
  }

  public evaluateTolerancePolicies(
    points: readonly Point2D[],
    epsilon = 1e-9,
  ): readonly EdgeIntersection[] {
    if (!Number.isFinite(epsilon) || epsilon < 0) {
      throw new RangeError("epsilon must be finite and non-negative");
    }
    if (points.length < 4) {
      return Object.freeze([]);
    }
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new TypeError(`non-finite point at ${index}`);
      }
    }

    const found: EdgeIntersection[] = [];
    const edgeCount = points.length;
    for (let first = 0; first < edgeCount; first += 1) {
      const firstEnd = (first + 1) % edgeCount;
      const a = points[first]!;
      const b = points[firstEnd]!;

      for (let second = first + 1; second < edgeCount; second += 1) {
        const secondEnd = (second + 1) % edgeCount;
        if (
          first === second ||
          first === secondEnd ||
          firstEnd === second ||
          firstEnd === secondEnd
        ) {
          continue;
        }

        const c = points[second]!;
        const d = points[secondEnd]!;
        const firstMinimumX = Math.min(a.x, b.x) - epsilon;
        const firstMaximumX = Math.max(a.x, b.x) + epsilon;
        const firstMinimumY = Math.min(a.y, b.y) - epsilon;
        const firstMaximumY = Math.max(a.y, b.y) + epsilon;
        const secondMinimumX = Math.min(c.x, d.x) - epsilon;
        const secondMaximumX = Math.max(c.x, d.x) + epsilon;
        const secondMinimumY = Math.min(c.y, d.y) - epsilon;
        const secondMaximumY = Math.max(c.y, d.y) + epsilon;
        const boxesOverlap =
          firstMinimumX <= secondMaximumX &&
          firstMaximumX >= secondMinimumX &&
          firstMinimumY <= secondMaximumY &&
          firstMaximumY >= secondMinimumY;
        if (!boxesOverlap) {
          continue;
        }

        const abC = signedTurn(a, b, c);
        const abD = signedTurn(a, b, d);
        const cdA = signedTurn(c, d, a);
        const cdB = signedTurn(c, d, b);

        const properCross =
          abC * abD < -(epsilon * epsilon) && cdA * cdB < -(epsilon * epsilon);
        if (properCross) {
          found.push({ first, second, kind: "cross" });
          continue;
        }

        const touches =
          (Math.abs(abC) <= epsilon && pointOnSegment(c, a, b, epsilon)) ||
          (Math.abs(abD) <= epsilon && pointOnSegment(d, a, b, epsilon)) ||
          (Math.abs(cdA) <= epsilon && pointOnSegment(a, c, d, epsilon)) ||
          (Math.abs(cdB) <= epsilon && pointOnSegment(b, c, d, epsilon));
        if (!touches) {
          continue;
        }

        const collinear =
          Math.abs(abC) <= epsilon &&
          Math.abs(abD) <= epsilon &&
          Math.abs(cdA) <= epsilon &&
          Math.abs(cdB) <= epsilon;
        found.push({
          first,
          second,
          kind: collinear ? "overlap" : "touch",
        });
      }
    }

    found.sort((left, right) => {
      const byFirst = left.first - right.first;
      if (byFirst !== 0) {
        return byFirst;
      }
      return left.second - right.second;
    });
    return Object.freeze(found.map((entry) => Object.freeze(entry)));
  }
}
