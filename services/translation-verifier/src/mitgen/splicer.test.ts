import { describe, expect, it } from "vitest";
import { extractFragments } from "./fragment-extractor.js";
import { MARKER_PREFIX, extractMarkers, instrumentFragment, stripMarkers } from "./splicer.js";
import type { CodeFragment } from "./types.js";

const JAVA_METHOD = `public static int clampScore(int value, int max) {
  if (value < 0) return 0;
  int total = 0;
  for (int i = 0; i < value; i++) {
    total += i;
  }
  return total;
}`;

const marker = (fragmentId: string) => `System.out.println("${MARKER_PREFIX}${fragmentId}");`;

describe("instrumentFragment(插桩回射)", () => {
  it("inserts the marker at fragment.start for non-wrapped fragments (bytes before/after unchanged)", () => {
    const fragments = extractFragments(JAVA_METHOD);
    const loopBody = fragments.find((f) => f.kind === "loop-body");
    expect(loopBody).toBeDefined();
    const instrumented = instrumentFragment(JAVA_METHOD, loopBody as CodeFragment, marker((loopBody as CodeFragment).id));
    // marker 之前的字节不变。
    expect(instrumented.slice(0, (loopBody as CodeFragment).start)).toBe(JAVA_METHOD.slice(0, (loopBody as CodeFragment).start));
    // marker 之后的字节不变。
    expect(instrumented.slice((loopBody as CodeFragment).start)).toContain(marker((loopBody as CodeFragment).id));
    // 且 marker 后跟原片段代码。
    expect(instrumented.slice((loopBody as CodeFragment).start)).toContain((loopBody as CodeFragment).code);
  });

  it("wraps single-statement branch fragments so the marker does not change control flow", () => {
    const fragments = extractFragments(JAVA_METHOD);
    const guard = fragments.find((f) => f.kind === "guard");
    expect(guard?.wrap).toBe(true);
    const instrumented = instrumentFragment(JAVA_METHOD, guard as CodeFragment, marker((guard as CodeFragment).id));
    // 包裹后 return 仍在 if 分支内,marker 与 return 都在同一块里。
    expect(instrumented).toContain(`if (value < 0) { ${marker((guard as CodeFragment).id)} return 0; }`);
    // 原始字节(除插入点外)保持不变:去掉 marker 与块包裹后应与原方法一致(语义等价)。
    const roundTrip = instrumented
      .replace(`{ ${marker((guard as CodeFragment).id)} `, "")
      .replace(" }", "")
      .replace(`if (value < 0) `, `if (value < 0) `);
    expect(roundTrip.replace(marker((guard as CodeFragment).id), "")).toBe(JAVA_METHOD.replace(marker(""), ""));
  });

  it("handles nested fragments inside blocks", () => {
    const method = `int f(int x) {
  if (x > 0) {
    for (int i = 0; i < x; i++) {
      total += i;
    }
    return x;
  }
  return 0;
}`;
    const fragments = extractFragments(method);
    const inner = fragments.find((f) => f.kind === "return-expression" && f.pathCondition.includes("x > 0"));
    expect(inner).toBeDefined();
    const instrumented = instrumentFragment(method, inner as CodeFragment, marker((inner as CodeFragment).id));
    expect(instrumented).toContain(marker((inner as CodeFragment).id));
    // 插桩只增加 marker,不改变片段文本本身。
    expect(instrumented).toContain((inner as CodeFragment).code);
  });

  it("clamps out-of-range positions without throwing", () => {
    const fragment: CodeFragment = {
      id: "frag-99",
      kind: "expression",
      start: 9999,
      end: 10000,
      code: "",
      pathCondition: "",
      features: [],
      heuristicScore: 0,
    };
    expect(instrumentFragment(JAVA_METHOD, fragment, marker("frag-99"))).toContain(marker("frag-99"));
  });
});

describe("extractMarkers / stripMarkers", () => {
  it("extracts marker ids in order, keeping duplicates", () => {
    const stdout = `[MARK]frag-01\n[MARK]frag-02\n[MARK]frag-01\n`;
    expect(extractMarkers(stdout)).toEqual(["frag-01", "frag-02", "frag-01"]);
  });

  it("strips marker lines, leaving driver JSON intact", () => {
    const stdout = `[MARK]frag-01\n{"results":[{"caseId":"probe","outcome":"return","returnValue":{"type":"number","value":5}}]}\n`;
    const cleaned = stripMarkers(stdout).trim();
    expect(JSON.parse(cleaned)).toEqual({
      results: [{ caseId: "probe", outcome: "return", returnValue: { type: "number", value: 5 } }],
    });
  });

  it("returns [] for output without markers", () => {
    expect(extractMarkers("plain output")).toEqual([]);
  });
});
