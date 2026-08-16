# translation-verifier E2E 验收脚本

本目录实现 translation-verifier 的端到端验收脚本(`run-e2e.ts`),作为「检索 → 迁移 → 验证」数据流的
验收机制:验证器只负责接收整理好的纯输入并做**差分验证**(差异探测器),检索/定位与翻译由 agent 完成。

## 架构(数据流)

```text
                        ┌───────────── agent 阶段(脚本不参与) ─────────────┐
用户需求 ──► 候选检索(混合检索服务 /v1/search) ──► 完整方法体(source-method)   │
                                   └─► 相关测试(source-tests,仅参考)          │
                                   └─► Java 翻译产物(target-file,agent 翻译)   │
                        └───────────────────────────────────────────────────┘
                                        │(纯输入)
                                        ▼
                       ┌─────────────────────────────────────────────────┐
                       │              e2e/run-e2e.ts(本脚本)               │
                       │ 1. 描述生成:有 key → TestMigratorAgent(claude     │
                       │    子进程,需求第一);无 key → --fixture 手写描述    │
                       │ 2. 双侧驱动生成(C# 源侧 / Java 目标侧)             │
                       │ 3. verify(RealDriverExecutor:javac / dotnet)     │
                       │    = 差分比较 + 需求黄金校验(requirementVerdict)    │
                       │ 4. 注入 bug 演示:替换方法体 → 断言检出 FAIL          │
                       │ 5. 修复闭环演示(有 key):RepairLoop + RepairAgent   │
                       └─────────────────────────────────────────────────┘
                                        │
                                        ▼
                          日志(logs/translation-verifier.log,全程可回放)
```

要点:

- **检索不内嵌**:脚本不按方法名/关键词检索语料。候选检索由上游混合检索服务 POST /v1/search 完成(返回 SearchCandidate,agent 按 path 读完整方法体);测试自寻(测试不在索引)由 agent 在同仓库内文件搜索。脚本只接收整理好的完整方法体文件与目标翻译产物。
- **翻译由 agent 完成**:脚本接收 Java 目标文件(`--target-file`)作为输入,不做 LLM 翻译调用。
- **描述生成**:有 `DEEPSEEK_API_KEY` 时用 TestMigratorAgent(claude 子进程,需求第一,源码仅参考);
  无 key 时用 `--fixture`(手写语言无关描述 JSON)保证离线可跑通。
- **验证机制**:双侧真实工具链(javac / dotnet)编译并运行生成的 driver,产出 JSON 结果后差分比较;
  并用描述声明的 expected(需求黄金值)做需求裁决,产出 `requirementVerdict`。
- **全程日志**:`createLogger("e2e")` 记录各阶段;修复闭环每轮验证结果 info、诊断 debug、异常 error。
  日志文件默认 `logs/translation-verifier.log`(可用 `VERIFIER_LOG_DIR` 覆盖)。

## 用法

### 无 key 路径(离线,fixture 描述 + 真实工具链验证 + 注入 bug 检出 FAIL)

```bash
cd /Users/origin/main/projects/monorepo/weichai

# 默认样例:MimeUtility.DecodeText(C# → Java)
npx tsx services/translation-verifier/e2e/run-e2e.ts \
  --requirement "解码 MIME 编码文本(如 =?UTF-8?B?...?= 的 base64 或 =?UTF-8?Q?...?= 的 quoted-printable 形式),非编码文本原样返回;编码格式非法或输入为 null 时抛异常" \
  --source-method services/translation-verifier/e2e/fixtures/samples/mime-util-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/mime-util-target.java

# Base64Decoder.Decode(string → byte[]) 样例
npx tsx services/translation-verifier/e2e/run-e2e.ts \
  --requirement "base64 字符串解码为字节数组(string → byte[])" \
  --source-method services/translation-verifier/e2e/fixtures/samples/base64-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/base64-target.java \
  --fixture services/translation-verifier/e2e/fixtures/base64-description.json
```

无 key 时脚本输出:阶段 A 验证报告(全 PASS)→ 阶段 B 注入 bug 检出 FAIL(演示符合预期)→
「跳过修复演示:未提供 DEEPSEEK_API_KEY」,退出码 0。

### 有 key 路径(真实 TestMigratorAgent + RepairAgent)

```bash
# 使用环境变量 DEEPSEEK_API_KEY(描述生成 + 修复闭环)
DEEPSEEK_API_KEY=sk-xxx npx tsx services/translation-verifier/e2e/run-e2e.ts \
  --requirement "解码 MIME 编码文本(如 =?UTF-8?B?...?=),非编码文本原样返回" \
  --source-method services/translation-verifier/e2e/fixtures/samples/mime-util-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/mime-util-target.java

# 或用 --api-key 显式传(优先级高于环境变量);--max-rounds 控制修复轮数
npx tsx services/translation-verifier/e2e/run-e2e.ts --api-key sk-xxx --max-rounds 3 \
  --requirement "..." --source-method .../mime-util-source.cs --target-file .../mime-util-target.java
```

有 key 时脚本额外执行阶段 C:修复闭环演示(RepairLoop + RepairAgent,最多 `--max-rounds` 轮,
每轮验证结果记 info 日志),最终报告全 PASS 退出码 0,修复后仍 FAIL 退出码 1。

### npm scripts

```bash
npm run e2e --workspace @forexplore/translation-verifier   # workspace 内默认(需先 cd 到 workspace 或用 -- 传参)
npm run e2e                                                # 根 package.json 的 e2e(等价于上面)
```

## 参数表

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--requirement <text>` | 是 | - | 用户需求(需求第一;描述 requirement 为空时挂载) |
| `--source-method <path>` | 是 | - | 源语言完整方法体文件(agent 整理,单类文件) |
| `--source-tests <path>` | 否 | - | 相关测试文件(仅作参考,不进入源侧编译) |
| `--target-file <path>` | 是 | - | Java 翻译产物文件(agent 提供) |
| `--source-lang <Java\|C#>` | 否 | `C#` | 源语言 |
| `--fixture <path>` | 否 | `e2e/fixtures/mime-util-description.json` | 无 key 时的描述 JSON |
| `--api-key <key>` | 否 | `DEEPSEEK_API_KEY` | 描述生成/修复闭环的 API Key |
| `--target-class <name>` | 否 | 从描述或目标文件解析 | 目标类全限定名(如 `org.apache.commons.fileupload.util.mime.MimeUtility`) |
| `--target-method <name>` | 否 | 从描述或目标文件解析 | 目标方法名(如 `decodeText`) |
| `--max-rounds <n>` | 否 | `3` | 修复闭环最大轮数 |
| `--timeout-ms <ms>` | 否 | `300000` | LLM 调用(claude 子进程)超时,毫秒 |
| `--json` | 否 | - | 输出最终报告为 JSON |

> 目标类名/方法名由调用方(agent)显式给出(`--target-class`/`--target-method`);
> 缺省时从描述 fixture 或目标文件的 public class/方法**声明行**解析(仅声明行,不算检索)。
> 源侧类名/方法名从 source-method 文件的 class/方法声明行解析(如 C# `DecodeText` vs Java `decodeText`)。

## fixtures 说明

| 文件 | 内容 |
| --- | --- |
| `fixtures/mime-util-description.json` | MimeUtility.DecodeText 的语言无关描述:base64 / quoted-printable 解码、非编码原样返回、格式非法原样返回、null 抛异常(NRE/NPE 等价) |
| `fixtures/base64-description.json` | Base64Decoder.Decode(string → byte[]) 的语言无关描述:空串、ASCII、二进制、中文 UTF-8 字节 |
| `fixtures/samples/mime-util-source.cs` | 从 `fixtures/code-corpus/commons-fileupload-csharp/src/Commons/FileUpload/Util/Utilities.cs` 提取的 MimeUtility 完整方法体(含依赖的 QuotedPrintableDecoder),agent 整理后的样例输入 |
| `fixtures/samples/mime-util-target.java` | 对应的 Java 翻译产物样例(行为镜像:null 无防护、非 MIME 文本原样返回) |
| `fixtures/samples/base64-source.cs` | Base64Decoder.Decode 完整方法体样例输入 |
| `fixtures/samples/base64-target.java` | 对应 Java 翻译产物样例 |

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部验收 PASS:真实翻译产物验证全 PASS、注入 bug 被检出、修复闭环收敛(有 key) |
| `1` | 验收 FAIL:翻译产物与源侧有差异 / 注入 bug 未被检出(差分机制失效)/ 修复后仍 FAIL |
| `2` | 参数或运行错误(缺参、文件不可读、工具链缺失、LLM 调用失败等) |

## 已知限制

- **翻译由 agent 完成**:本脚本不执行 LLM 翻译,`--target-file` 必须由调用方(agent)先翻译好;
  描述生成与修复闭环的 LLM 调用走 claude 子进程("Claude Code + DeepSeek" 架构)。
- **差分验证是差异探测器,不是裁判**:`pass` 表示两侧行为一致 + 目标侧符合声明期望(需求黄金值);
  两侧都不一致且目标侧符合期望时 verdict 为 `fail` 但 `requirementVerdict=target-conforms`
  (差异源于源侧),需结合需求原文人工裁决。
- **源侧方法体依赖需随文件提供**:C# 源方法引用的辅助类(如 QuotedPrintableDecoder)必须包含在
  source-method 文件中,否则源侧无法编译。
- **修复产物依赖 LLM 输出质量**:RepairAgent 输出被机械补全 package 声明以对齐全限定名驱动调用;
  若输出改变了类名/签名,编译失败会在下一轮被检出,最多 `--max-rounds` 轮。
- **commons-fileupload-csharp 测试参考价值有限**:该仓库测试只有 `tests/Program.cs`(覆盖
  multipart/阈值落盘等,不覆盖 MimeUtility),描述主要依据方法体 + 需求,如实说明。
