# 差分翻译验证器(行为一致性评估 + 自动修复闭环)设计文档

> 日期:2026-08-16
> 分支:`feat/differential-translation-verifier`
> 状态:已授权实施(用户明确指示"直到完成任务之前,不要询问我")

## 1. 背景与问题

当前 `services/adaptation-service` 的翻译流程只做**编译级验证**(javac / dotnet build),
其 `behavioral-semantics` 校验项明确标注 `unverified`:

> "当前仅包含编译验证;尚未证明业务行为、并发、超时或取消语义正确。"

翻译结果可能编译通过但行为与源不一致。本计划构建一个**行为一致性评估与自动修复闭环**:

```
源方法 + 源测试 ──► 语言无关测试描述 ──► 双轨道驱动执行(A=源, B=翻译后)
                                          │
                                          ▼
                              差分一致性检查器 ──通过──► 交付 + 量化报告
                                          │
                                          ▼ 失败
                              反馈修复 Agent ──重新翻译──► 重新验证(闭环)
```

## 2. 设计依据(调研结论)

- **差分测试(differential testing)**:同一输入驱动多个实现,比较输出差异
  (Wikipedia; Xie & Marinov "Towards a Framework for Differential Unit Testing of OO Programs", 2007)。
- **RepoMod-Bench**(arXiv 2602.22518):仓库级代码现代化基准,核心是 **implementation-agnostic testing**
  ——测试只通过语言无关接口(CLI stdin/stdout、REST JSON)驱动实现,同一套测试验证任意目标语言版本;
  指标 = Build Success + Pass Rate;并做多轮 agent 迭代修复。
- **Kaizen**(arXiv 2607.04058):LLM 翻译 HPC 代码的差分测试框架,对比误差用 L1/L2/Max 范数 + 阈值。
- **用户提到的"序列化/反序列化比较"**:即 characterization testing(golden-master)思路
  ——把输入、输出、异常序列化为语言无关数据,再逐 case 比较。

**结论**:以"语言无关测试描述(JSON)+ 每侧原生驱动程序 + 规范化序列化输出 + 语义比较器"为核心,
这是可构建、可测试、可扩展的方案。真实分支覆盖率(需要 JaCoCo / dotnet-coverage 插桩)超出本期范围,
报告 schema 预留 coverage 字段,并在文档中明确为后续工作。

## 3. 范围界定

**本期(in scope)**:

- 新 workspace `services/translation-verifier`(TypeScript + vitest,复用 monorepo 基础设施)。
- 语言无关测试描述 schema v1.0(输入/输出/异常,类型标注)。
- Driver 代码生成器:Java 与 C# 两侧(与当前翻译模块支持的方向一致);架构可扩展其他语言。
- 双轨道执行器:javac / dotnet 编译 + 子进程运行,可注入 fake(单元测试不依赖本机工具链)。
- 差分比较器:数值容差、跨语言异常类型映射、集合顺序策略、字符串规范化。
- 验证编排器:源侧执行 vs 目标侧执行 → 逐 case 判定(PASS / FAIL / DIVERGENT)→ 量化报告。
- 测试迁移 Agent:DeepSeek 从源方法(+ 可选现有测试)生成语言无关描述。
- 修复闭环:失败 case 的诊断反馈 → LLM 重新翻译 → 重新编译 → 重新验证,最多 N 轮。
- CLI 编排入口(单方法 benchmark 流程)。
- E2E 验收:commons-fileupload-csharp 纯函数方法(C# 源)→ `translateToJava` → 差分验证。
- 若真实链路(DeepSeek API / javac / dotnet)暴露出 adaptation-service 缺陷,修复它并补测试。

**不在本期(out of scope,文档记录)**:

- 真实分支覆盖率插桩(JaCoCo / dotnet-coverage)。
- Python / Go / Rust / TS 侧的 driver(仅 Java/C#;描述格式语言无关,后续可扩展)。
- 状态路径(state path)的深度支持:本期 expected 支持 return / exception;对象内部状态通过
  额外 getter 调用以 return 形式断言(描述格式已预留 `stateChecks`,本期不实现)。

## 4. 架构与组件

```
services/translation-verifier/
├── package.json / tsconfig.json / README.md / .env.example
└── src/
    ├── index.ts                     # 公共导出
    ├── description.ts               # TestDescription 类型 + 运行时校验
    ├── result-capture.ts            # CaseResult 模型 + 规范化 JSON 序列化
    ├── comparator.ts                # 差分比较器(语义比较)
    ├── driver/
    │   ├── driver-codegen.ts        # 按语言分派生成驱动源码
    │   ├── java-driver.ts           # Java 驱动生成(CaseRunner + 输入字面量嵌入)
    │   └── csharp-driver.ts         # C# 驱动生成
    ├── executor.ts                  # 编译 + 执行适配器(子进程,可注入)
    ├── verifier.ts                  # 编排:双轨道执行 → 比较 → 报告
    ├── test-migrator.ts             # 测试迁移 Agent(DeepSeek)
    ├── repair-loop.ts               # 修复闭环(失败诊断 → 重译 → 重验)
    └── cli.ts                       # CLI 编排入口
```

### 4.1 语言无关测试描述(description.ts)

```jsonc
{
  "schemaVersion": "1.0",
  "target": {
    "language": "Java" | "C#",
    "className": "org.apache.commons.fileupload.util.mime.MimeUtility",
    "method": "decodeText",
    "isStatic": true,
    "constructorArgs": []           // 实例方法时用于构造宿主对象(typed values)
  },
  "cases": [
    {
      "id": "mime-decode-plain",
      "description": "非编码文本原样返回",
      "inputs": [
        { "type": "string", "value": "hello" }
      ],
      "expected": {
        "kind": "return",
        "value": { "type": "string", "value": "hello" }
      }
    },
    {
      "id": "mime-decode-encoded",
      "inputs": [ { "type": "string", "value": "=?UTF-8?B?aGVsbG8=?=" } ],
      "expected": { "kind": "return", "value": { "type": "string", "value": "hello" } }
    },
    {
      "id": "parse-invalid",
      "inputs": [ { "type": "string", "value": "broken" } ],
      "expected": { "kind": "exception", "type": "ParseException",
                    "messageContains": "unterminated" }
    }
  ]
}
```

`TypedValue` 支持 `string | number | boolean | null | list | map`,统一带 `type` 标签,
使驱动生成器能做确定性的字面量映射(见 4.3)。

### 4.2 执行结果捕获(result-capture.ts)

每侧驱动把每个 case 的执行结果规范化为 JSON 输出:

```jsonc
{
  "results": [
    { "caseId": "mime-decode-plain", "outcome": "return",
      "returnValue": { "type": "string", "value": "hello" } },
    { "caseId": "parse-invalid", "outcome": "exception",
      "exceptionType": "ParseException", "exceptionMessage": "..." }
  ]
}
```

捕获内容 = 返回值 / 异常类型与消息(**与用户计划的"返回值、抛出的异常及内部状态更新"对应**,
状态更新部分见 3 中说明)。序列化带深度/大小上限,防止无限递归。

### 4.3 Driver 生成(driver/java-driver.ts, driver/csharp-driver.ts)

**设计选择:输入以原生字面量嵌入驱动源码,输出用手写微型 JSON writer。**
这样 Java / C# 侧无需任何 JSON 解析依赖(两个平台 stdlib 都没有 JSON),同时保持输出格式
统一可比较。生成的驱动是确定性代码:同一描述 → 同一源码(可测试、可审阅)。

Java 驱动形态(每个 case 一个方法,`CaseRunner` 运行时负责结果序列化):

```java
public class Driver_<hash> {
  public static void main(String[] args) throws Exception {
    JsonWriter out = new JsonWriter(System.out);
    out.beginObject(); out.name("results"); out.beginArray();
    case_001(out);
    // ...
    out.endArray(); out.endObject(); out.flush();
  }
  static void case_001(JsonWriter out) throws Exception {
    out.beginObject(); out.name("caseId").value("mime-decode-plain");
    try {
      Object r = org.apache.commons...MimeUtility.decodeText("hello");  // 静态/实例调用
      out.name("outcome").value("return");
      out.name("returnValue"); writeValue(out, r);
    } catch (Throwable t) {
      out.name("outcome").value("exception");
      out.name("exceptionType").value(t.getClass().getSimpleName());
      out.name("exceptionMessage").value(t.getMessage() == null ? "" : t.getMessage());
    }
    out.endObject();
  }
}
```

类型字面量映射规则(确定性,带测试):
- string → 双引号转义(含 `\n`、`\"`、Unicode)
- number → 十进制字面量(整数/浮点)
- boolean → `true`/`false`;null → `null`
- list → Java `List.of(...)` / C# `new List<T>{...}`(C# 生成时附最小运行时 stub 以支持旧版本)
- map → Java `Map.of(...)` / C# `new Dictionary<K,V>{...}`

C# 侧同样形态:生成 `Driver_<hash>.cs`,内嵌微型 `JsonWriter`,直接引用目标类型。
由于 C# 的 `List<T>`/`Dictionary<K,V>` 泛型需要显式类型参数,list/map 字面量生成
附一个通用 `JsonValues` 运行时 helper(嵌入驱动文件),从类型标签推导强类型构造。

### 4.4 执行器(executor.ts)

```ts
interface DriverExecutor {
  compile(input: { language: "Java" | "C#"; driverSource: string; projectRoot?: string })
    : Promise<CompileOutcome>;      // success / errors
  run(input: { language: "Java" | "C#"; projectRoot?: string })
    : Promise<{ stdout: string; exitCode: number }>;
}
```

- Java:javac 编译(复用/参照 adaptation-service 的 standalone wrapper 模式,driver 与目标类型
  源文件一起放入临时目录编译);`java -cp <dir> Driver_<hash>` 运行。
- C#:dotnet 编译(临时 csproj + driver + 目标源文件);`dotnet run --no-build` 运行。
- 编译失败 → 该侧所有 case 记为 DIVERGENT(无法执行),错误信息进报告。
- 提供 `FakeDriverExecutor` 用于单元测试;真实实现走 `child_process`。

### 4.5 差分比较器(comparator.ts)

```ts
interface ComparisonOptions {
  numericTolerance?: number;                       // 0 = 精确;>0 = 绝对容差
  numericRelativeTolerance?: number;               // 可选相对容差
  ignoreMessageSubstrings?: string[];              // 异常消息中可忽略的片段
  caseSensitiveStrings?: boolean;                  // 默认 true
}
```

比较规则(全部可单测):
1. 两侧同为 return:递归比较 typed value;number 用容差;list 按序比较;map 键集相等 + 逐值比较。
2. 两侧同为 exception:异常类型经映射表归一化后相等(或类型相同)即视为类型一致;
   若给出 `messageContains`,检查目标异常消息包含该片段(源侧无需匹配消息)。
3. 一侧 return 一侧 exception → DIVERGENT。
4. NaN / Infinity:两侧同时 NaN/Infinity 视为一致(可选开关)。
5. 跨语言异常映射表(默认内置):
   `IllegalArgumentException ↔ ArgumentException`、`NullPointerException ↔ NullReferenceException`、
   `IllegalStateException ↔ InvalidOperationException`、`IndexOutOfBoundsException ↔ ArgumentOutOfRangeException`、
   `UnsupportedOperationException ↔ NotSupportedException`、`ParseException ↔ ParseException` 等。

### 4.6 验证编排器(verifier.ts)

```ts
interface VerificationJob {
  description: TestDescription;
  source: SideSpec;      // { language; driverSource; projectRoot? }
  target: SideSpec;      // { language; driverSource; projectRoot? }
}
interface VerificationReport {
  schemaVersion: "1.0";
  source: SideRunInfo;   // compile/run 状态 + 捕获的 results
  target: SideRunInfo;
  comparisons: CaseComparison[];   // 每 case: verdict + A/B 结果 + 差异说明
  passRate: number;               // PASS / 总 case
  coverage?: CoverageInfo;        // 预留(本期不填)
}
```

**判定语义(需求第一,差分验证是差异探测器而非裁判):**

- `pass`(两侧一致):仍可信,标记为已验证行为一致。
- `fail`(两侧不一致):**不直接等于目标侧错** —— 可能是源侧 bug/历史局限、目标侧翻译错误、或两者各有取舍。
  此时必须结合需求裁决。
- **需求裁决字段**:`CaseComparison.requirementVerdict?: "target-conforms" | "target-diverges"`。
  当两侧不一致时,用描述中声明的 expected(由需求派生的黄金值)校验目标侧:
  - 目标侧符合需求(expected)且源侧不符 → `requirementVerdict: "target-conforms"`,
    details 注明 "target matches declared requirement; divergence is source-side"。
    该 case 在报告中表达为"两侧不一致,但目标侧符合需求"——后续 AI 审查层以此为准,
    与需求冲突时以需求优先,判定目标侧正确并记录后放行。
  - 目标侧也不符合需求 → `requirementVerdict: "target-diverges"`,
    details 注明目标侧与需求的具体偏差。
  - 描述未声明 expected(纯差分模式)→ 不产生 requirementVerdict,保持纯差异探测。
- 该字段在 verifier 黄金校验环节计算(目标侧与 expected 的比对复用 `validateAgainstExpected`)。

### 4.7 测试迁移 Agent(test-migrator.ts)

复用 adaptation-service 导出的 `completeWithDeepSeek`(deepseek-v4-flash,jsonMode)。

**两阶段:检索与迁移分离。**

1. **检索阶段(agent 驱动,脚本不硬抠方法名)**:基于**用户需求**,由 agent 使用
   代码检索工具(rg/find/read)在代码库中检索相关方法、测试、文档,输出**候选集合**
   (方法源码 + 相关测试 + 相关文档)。agent 判断相关性;脚本不按方法名硬抠(历史代码库中
   方法可能重载、测试分散多文件、常带 mock/fixture)。
2. **迁移阶段(TestMigratorAgent)**:输入 = 需求(第一优先级)+ 候选集合(参考实现),
   输出 = TestDescription JSON。

**需求第一原则**:

- `MigrationInput.requirement` 为**必填**核心输入(不再 optional)。
- `buildMigrationPrompt` 中 REQUIREMENT 段放在最前面;源码/测试段随后并标注为参考。
- `MIGRATOR_SYSTEM_PROMPT` 规则重写:
  - 删除 "do not invent behavior not present in the source" 这类以源码为准的规则;
  - 新规则:用户需求是最高优先级;源码/测试仅作参考实现,帮助理解逻辑;当源码行为与需求冲突时,
    以需求为准,并在产出的 case 描述中标注该冲突;不要继承源码的缺陷(忽略空白字符、边界错误、
    历史怪癖)。

**校验**:LLM 输出经 `validateDescription` 严格校验,不合格则重试(最多 2 次)后失败。
单元测试用注入的 fake fetch;真实调用只出现在 e2e。

### 4.8 修复闭环(repair-loop.ts)

```
verify ── 有 FAIL/DIVERGENT case ──► 构建诊断反馈 ──► LLM 重译(携带差分诊断)
   ▲                                             │
   └────────── 重新编译 + 重新 verify ◄──────────┘        (最多 maxRounds 轮)
```

- 诊断反馈内容(与用户计划一致):失败输入、源侧结果 A、目标侧结果 B、差异详情、编译错误。
  另附需求原文与 `requirementVerdict`(目标侧是否符合需求)——修复 Agent 以需求为准,
  仅当目标侧偏离需求时才需要修复;若两侧不一致但目标侧已符合需求,该差异不进入修复目标。
- Java 目标方向:verifier 内 `RepairAgent`(prompt 结构与 translateToJava 对齐 + 差分诊断 +
  需求判据),经 `completeWithDeepSeek` 生成新方法代码。
- C# 目标方向:复用 adaptation-service 的 `repairTranslation`(已有结构化反馈入口)。
- 每轮结束记录:轮次、修复后通过率、仍在失败的 case。
- 收敛条件:全部 PASS(含 target-conforms 视为通过)或达到 maxRounds(默认 3)。

### 4.9 CLI(cli.ts)

`npx tsx src/cli.ts <description.json> <sourceDir> <targetDir>`:
源侧驱动 ← 描述(源语言);目标侧驱动 ← 描述(目标语言)+ 翻译后的方法代码;
执行 verify → 打印报告 → 若有失败且给出修复器则运行修复闭环 → 输出最终报告。

## 5. 与现有代码的关系

| 复用 | 来源 | 方式 |
| --- | --- | --- |
| `completeWithDeepSeek` / `DeepSeekMessage` | adaptation-service | import(workspace 依赖) |
| `translateToJava` / `repairTranslation` | adaptation-service | import |
| `compileJavaStandalone` 等的 wrapper 模式 | adaptation-service | 参照模式,verifier 内自实现(执行模型不同:需要运行而不仅是编译) |
| `@forexplore/contracts` 的 `Language` 等类型 | packages/contracts | import |

依赖声明:`@forexplore/translation-verifier` 依赖 `@forexplore/adaptation-service` 与
`@forexplore/contracts`,并加入根 package.json workspaces(自动)与 test 脚本。

## 6. 全局约束(计划与实现必须遵守)

1. 所有新功能 TDD:先写失败测试,再实现;每个功能的 commit 单独且可运行。
2. 分支 `feat/differential-translation-verifier`,不 push,不 merge 到 main。
3. Driver 生成必须确定性:相同输入 → 字节级相同源码(测试断言)。
4. 测试描述 schemaVersion 固定 `"1.0"`;输出报告 schemaVersion 固定 `"1.0"`。
5. 执行结果序列化带深度/大小上限,禁止无限递归。
6. 不修改 `fixtures/code-corpus/*` 与 `fixtures/target-system/*` 的内容(只读使用)。
7. 单元测试不依赖本机 javac/dotnet(注入 fake executor);e2e 测试在真实工具链上跑,失败可跳过(skip if unavailable)。
8. 中文注释允许;README 与文档用中文(遵循仓库 AGENTS.md)。
9. 语言:TypeScript;测试:vitest;格式与 monorepo 一致。
10. 异常映射表、比较选项等常量集中定义,禁止散落 magic string。

## 7. 度量与报告

- 每 case 判定:PASS / FAIL(两侧都跑通但结果不一致)/ DIVERGENT(某侧编译或执行失败)。
- 报告:`passRate = PASS cases / total cases`,附每 case 的 A/B 结果与差异详情。
- coverage 字段预留(真实分支覆盖率需 JaCoCo / dotnet-coverage,列为后续工作)。

## 8. 验收标准

1. 全部单元测试通过(verifier workspace 内 + 既有 adaptation-service 测试不回归)。
2. E2E:对 commons-fileupload-csharp 的 `MimeUtility.DecodeText` / `Base64Decoder.Decode`
   (C# 源)→ translateToJava → Java 目标,差分验证给出通过率与逐 case 报告;
   人为注入一个错误翻译时,报告能检出 FAIL 并(若配置修复器)在有限轮内收敛或记录残留失败。
3. 修复闭环对可修复案例有效(以注入 bug 的 case 演示)。
