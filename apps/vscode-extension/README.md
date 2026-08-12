# ForeXplore VS Code 扩展

ForeXplore 将企业已有实现作为迁移证据：在 C# 目标方法上检索 Java 候选、由人明确选择候选、生成 Java → C# 补丁，再展示独立验证证据和受保护的回填结果。

当前真实能力边界是 **`translate` 策略下的 Java → C#**。它不是通用代码生成器；候选排序分也不是正确率或兼容概率。

## 运行方式

1. 在仓库根目录运行 `npm run dev:extension`。脚本会确保已安装基础 C# 扩展 `ms-dotnettools.csharp`，启动 SeekDB、两个本地服务，并打开 Extension Development Host。
2. 在开发宿主中打开 C# 工作区，例如 `fixtures/target-system/forexplore-csharp-workspace`。
3. 在 `src/Application/QuoteOrchestrationService.cs` 选择 `GetQuoteAsync` 的方法声明或完整方法，运行 **ForeXplore: 开始代码翻译**。
4. 输入需求、检索 Java 候选，并手动点击一个候选后再生成预览。

插件只调用真实的 SeekDB 检索服务和 Java → C# 适配服务。任一服务不可用时，插件会报错，不会回退到本地样例。

基础 C# 语言服务作为 ForeXplore 的 VS Code 扩展依赖，在安装 VSIX 时会由 VS Code 一并安装。C# Dev Kit (`ms-dotnettools.csdevkit`) 可额外安装以获得完整的项目加载和解决方案体验，但 ForeXplore 不强制安装它。

## 服务要求

运行插件需要一台具备以下条件的机器：

- SeekDB 检索服务已经建立并加载可访问的 Java 语料索引；
- 适配服务具备 `DEEPSEEK_API_KEY` 和 .NET SDK；
- `ADAPTATION_PROJECT_ROOT` 指向与插件选中目标**相同内容**的 C# 工程（通常应在同一受控开发环境或挂载路径中）；
- 适配服务的 `ADAPTATION_SKELETON_PROJECT_PATH` 对应同一 C# skeleton，用于临时集成编译。

适配服务环境示例：

```bash
# 服务端环境；密钥只保留在这里
export DEEPSEEK_API_KEY='…'
export ADAPTATION_PROJECT_ROOT='/absolute/path/to/forexplore-csharp-workspace'
export ADAPTATION_SKELETON_PROJECT_PATH="$ADAPTATION_PROJECT_ROOT"
npm run dev:adaptation
```

插件默认使用以下 VS Code 配置：

```json
{
  "forexplore.executionMode": "real",
  "forexplore.retrievalApiUrl": "http://127.0.0.1:8787",
  "forexplore.adaptationApiUrl": "http://127.0.0.1:8788",
  "forexplore.repositoryPaths": [
    "E:/CS/devsys/weichai/fixtures/code-corpus"
  ]
}
```

该目录包含 `fixtures/code-corpus` 下的全部语料仓库。`forexplore.repositoryPaths` 仅检查本地目录是否可读；它不等于服务端“已经索引”。真实检索范围由检索服务的已授权索引决定。

## 写回保护

- Webview 只能发送“检索、选择候选、生成、应用”的意图，不能提交路径、候选对象或补丁。
- 扩展宿主保存当前运行的 C# 目标、候选、原始文件 SHA-256 和适配结果；候选必须由用户明确选择。
- 仅接受工作区内、当前选中目标对应的一个相对路径修改补丁；路径遍历、绝对路径和经符号链接逃逸都会被拒绝。
- 应用前和应用时都会重新校验 SHA-256，hunk 必须精确匹配原始内容。
- 写入建立持久恢复点。可使用 **ForeXplore: 恢复最近一次回填** 恢复；若文件随后又被编辑，恢复会拒绝覆盖该编辑。
- HTTP `POST /v1/backfill` 已禁用。写回只能由经过用户确认的 VS Code 宿主执行。

编译或集成编译通过仅代表相应工程检查通过；它不证明业务行为、并发、超时、取消或幂等语义正确。

## 开发与验证

```bash
npm ci
npm run typecheck --workspace forexplore-vscode
npm run test --workspace forexplore-vscode
npm run build:extension
npm run package:extension
```

集成测试需要图形界面 VS Code 运行时：

```bash
npm run test:integration --workspace forexplore-vscode
```

## 消息协议

Webview → 宿主：`READY`、`START_SEARCH`、`SELECT_CANDIDATE`、`START_ADAPT`、`APPLY_CURRENT_RUN`、`CHECK_REPOSITORIES`、`OPEN_TARGET`。

宿主 → Webview：`INIT`、`SEARCH_RESULT`、`ADAPT_RESULT`、`APPLY_RESULT`、`REPOSITORY_STATUS`、`SERVICE_STATUS`、`ERROR`。

共享类型和状态机在 monorepo 的 `@forexplore/contracts`、`@forexplore/workflow-core` 中维护；打包时 Webview 与扩展宿主会将所需代码纳入 VSIX 构建产物。
