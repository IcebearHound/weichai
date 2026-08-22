# translation-verifier(差分翻译验证器)

自动化评估代码翻译的**行为一致性**,并在不一致时通过反馈修复闭环自动收敛。

核心定位:差分验证是**差异探测器而非裁判**——两侧行为不一致不等于目标侧错(可能是源侧历史缺陷),
判定以**用户需求**为准。

## 架构

```
用户需求 ──► 候选检索(上游混合检索服务 /v1/search) ──► 语言无关测试描述(JSON)
              │                                                │
              ▼                                                ▼
        源侧驱动执行(A)  ◄── 描述 ──►  目标侧驱动执行(B)
              │                       (Java/C# 生成器 + javac/dotnet)
              ▼                       │
         ┌────────────────────────────┘
         ▼
    差分一致性检查器(差异探测器)
     ├─ 两侧一致 → PASS
     └─ 不一致 → 需求裁决(requirementVerdict):
         ├─ 目标侧符合需求 → target-conforms(源侧偏离需求,记录后放行)
         └─ 目标侧也偏离 → target-diverges(进入修复闭环)
              │
              ▼
        反馈修复 Agent(claude 子进程)──► 重新翻译 ──► 重新验证(≤3 轮)
```

- **检索与迁移分离**:候选检索由上游混合检索服务 `POST /v1/search` 完成(向量+全文+RRF+rerank);
  agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索。
  本模块只接收整理好的纯输入,不做任何检索/提取。
- **需求第一**:用户需求是最高优先级;源码/测试仅作参考实现,冲突以需求为准,不继承源码缺陷。
- **LLM 调度统一 claude 子进程**("Claude Code + DeepSeek" 架构,与 `scripts/run-claude-deepseek.sh` 一致),
  不直接调用 DeepSeek HTTP API。

## 模块清单

| 模块 | 职责 |
| --- | --- |
| `description.ts` | 语言无关测试描述类型 + 校验 + canonical 规范化 |
| `driver/` | Java / C# 目标驱动，以及 Python / TypeScript 源侧驱动(确定性 JSON 输出) |
| `executor.ts` | javac / dotnet / python3 / tsc+tsx 编译 + 运行(可注入 fake) |
| `comparator.ts` | 差分比较器(数值容差 / 跨语言异常等价类 / 语义集合比较) |
| `verifier.ts` | 双轨道验证编排 + 量化报告 + 需求裁决(`requirementVerdict`) |
| `test-migrator.ts` | 测试迁移 Agent(需求第一,生成语言无关描述) |
| `mitgen/` | MitGen 微观测试生成(片段级):片段划分/排序/定向输入生成/插桩可达性验证/目标侧对应检查 |
| `code-utils.ts` | 轻量源码词法工具(matchingBrace/skipQuoted/escapeRegExp,零依赖) |
| `llm-json.ts` | LLM 输出 JSON 解析(stripFences/extractJson/coerceTypedValue) |
| `repair-loop.ts` | 反馈修复闭环(诊断携带需求判据,≤3 轮) |
| `claude-client.ts` | claude 子进程 LLM 封装(可注入 `spawnClaude`) |
| `logger.ts` | 零依赖日志系统(文件 DEBUG 全量 + 控制台分级;默认写 monorepo 根 `logs/`) |
| `cli.ts` | CLI 编排入口 |
| `e2e/` | E2E 验收脚本 + fixtures(验证机制 / 注入 bug / 修复闭环演示) |

## 快速开始

```bash
# 单元测试
npm run test --workspace @forexplore/translation-verifier

# E2E 验收(无 key:fixture 描述 + 真实 javac/dotnet 验证机制)
DEEPSEEK_API_KEY= npx tsx services/translation-verifier/e2e/run-e2e.ts \
  --requirement "解码 MIME 编码文本,非编码文本原样返回" \
  --source-method services/translation-verifier/e2e/fixtures/samples/mime-util-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/mime-util-target.java \
  --source-lang C# \
  --target-class org.apache.commons.fileupload.util.mime.MimeUtility \
  --target-method decodeText

# E2E 验收(有 key:真实 TestMigrator 生成描述 + 修复闭环)
npx tsx services/translation-verifier/e2e/run-e2e.ts --requirement "..." \
  --source-method ... --target-file ... --source-lang C# \
  --target-class ... --target-method ... --timeout-ms 300000
```

E2E 三阶段:①验证翻译产物(差分 + 需求黄金校验)→ ②注入 bug 演示检出 FAIL → ③修复闭环
(RepairLoop + RepairAgent)收敛。退出码:全部 PASS=0;有 FAIL=1;参数/运行错误=2。

## MitGen(片段级微观测试生成)

`--generator mitgen` 切换描述生成器为 `MitGenMigratorAgent`(与 `TestMigratorAgent` 平级,
输出 schema 兼容 `TestDescription`,verifier/comparator/driver/executor 零改动):

- **片段划分**(`mitgen/fragment-extractor.ts`):把源方法轻量词法分解为 guard/分支/循环/switch-case/return
  等片段(零依赖,Java/C# 优先,Python/TS best-effort),每个片段带 `pathCondition`(通往该片段的路径条件)
  与启发式特征;直线方法/定位失败退化为整方法单片段。
- **片段选择**(`mitgen/fragment-prioritizer.ts`):启发式预筛 + LLM 单次批量打分(CamPri 简化版),
  排序键 = w1·风险 + w2·可修复性 + w3·启发式分(默认 0.5/0.3/0.2,可注入),选 Top-K。
- **片段级生成 + 回射**(`mitgen/mitgen-migrator.ts` + `mitgen/splicer.ts`):对每个选中片段,
  LLM 受 pathCondition 引导生成整方法输入(不需推理输出)→ 在源方法副本的片段位置前插桩 marker
  (`mitgen/splicer.ts` 纯字符串操作,单语句分支自动包块保持语义)→ 用现有 source driver 实跑,
  解析 marker 序列验证可达性并**录制 expected(源侧实跑即 ground truth,规避 LLM 写 expected 不可靠)**;
  不可达输入反馈 LLM 重试 1 次,仍失败丢弃。最后做目标侧片段对应检查(correspondence,只进报告不进 verdict)。
- 预期成本:每方法 LLM 调用 ≈ 1 次打分 + F 次输入生成 + 重试 + 1 次对应检查(F=选中片段数)。

```bash
# MitGen 端到端(需 DEEPSEEK_API_KEY);--branch-bug 追加「分支级 bug 注入 + MitGen 检出」演示
npx tsx services/translation-verifier/e2e/run-e2e.ts --requirement "..." \
  --source-method ... --target-file ... --source-lang C# \
  --target-class ... --target-method ... --generator mitgen --branch-bug --timeout-ms 300000
```

已知限制:片段级 expected 由源侧实跑录制,若源侧实现自身偏离需求(如字符集支持差异),
录制结果会固化源侧行为——与现有管线一致,由 `requirementVerdict` 黄金校验兜底改判;
correspondence 仅进报告,差分结果仍是权威裁判。

## CLI 用法

```bash
npx tsx services/translation-verifier/src/cli.ts \
  --description <描述.json> --source <源目录> --target <目标目录> \
  [--method-file <目标类型相对路径>] [--max-rounds 3] [--json] \
  [--requirement <需求文本>] [--api-key <key>] \
  [--source-module <Python模块或TS相对路径>] [--source-class <类名>] \
  [--source-method <方法名>] [--source-instance]
```

- `--description` / `--source` / `--target` 必填;`--requirement` 缺失时描述须自带(需求第一)。
- 源目录只含一种 `.java`、`.cs`、`.py` 或 `.ts` 时自动识别语言；Python/TypeScript 必须提供
  `--source-module`，类方法再提供 `--source-class`，模块级函数可省略类名。
- `TestDescription.target.language` 仍只支持 Java/C#；Python/TypeScript 是源侧执行适配器，不会改变目标翻译契约。
- 翻译由 agent 在调度时完成,CLI 不做 LLM 调用。

## 语言无关测试描述(schema v1.0)

```jsonc
{
  "schemaVersion": "1.0",
  "requirement": "解码 MIME 编码文本(=?charset?B?..?= 与 =?charset?Q?..?= 形式),非编码文本原样返回",
  "target": {
    "language": "Java",
    "className": "org.apache.commons.fileupload.util.mime.MimeUtility",
    "method": "decodeText",
    "isStatic": true,
    "constructorArgs": []
  },
  "cases": [
    {
      "id": "encoded-b",
      "description": "B 编码 base64 解码",
      "inputs": [{ "type": "string", "value": "=?UTF-8?B?aGVsbG8=?=" }],
      "expected": { "kind": "return", "value": { "type": "string", "value": "hello" } }
    },
    {
      "id": "invalid-input",
      "inputs": [{ "type": "string", "value": "invalid" }],
      "expected": { "kind": "exception", "type": "IllegalArgumentException", "messageContains": "..." }
    }
  ]
}
```

`TypedValue` 支持 `string | number | boolean | null | list | map`(带 `type` 标签,驱动生成确定性字面量)。

## 日志

零依赖(仿 ReCodeAgent):文件 `logs/translation-verifier.log`(DEBUG 全量,追加)+ 控制台按
`VERIFIER_LOG_LEVEL`(默认 INFO)。级别分层:info=阶段/生命周期,debug=prompt 全文/输出,error=异常。
环境变量:`VERIFIER_LOG_DIR`(默认 monorepo 根 `logs/`,与 cwd 无关)、`VERIFIER_LOG_LEVEL`。

## 已知限制

- 真实分支覆盖率(需要 JaCoCo / dotnet-coverage 插桩)尚未接入,报告 `coverage` 字段预留。
- 状态路径(state path)深度支持受限:本期 expected 支持 return / exception;对象内部状态可通过
  getter 以 return 形式断言。
- Java/C# 源侧默认沿用描述中的类名/方法名；Python/TypeScript 可通过源侧参数显式指定模块、类和方法。
- 修复闭环面向 Java 目标方向;无 `DEEPSEEK_API_KEY` 时跳过修复演示。
- `ignoreMessageSubstrings` 当前为预留选项(默认不比较异常消息)。
