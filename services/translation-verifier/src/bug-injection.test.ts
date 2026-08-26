import { describe, expect, it } from "vitest";
import { computeDetectionMetrics, injectFineGrainedBug } from "./bug-injection.js";

describe("computeDetectionMetrics", () => {
  it("reports attempted, eligible, and injection failures without using failed injections as the rate denominator", () => {
    const metrics = computeDetectionMetrics([
      { method: "Parser.parse", kind: "off-by-one", baselineDetected: false, aidDetected: true },
      {
        method: "Parser.parse",
        kind: "condition-flip",
        baselineDetected: false,
        aidDetected: false,
        note: "injection-failed:cannot locate method",
      },
      {
        method: "Parser.parse",
        kind: "constant-wrong",
        baselineDetected: false,
        aidDetected: false,
        note: "target-run-failed",
      },
    ]);

    expect(metrics.attempted).toBe(3);
    expect(metrics.eligible).toBe(1);
    expect(metrics.injectionFailed).toBe(1);
    expect(metrics.unverified).toBe(1);
    expect(metrics.baselineDetectionRate).toBe(0);
    expect(metrics.aidDetectionRate).toBe(1);
  });
});

describe("injectFineGrainedBug", () => {
  const NO_MUTATION_POINTS = `public class Parser {
  public static string Parse(string value) {
    return value;
  }
}`;

  it.each(["off-by-one", "condition-flip", "constant-wrong"] as const)("rejects %s when it would be a no-op", (kind) => {
    expect(() => injectFineGrainedBug(NO_MUTATION_POINTS, kind, "Parser", "Parse")).toThrow(/no applicable mutation point/);
  });
});
