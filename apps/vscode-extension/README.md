# ForeXplore VSCode 扩展

在 VSCode 中运行 ForeXplore 代码翻译工作流：选中待翻译代码 → 右键「ForeXplore: 开始代码翻译」→ 在独立面板中完成 检索相似实现 → 选择方案 → 翻译/适配 → diff 预览确认回填。

本扩展是一个**完全自包含**的模块：共享契约、工作流核心与各适配器均已内嵌在扩展包内，不依赖本仓库的其他目录，安装 VSIX 后即可独立运行。

## 功能

- 编辑器右键入口：读取当前文件、语言与选区，构造翻译目标（启发式提取符号名与签名，可在面板中修正）。
- 单列向导式 Webview Panel：目标 → 需求 → 方案 → 翻译 → 补丁五个阶段，窄面板（360px 起）与深浅主题均可用。
- 服务连接：优先连接配置的检索/翻译服务地址（使用绕过代理的本地 HTTP 栈）；未配置或不可达时自动降级为内置演示模式并在面板中标注。
- 检索仓库健康检查：扩展激活时预检，每次翻译开始前复查。路径不存在/不可读会阻止翻译并给出提示；索引由检索服务管理（在本仓库环境中通过 `npm run index:corpus` 构建）。
- 回填安全：翻译结果先以 diff 展示，用户确认后才通过 `WorkspaceEdit` 写入工作区，并返回检查点 ID。

## 开发

```bash
# 在仓库根目录
npm install
npm run build:extension        # 构建 Webview + 扩展宿主
npm run test --workspace forexplore-vscode
```

用 VSCode 打开 `apps/vscode-extension` 目录，按 F5 即可启动扩展宿主调试（预先执行构建任务）。

### 集成测试

```bash
# 使用系统已安装的 VSCode（推荐，无需下载运行时）
FOREXPLORE_TEST_VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  npm run test:integration --workspace forexplore-vscode

# 或让测试框架自动下载一个 VSCode 副本
npm run test:integration --workspace forexplore-vscode
```

集成测试需要图形界面环境。若下载的 VSCode 副本被 macOS 提示“已损坏”，删除
`apps/vscode-extension/.vscode-test` 目录后重试即可（该目录不进入版本库）。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `forexplore.repositoryPaths` | `[]` | 检索相似实现的本地代码仓库路径（绝对路径数组）。 |
| `forexplore.retrievalApiUrl` | 空 | 检索服务地址，如 `http://127.0.0.1:8787`；留空使用内置演示模式。 |
| `forexplore.adaptationApiUrl` | 空 | 翻译服务地址，如 `http://127.0.0.1:8788`；留空使用内置演示模式。 |

真实检索需要 SeekDB/MySQL 与已构建的语料索引；翻译服务需要 DeepSeek Key（配置在服务端环境）。模型/Embedding Key 只存在于服务端环境，不会下发到 Webview。扩展自身只作为客户端调用已部署的服务，未配置服务地址时使用内置演示数据走完整流程。

## 消息协议

Webview 与扩展宿主通过 `postMessage` 通信（见 `src/protocol/messages.ts`）：

- Webview → 宿主：`READY`、`START_SEARCH`、`START_ADAPT`、`APPLY_PATCHES`、`REINDEX`、`OPEN_FILE`
- 宿主 → Webview：`INIT`、`SEARCH_RESULT`、`ADAPT_RESULT`、`APPLY_RESULT`、`REPOSITORY_STATUS`、`SERVICE_STATUS`、`ERROR`

Webview 不直接访问本地服务，所有检索/翻译/索引调用由扩展宿主代理，避免 CSP 与跨源问题。

## 打包

```bash
npm run package:extension      # 生成 .vsix（需要 @vscode/vsce）
```

所有依赖（含 monorepo workspace 包）已通过 esbuild/Vite 打进构建产物，安装扩展无需额外依赖。
