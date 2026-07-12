# 跨语言代码检索合成基准工程 Review 报告

- 审查日期：2026-07-13
- 审查范围：`fixtures/target-system/`、`fixtures/code-corpus/`、`fixtures/benchmark/`
- 审查方式：静态结构审查、清单交叉校验、JSON/JSONL 解析、构建与测试命令实跑、候选行为抽查、重复度与答案泄漏检查
- 结论：**通过，无阻断项**

## 1. 执行摘要

本次产出满足“目标工程、跨语言检索语料、检索标准答案、可执行验证”四部分要求。

关键结论如下：

- TypeScript 目标工程达到规模边界：60 个源码文件、8,341 行有效源码、18 个 class、80 个 function/method。
- 5 个目标均保留完整签名、调用方和领域类型，且仅核心实现抛出 `NotImplementedError`；工程仍可正常 build、lint 和运行普通单元测试。
- 5 个目标共配置 20 个 acceptance 测试，覆盖正常、边界、失败、并发四类场景；当前 20 个均因待实现核心主动失败，符合基准工程预期。
- 检索语料包含 12 个独立模拟仓库，语言分布为 TypeScript 3、Python 3、Java 2、Go 2、Rust 2。
- 语料共 62,168 行有效代码、794 个生产 class/function，位于要求的 60,000～100,000 行与 500～800 个符号区间内。
- `tasks.jsonl` 含 5 个任务；`relevance.jsonl` 含 90 条关系记录，每个任务恰好包含 2 个 high、4 个 medium、2 个 low、10 个 distractor。
- 完整验证命令 `python -B fixtures/benchmark/validate.py --run-commands` 返回 `PASS`，错误列表为空。
- `workspace/forexplore` 没有变更；未执行 Git commit 或 push。

## 2. 需求符合性矩阵

| 检查项 | 要求 | 实际结果 | 结论 |
|---|---:|---:|---|
| 目标工程源码文件 | 40～60 | 60 | 通过 |
| 目标工程有效源码 | 8,000～12,000 行 | 8,341 行 | 通过 |
| 目标工程 class | 12～18 | 18 | 通过 |
| 目标工程 function/method | 50～80 | 80 | 通过 |
| 目标工程分层 | domain/application/infrastructure/services | 四层齐全 | 通过 |
| 待实现目标 | 5 | 5 | 通过 |
| 普通单元测试 | 必须通过 | 15/15 通过 | 通过 |
| Acceptance 测试 | 至少一个因未实现失败 | 0/20 通过，20 个按预期失败 | 通过 |
| 模拟仓库 | 12 | 12 | 通过 |
| 语料语言 | TS 3、Py 3、Java 2、Go 2、Rust 2 | 完全一致 | 通过 |
| 语料有效代码 | 60,000～100,000 行 | 62,168 行 | 通过 |
| 语料生产符号 | 500～800 | 794 | 通过 |
| 每目标 high 候选 | 2 | 2 | 通过 |
| 每目标部分相关候选 | 3～5 | 4 个 medium，另有 2 个 low | 通过 |
| 每目标干扰候选 | 至少 10 | 10 | 通过 |
| JSON/JSONL | 可解析 | 全部解析成功 | 通过 |
| 完整验证脚本 | 可运行并报告 | PASS，0 errors | 通过 |

## 3. 目标工程审查

目标工程位于 `fixtures/target-system/currency-platform`。

### 3.1 结构与工程命令

工程采用 TypeScript，并按以下职责组织：

- `domain`：货币、报价、交易、结算、审计等领域模型与契约。
- `application`：5 个待实现用例及其应用编排。
- `infrastructure`：Provider、持久化、消息、时钟等基础设施适配。
- `services`：控制器、worker、生命周期协调等调用入口。

以下命令均已实跑：

| 命令 | 结果 |
|---|---|
| `npm install` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 15/15 通过 |
| `npm run lint` | 通过 |
| `npm run test:acceptance` | 20/20 按预期失败 |
| `npm run verify` | 通过结构、规模和待实现点检查 |

### 3.2 五个待实现目标

| 目标 | 文件 | 保留的不可变接口 | 待实现行为 |
|---|---|---|---|
| 报价获取 | `src/application/quotes/rate-quote-service.ts` | `QuoteRequest -> Promise<Quote>` | 5 秒 TTL、同货币对并发合并、Provider 超时、失败返回 stale |
| 批量结算 | `src/application/settlement/settlement-service.ts` | 批量输入输出契约 | 幂等键、部分失败重试、Receipt 唯一、输入顺序稳定 |
| Provider 路由 | `src/application/providers/provider-router.ts` | 现有 fetch 契约 | 独立熔断、主备切换、半开恢复、按 Provider 独立状态 |
| 交易事件消费 | `src/application/trades/trade-event-consumer.ts` | 现有消息消费契约 | 去重、账户内有序、账户间并行、失败不误确认 |
| 审计缓冲刷盘 | `src/application/audit/audit-log-buffer.ts` | 现有缓冲与生命周期契约 | 阈值/定时落盘、并发安全、关闭前 drain |

5 个 `NotImplementedError` 的位置与目标一一对应：

- `src/application/audit/audit-log-buffer.ts:116`
- `src/application/providers/provider-router.ts:64`
- `src/application/quotes/rate-quote-service.ts:44`
- `src/application/settlement/settlement-service.ts:68`
- `src/application/trades/trade-event-consumer.ts:58`

没有在其他位置发现额外的 `NotImplementedError`。调用链也保持完整，主要入口包括：

- 报价调用方：`src/services/quote-controller.ts:58`
- 结算调用方：`src/services/settlement-controller.ts:123`
- Provider 调用编排：`src/application/providers/provider-router.ts:59`
- 交易事件 worker：`src/services/trade-worker.ts:39`
- 审计 flush/close 调用链：`src/application/audit/audit-log-buffer.ts:101`、`:108`、`:125`

### 3.3 测试设计

Acceptance 层按目标拆为 5 个测试文件、共 20 个测试。每个目标均包含：

1. 正常路径；
2. 边界条件；
3. 依赖失败或错误传播；
4. 并发语义。

普通单元测试与 acceptance 测试分离，因此当前状态能够同时满足：

- 工程可编译、普通测试可通过；
- 待实现行为不会被伪实现掩盖；
- 完成目标后可直接用 acceptance 测试验收，不能通过修改测试绕过功能要求。

## 4. 检索代码仓库审查

### 4.1 总体统计

| 指标 | 数量 |
|---|---:|
| 仓库 | 12 |
| 全部文件 | 340 |
| 生产源码文件 | 157 |
| 测试文件 | 124 |
| 生产源码有效行 | 34,191 |
| 测试代码有效行 | 27,977 |
| 总有效代码行 | 62,168 |
| 生产 class/function | 794 |

语言分布：

| 语言 | 仓库数 |
|---|---:|
| TypeScript | 3 |
| Python | 3 |
| Java | 2 |
| Go | 2 |
| Rust | 2 |

### 4.2 分仓库统计

| 仓库 | 语言 | 文件 | 生产/测试源码文件 | 生产/测试 LOC | 总 LOC | 符号 |
|---|---|---:|---:|---:|---:|---:|
| `account-stream-rs` | Rust | 20 | 9 / 6 | 1,651 / 2,138 | 3,789 | 95 |
| `batch-reconcile-go` | Go | 24 | 10 / 10 | 2,409 / 2,487 | 4,896 | 88 |
| `buffered-journal-rs` | Rust | 27 | 16 / 6 | 6,192 / 1,051 | 7,243 | 58 |
| `circuit-lane-java` | Java | 27 | 15 / 7 | 2,816 / 2,417 | 5,233 | 63 |
| `durable-audit-java` | Java | 22 | 9 / 7 | 2,881 / 1,890 | 4,771 | 91 |
| `ledger-flow-ts` | TypeScript | 27 | 12 / 9 | 2,659 / 2,507 | 5,166 | 58 |
| `ordered-events-py` | Python | 37 | 14 / 19 | 1,484 / 3,698 | 5,182 | 58 |
| `quote-fanout-go` | Go | 24 | 15 / 5 | 3,354 / 1,790 | 5,144 | 58 |
| `resilient-pricing-py` | Python | 37 | 16 / 17 | 1,615 / 3,497 | 5,112 | 58 |
| `settlement-queue-py` | Python | 36 | 15 / 17 | 2,079 / 3,023 | 5,102 | 58 |
| `signal-buffer-ts` | TypeScript | 30 | 15 / 9 | 3,447 / 1,818 | 5,265 | 54 |
| `swift-cache-ts` | TypeScript | 29 | 11 / 12 | 3,604 / 1,661 | 5,265 | 55 |

每个仓库均包含：

- `README.md`
- `LICENSE`
- `manifest.json`
- 生产源码
- 测试源码
- 语言、构建方式、测试方式、许可证和依赖说明

仓库之间未发现跨仓库 import。核心候选均可解析；12 个仓库各自声明的 build/test 流程均已执行并通过。

### 4.3 构建与测试结果

| 仓库 | Build | Test |
|---|---|---|
| `account-stream-rs` | 通过 | 通过，64 tests |
| `batch-reconcile-go` | 通过 | 通过 |
| `buffered-journal-rs` | 通过 | 通过，29 tests |
| `circuit-lane-java` | 通过 | 通过，含并发 smoke/suite |
| `durable-audit-java` | 通过 | 通过，5 suites / 971 assertions |
| `ledger-flow-ts` | 通过 | 通过，137 tests |
| `ordered-events-py` | 通过 | 通过，396 tests |
| `quote-fanout-go` | 通过 | 通过，并补充通过 race/vet 检查 |
| `resilient-pricing-py` | 通过 | 通过，311 tests |
| `settlement-queue-py` | 通过 | 通过，249 tests |
| `signal-buffer-ts` | 通过 | 通过，136 tests |
| `swift-cache-ts` | 通过 | 通过，118 tests |

## 5. 检索标准答案审查

### 5.1 文件完整性

| 文件 | 内容 | 审查结果 |
|---|---|---|
| `tasks.jsonl` | 5 个目标任务 | 5 行，字段完整，可解析 |
| `relevance.jsonl` | 目标与候选关系 | 90 行，字段完整，可解析 |
| `corpus-manifest.json` | 仓库、语言、文件、LOC、符号、构建方式 | 与磁盘实测一致 |
| `provenance.json` | 合成数据来源声明 | `synthetic=true`，`copiedFromOpenSource=false` |

`tasks.jsonl` 中每条记录均包含：`taskId`、`targetRepository`、`targetPath`、`targetSymbol`、`targetLanguage`、`requirement`、`immutableContract`、`constraints`、`expectedBehaviors`。

`relevance.jsonl` 中每条记录均包含：`taskId`、候选仓库/路径/符号/语言、`relevance`、`reusableParts`、`incompatibleParts`、`recommendedStrategy`、`risks`、`expectedInterfaceMappings`。

### 5.2 相关度与策略分布

| 相关度 | 总数 | 每任务数量 |
|---|---:|---:|
| high | 10 | 2 |
| medium | 20 | 4 |
| low | 10 | 2 |
| distractor | 50 | 10 |
| 合计 | 90 | 18 |

推荐策略分布：

| 策略 | 数量 |
|---|---:|
| translate | 52 |
| reuse | 15 |
| wrap | 14 |
| bridge | 9 |

该分布覆盖直接复用、跨语言翻译、适配器封装和运行时桥接四种迁移策略。

### 5.3 High 候选行为审查

| 任务 | 候选仓库与符号 | 行为相关性结论 |
|---|---|---|
| 报价缓存 | `quote-fanout-go/fanout/timed_snapshot.go` — `TimedSnapshot.Lookup` | 覆盖 TTL、同键合并、超时/取消、stale 回退核心语义 |
| 报价缓存 | `signal-buffer-ts/src/request-mux.ts` — `ExpiringRequestMux.load` | 覆盖过期缓存、请求合并、AbortSignal 与 stale 路径 |
| 批量结算 | `batch-reconcile-go/src/reconcile/coordinator.go` — `BatchCommitCoordinator.Reconcile` | 覆盖批处理、幂等、部分重试、稳定顺序与结果归并 |
| 批量结算 | `ledger-flow-ts/src/ordered-batch-committer.ts` — `OrderedBatchCommitter.commit` | 覆盖进程内幂等、重试、Receipt 去重和顺序保持 |
| Provider 路由 | `circuit-lane-java/.../FallbackCircuitLane.java` — `FallbackCircuitLane.acquire` | 覆盖独立熔断、主备切换、半开恢复 |
| Provider 路由 | `quote-fanout-go/fanout/health_switch.go` — `HealthSwitch.Select` | 覆盖每 Provider 健康状态、故障转移与恢复探测 |
| 事件消费 | `account-stream-rs/src/partitioned_inbox.rs` — `PartitionedInbox.handle` | 覆盖去重、分区有序、跨分区并行和确认控制 |
| 事件消费 | `ordered-events-py/src/ordered_events/pump.py` — `PartitionedEventPump` | 覆盖按账户分区、并发 worker、去重与失败确认语义 |
| 审计缓冲 | `durable-audit-java/.../ConcurrentAuditAccumulator.java` — `ConcurrentAuditAccumulator` | 覆盖并发缓冲、阈值/定时刷盘及关闭 drain |
| 审计缓冲 | `quote-fanout-go/fanout/journal_batcher.go` — `JournalBatcher` | 覆盖 actor 式并发安全、批量/定时刷盘和 Close 收尾 |

High 候选不是仅凭名称匹配。逐项检查后，其核心控制流与目标行为相关，同时在标准答案中明确记录了迁移风险。例如：

- Go/Rust 的取消与同步模型需要映射到 TypeScript Promise/AbortSignal。
- 部分实现依赖进程内状态，不能直接视为跨进程幂等存储。
- 某些批处理实现把所有异常视为可重试，需要在目标工程中增加错误分类。
- Python 事件泵存在 ack 与 checkpoint 提交次序差异，需要适配后才能满足“不误确认”。
- Go 审计 batcher 需要显式启动运行循环，且阻塞 writer 会阻塞 actor。

这些差异已落入 `incompatibleParts`、`risks` 和 `expectedInterfaceMappings`，能够支持人工选择和翻译决策。

## 6. 合成质量与泄漏检查

### 6.1 非重复性

语料质量扫描覆盖 281 个代码文件（生产源码与测试源码）。结果如下：

| 指标 | 结果 |
|---|---:|
| 精确重复窗口超额比例 | 0.0052 |
| 高频精确窗口比例 | 0.0005 |
| 可比较规范化文件对 | 2,691 |
| 高规范化相似文件对比例 | 0 |
| 通用框架填充行比例 | 0 |
| 机械规则填充行比例 | 0 |
| 过度重复文件 | 0 |
| 高相似文件对 | 0 |

最高文件内重复度为 0.5693，出现在受约束的领域契约或测试表格代码中，未达到“重复模板凑行数”的判定条件。已记录的有限豁免文件为：

- `buffered-journal-rs/src/domain.rs`
- `ordered-events-py/src/ordered_events/model.py`
- `settlement-queue-py/src/settlement_queue/model.py`
- `signal-buffer-ts/src/domain.ts`

目标工程自身的最高文件内重复度为 0.1108，规范化高相似文件对比例为 0.0132，低于 0.1 阈值。

### 6.2 标准答案泄漏

在待检索语料源码、注释和 README 中未发现：

- task ID；
- 目标工程完整类名或精确目标符号；
- `high`、`medium`、`low`、`distractor` 等标注；
- `TODO`、`FIXME`、`NotImplemented` 等提示答案的占位标记；
- 来源 URL 或真实开源项目归属信息；
- 用于凑量的通用 `Analysis`/`Workflow` 命名模板。

标准答案只存在于 `fixtures/benchmark`，未嵌入待检索仓库。

### 6.3 合成来源

`provenance.json` 明确声明全部代码为独立合成数据，没有复制真实开源仓库源码。仓库 LICENSE 与 manifest 信息完整，未发现外部源码归属或复制痕迹。

## 7. 验证结果

完整验证命令：

```powershell
python -B fixtures/benchmark/validate.py --run-commands
```

最终结果：

```text
status: PASS
errors: []
```

验证脚本完成以下检查：

- 目标工程结构、规模、分层和五个待实现点；
- TypeScript build、unit test、lint；
- acceptance 测试必须失败且失败原因来自待实现目标；
- 12 个语料仓库的 manifest、build 和 test 命令；
- JSON/JSONL 语法、字段、路径、符号和语言一致性；
- 每任务相关度配额及策略分布；
- LOC、文件数、符号数与 manifest 实测一致性；
- 重复度、跨仓库依赖、答案泄漏和 provenance。

补充的可重建与快速校验入口：

```powershell
python -B fixtures/benchmark/rebuild_relevance.py
python -B fixtures/benchmark/assemble.py
python -B fixtures/benchmark/validate.py
```

完整验证后已清理 `node_modules`、`dist`、`build`、`target`、`__pycache__`、`.pytest_cache`、`.class`、`.pyc` 等生成物；清理后再次进行轻量校验，JSON/JSONL、manifest 和质量审计仍通过。

## 8. Review Findings

### 阻断项

- P0：无。
- P1：无。

### 非阻断注意事项

1. 语料总 LOC 为 62,168，接近 60,000 下限；符号数为 794，接近 800 上限。后续修改语料时必须重新运行统计，避免越界。
2. 目标工程的源码文件、class、function/method 数量均位于允许区间上界，新增生产结构前同样应重新核算。
3. Acceptance 的 20 个失败是基准设计的一部分，不应作为普通测试失败处理；实现目标时也不应修改 acceptance 测试来获得通过。
4. High 候选仍需按 `relevance.jsonl` 记录的风险进行翻译或适配，不能把“high”理解为可无条件逐行复制。
5. 验证器在缺少目标工程开发依赖时会安装固定依赖；离线复现环境应提前准备 npm 缓存。该行为不影响当前已验证结果。

## 9. 工作区完整性

- `workspace/forexplore` 的 scoped Git 状态为空，未被修改。
- 本次产出位于用户指定的 `fixtures/` 目录和本报告文件。
- 未创建 Git commit，未执行 push。
- 当前工作树中还存在 `harnesshistory/`、`worklog/` 等其他未跟踪内容；它们不属于本次审查范围，也未被修改。

## 10. 最终结论

该合成基准工程在规模、结构、待实现契约、测试隔离、跨语言候选设计、标准答案完整性、合成来源声明和可执行验证方面均满足要求。完整验证结果为 `PASS`，当前无需要阻断交付的问题。
