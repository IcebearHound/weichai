import { describe, expect, it } from "vitest";
import { parseAction } from "./smoke-proto.js";

describe("parseAction(LLM stdout → SmokeAction)", () => {
  it("解析纯 JSON 工具动作", () => {
    const result = parseAction('{"action":"plan_smoke","params":{"cases":[{"id":"c01","intent":"空输入"}]}}');
    expect(result.action).toEqual({
      action: "plan_smoke",
      params: { cases: [{ id: "c01", intent: "空输入" }] },
    });
  });

  it("容忍 ```json 围栏", () => {
    const result = parseAction('```json\n{"action":"compare","params":{}}\n```');
    expect(result.action).toEqual({ action: "compare", params: {} });
  });

  it("容忍 ``` 围栏(无 json 标记)", () => {
    const result = parseAction('```\n{"action":"finish","params":{"summary":"done"}}\n```');
    expect(result.action).toEqual({ action: "finish", params: { summary: "done" } });
  });

  it("容忍散文前后缀", () => {
    const result = parseAction('I will now compile.\n\n{"action":"compile_runner","params":{"side":"source"}}\n\nDone.');
    expect(result.action).toEqual({ action: "compile_runner", params: { side: "source" } });
  });

  it("多个 JSON 时取第一个合法动作", () => {
    const result = parseAction(
      '{"action":"read_file","params":{"path":"MimeUtility.java"}}\n{"action":"list_files","params":{"path":"."}}',
    );
    expect(result.action).toEqual({ action: "read_file", params: { path: "MimeUtility.java" } });
  });

  it("多行 JSON 含字符串内的花括号也能配对解析", () => {
    const result = parseAction(
      'Thought: need to fix.\n{\n  "action": "propose_target_fix",\n  "params": { "files": [ { "path": "MimeUtility.java", "content": "public class A { public static String f() { return \\"{\\"; } }" } ] }\n}',
    );
    expect(result.action?.action).toBe("propose_target_fix");
    const files = result.action && result.action.action === "propose_target_fix" ? result.action.params.files : [];
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("MimeUtility.java");
  });

  it("空输出 → 解析失败并给出错误描述", () => {
    const result = parseAction("   \n  ");
    expect(result.action).toBeNull();
    expect(result.error).toMatch(/为空/);
  });

  it("非法 JSON → 解析失败并给出错误描述", () => {
    const result = parseAction("这不是 JSON 输出");
    expect(result.action).toBeNull();
    expect(result.error).toMatch(/合法 JSON/);
  });

  it("未知 action → 解析失败", () => {
    const result = parseAction('{"action":"delete_everything","params":{}}');
    expect(result.action).toBeNull();
  });

  it("JSON 缺少 action 字段 → 解析失败", () => {
    const result = parseAction('{"params":{}}');
    expect(result.action).toBeNull();
  });

  it("params 不是对象 → 解析失败", () => {
    const result = parseAction('{"action":"compare","params":"nope"}');
    expect(result.action).toBeNull();
  });

  it("write_runner 校验 side/language/files", () => {
    const good = parseAction(
      '{"action":"write_runner","params":{"side":"target","language":"Java","files":[{"path":"SmokeRunner.java","content":"public class SmokeRunner { public static void main(String[] a) {} }"}]}}',
    );
    expect(good.action?.action).toBe("write_runner");
    expect(parseAction('{"action":"write_runner","params":{"side":"middle","language":"Java","files":[]}}').action).toBeNull();
    expect(parseAction('{"action":"write_runner","params":{"side":"target","language":"Cobol","files":[]}}').action).toBeNull();
    expect(parseAction('{"action":"write_runner","params":{"side":"target","language":"Java","files":[]}}').action).toBeNull();
  });

  it("judge 校验 decision 枚举;sourceIssues 可选", () => {
    const good = parseAction(
      '{"action":"judge","params":{"verdicts":[{"caseId":"c01","decision":"pass","reasoning":"一致"}],"sourceIssues":["源侧疑似缺陷"]}}',
    );
    expect(good.action).toEqual({
      action: "judge",
      params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "一致" }], sourceIssues: ["源侧疑似缺陷"] },
    });
    expect(parseAction('{"action":"judge","params":{"verdicts":[{"caseId":"c01","decision":"maybe","reasoning":""}]}}').action).toBeNull();
    expect(parseAction('{"action":"judge","params":{"verdicts":[]}}').action).toBeNull();
  });

  it("finish 的 verdicts 可选;summary 缺省为空串", () => {
    const bare = parseAction('{"action":"finish","params":{}}');
    expect(bare.action).toEqual({ action: "finish", params: { summary: "" } });
    const full = parseAction('{"action":"finish","params":{"summary":"s","verdicts":[{"caseId":"c01","decision":"pass","reasoning":"r"}]}}');
    expect(full.action).toEqual({
      action: "finish",
      params: { summary: "s", verdicts: [{ caseId: "c01", decision: "pass", reasoning: "r" }] },
    });
  });

  it("compile_runner/run_runner 校验 side", () => {
    expect(parseAction('{"action":"run_runner","params":{"side":"target"}}').action).toEqual({
      action: "run_runner",
      params: { side: "target" },
    });
    expect(parseAction('{"action":"run_runner","params":{"side":"unknown"}}').action).toBeNull();
  });

  it("read_file 要求非空 path", () => {
    expect(parseAction('{"action":"read_file","params":{"path":""}}').action).toBeNull();
    expect(parseAction('{"action":"read_file","params":{"path":"a.java"}}').action).toEqual({
      action: "read_file",
      params: { path: "a.java" },
    });
  });
});
