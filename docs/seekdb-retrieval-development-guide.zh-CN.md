# SeekDB 检索与真实模块树开发总览

本文档覆盖 `codex/seekdb-updated-base` 分支相对 `upstream/main` 的全部功能改动，面向需要继续开发、调试或替换实现的同事。

对应上游 PR：[chiparon/weichai#2](https://github.com/chiparon/weichai/pull/2)

## 1. 改动目标

本次改动在不破坏原有 Mock 工作流的前提下，补齐了两块真实能力：

1. 从目标 TypeScript 工程源码生成可选择的模块树，不再使用固定模块树。
2. 使用 SeekDB 保存代码符号，通过向量、全文和混合检索返回真实候选实现。

原有适配和回填流程仍由 Mock Adapter 提供。只有配置了
`VITE_RETRIEVAL_API_URL`，前端才会把 `CodeSearchPort` 替换为 SeekDB HTTP
Adapter；未配置时行为与原项目一致。

## 2. 必须先理解的两个数据域

### 2.1 目标工程

目标工程是“准备被补全或修改的项目”。当前固定为：

```text
fixtures/target-system/currency-platform
```

Vite 启动或构建时会扫描这个目录，生成左侧模块树。树中的
`SettlementService.settleBatch` 属于目标符号，用于构造检索请求。

### 2.2 复用语料库

复用语料库是“用于寻找参考实现的项目集合”。默认索引：

```text
fixtures/code-corpus
fixtures/translation-datasets
```

检索候选只来自已经写入 SeekDB 的语料。目标工程中的
`SettlementService` 不会因为出现在左侧模块树中，就自动出现在右侧候选列表。
如果确实需要“搜索本项目已有实现”，需要为目标工程添加 manifest，并把它作为
`index:corpus` 的输入。

这两个数据域的关系是：

```text
目标工程源码
  -> 目标模块树
  -> 选择目标 class/function
  -> SearchRequest
  -> SeekDB 复用语料库
  -> 候选实现
```

## 3. 总体架构

```text
fixtures/target-system/currency-platform
            |
            | Vite build plugin + Babel AST
            v
virtual:target-module-tree
            |
            v
apps/workflow-web
  |  未配置 VITE_RETRIEVAL_API_URL -> Mock CodeSearchPort
  |
  +-- 已配置 VITE_RETRIEVAL_API_URL
            |
            v
packages/seekdb-adapter
            |
            | POST /v1/search
            v
services/retrieval-service
  | query expansion
  | embedding
  | vector/full-text retrieval
  | fusion and reranking
            |
            v
          SeekDB
            ^
            |
fixtures/code-corpus + fixtures/translation-datasets
            |
            | corpus-indexer
            +-----------------
```

依赖边界保持为：

```text
workflow-web -> workflow-core -> contracts
workflow-web -> mock-adapters
workflow-web -> seekdb-adapter -> contracts
retrieval-service -> contracts + SeekDB
```

生产代码没有反向依赖 Mock Adapter。前端的运行时组合入口只有
`apps/workflow-web/src/main.tsx`。

## 4. 代码目录与职责

### 4.1 共享契约

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/src/module.ts` | 为模块节点和目标符号增加真实源码行号、实现状态 |
| `packages/workflow-core/src/module-target.ts` | 将可选择的模块节点转换为 `ModuleTarget`，保留行号和实现状态 |

`ImplementationStatus` 有两个值：

```ts
type ImplementationStatus = 'implemented' | 'unimplemented';
```

只有 `class` 和 `function` 节点可以转换为工作流目标。文件夹和文件节点只负责组织和导航。

### 4.2 真实目标模块树

| 文件 | 职责 |
| --- | --- |
| `apps/workflow-web/build/target-module-tree.ts` | 扫描 TypeScript 文件，通过 Babel AST 提取 class、方法和顶层 function |
| `apps/workflow-web/build/target-module-tree.test.ts` | 验证符号、签名、行号和未实现状态 |
| `apps/workflow-web/vite.config.ts` | 注册 `virtual:target-module-tree`，监听目标工程源码变化并触发页面重载 |
| `apps/workflow-web/src/main.tsx` | 将虚拟模块生成的树注入 `App` |
| `apps/workflow-web/src/features/target-selection/ModuleTree.tsx` | 展示真实目录和符号节点，只允许选择 class/function |

模块树扫描规则：

- 扫描 `.ts` 和 `.tsx`。
- 跳过 `node_modules`、隐藏目录和 `dist`。
- 使用 `@babel/parser` 的 TypeScript/JSX 插件。
- 提取顶层 class、class method 和顶层 function。
- 保存真实相对路径、声明签名和源码行号。
- 方法体抛出 `NotImplementedError` 或 `Error("Not implemented...")` 时标记为
  `unimplemented`。
- Windows 路径统一转换为 `/` 后再做监听范围判断。

要切换目标工程，修改：

```ts
// apps/workflow-web/vite.config.ts
const targetWorkspace = fileURLToPath(
  new URL('../../fixtures/target-system/currency-platform', import.meta.url),
);
```

后续更通用的实现应把这个目录改成环境变量或工作区配置，而不是继续增加硬编码分支。

### 4.3 浏览器 SeekDB Adapter

| 文件 | 职责 |
| --- | --- |
| `packages/seekdb-adapter/src/seekdb-code-search.ts` | 实现 `CodeSearchPort`，将浏览器请求发送到检索服务 |
| `packages/seekdb-adapter/src/seekdb-code-search.test.ts` | 验证请求、响应、AbortSignal 和错误处理 |
| `packages/seekdb-adapter/src/index.ts` | 包公共导出 |

`withSeekDbSearch()` 只替换 `WorkflowPorts.search`：

```ts
const workflowPorts = retrievalApiUrl
  ? withSeekDbSearch(mockWorkflowPorts, { baseUrl: retrievalApiUrl })
  : mockWorkflowPorts;
```

因此当前状态是：

| Port | 实现 |
| --- | --- |
| `CodeSearchPort` | SeekDB 或 Mock，取决于前端环境变量 |
| `CodeAdaptationPort` | Mock |
| `CodeBackfillPort` | Mock |

### 4.4 检索服务

| 文件 | 职责 |
| --- | --- |
| `src/config.ts` | 读取并校验环境变量 |
| `src/runtime.ts` | 创建 Store、EmbeddingProvider 和 SearchEngine |
| `src/server.ts` | 服务启动和优雅关闭 |
| `src/http-server.ts` | `/health`、`/v1/search`、CORS、请求校验 |
| `src/types.ts` | 服务内部文档、Store、Embedding 和 Engine 接口 |
| `src/seekdb-store.ts` | 建表、批量写入、向量检索、全文检索 |
| `src/embedding.ts` | 离线 Hash Embedding 和 OpenAI-compatible Embedding |
| `src/text-analysis.ts` | 标识符拆词、查询扩展和词项重叠计算 |
| `src/search-engine.ts` | 检索模式、候选融合、契约评分和最终排序 |
| `src/corpus-indexer.ts` | 发现语料仓库并提取 class/method/function |
| `src/corpus-index-cli.ts` | 从源码语料建立索引 |
| `src/index-cli.ts` | 从 JSONL 文档建立索引 |
| `src/schema-cli.ts` | 单独初始化数据库结构 |

对应测试都放在同目录的 `*.test.ts` 中。

## 5. SearchRequest 与 HTTP API

共享请求结构：

```ts
interface SearchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  retrievalMode: 'hybrid' | 'semantic' | 'structure';
  repositoryScopes: string[];
}
```

服务端限制：

- `requirement` 必须为非空字符串。
- `topK` 必须是 `1` 到 `50` 的整数。
- `target.kind` 只能是 `class` 或 `function`。
- 请求体最大 1 MiB。
- 无效 JSON 返回 `400`。
- 超大请求返回 `413`。
- 检索或数据库异常返回 `503`。

### 5.1 健康检查

```http
GET /health
```

成功响应：

```json
{
  "status": "ok",
  "storage": "seekdb"
}
```

这个接口会实际执行 SeekDB `SELECT 1`，不是仅检查 Node.js 进程。

### 5.2 检索

```http
POST /v1/search
Content-Type: application/json
```

成功响应：

```json
{
  "candidates": []
}
```

浏览器 Adapter 会验证响应至少包含合法的候选数组、候选 ID、标题和评分对象。

## 6. 语料索引

### 6.1 默认输入

`index:corpus` 默认扫描：

```text
fixtures/code-corpus
fixtures/translation-datasets
```

当前完整索引包含 2,341 个符号：

- 代码语料 1,009 个。
- Java 翻译数据集 1,332 个。

不完整的 C# skeleton 不会被当成可复用实现索引。

### 6.2 Manifest

每个待索引仓库需要 `manifest.json` 或 `dataset-manifest.json`：

```json
{
  "repository": "example-repository",
  "language": "TypeScript",
  "sourceRoot": "src",
  "license": "MIT",
  "dependencies": [],
  "synthetic": false
}
```

必要字段：

- `repository`：非空字符串。
- `language`：当前支持 `TypeScript`、`Python`、`Java`、`Rust`、`Go`。

可选字段：

- `sourceRoot`：相对仓库根目录的源码路径，不允许逃逸到仓库外。
- `license`：缺省时写入 `Unknown`。
- `dependencies`：字符串数组。
- `synthetic`：为 `true` 时给候选增加“合成评估语料”风险标签。

Manifest 存在但 JSON 或元数据错误时会直接中止索引，不再静默跳过。

### 6.3 扫描与提取规则

索引器会：

- 跳过 `node_modules`、`target`、`build`、`__pycache__` 和隐藏目录。
- 跳过常见测试目录及 `*.test.ts`、`*_test.go`、`test_*.py` 等测试文件。
- 按 manifest 声明的语言过滤文件。
- 提取 class/type、方法和函数。
- 为每个符号保留签名、注释摘要、源码片段、路径和行号。
- 将 camelCase、路径词和正文一起写入全文搜索字段。

符号 ID 格式：

```text
repository:relative/path:line:symbolName
```

当前源码索引器以正则和作用域深度为主，不是所有语言的完整 AST。大规模接入真实企业仓库时，建议按语言替换为 Tree-sitter、语言编译器 API 或 LSP 索引。

### 6.4 添加一个新仓库

假设仓库目录为 `D:\Corpus\payment-service`：

1. 在仓库根目录添加合法 manifest。
2. 确认 `sourceRoot` 指向真实源码。
3. 执行：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- `
  D:\Corpus\payment-service
```

传入多个根目录时可一次索引多个仓库。默认是增量 upsert；加 `--replace` 会先清空
`code_symbols` 表，生产环境使用前应确认影响范围。

## 7. Embedding

### 7.1 Hash Embedding

默认配置：

```text
SEEKDB_EMBEDDING_PROVIDER=hash
SEEKDB_VECTOR_DIMENSION=384
```

它使用单词和字符 trigram 做确定性 feature hashing：

- 不下载模型。
- 不需要网络和 API key。
- 适合本地联调、CI 和功能冒烟测试。
- 不能替代生产级语义模型。

### 7.2 OpenAI-compatible Embedding

配置示例：

```text
SEEKDB_EMBEDDING_PROVIDER=openai
SEEKDB_EMBEDDING_URL=https://api.openai.com/v1/embeddings
SEEKDB_EMBEDDING_API_KEY=...
SEEKDB_EMBEDDING_MODEL=text-embedding-3-small
SEEKDB_VECTOR_DIMENSION=1536
```

实现包含：

- 30 秒请求超时。
- HTTP 和 JSON 错误处理。
- 向量数量、index 唯一性、维度和有限数值校验。
- 按响应 `index` 恢复输入顺序。

改变模型或向量维度后不能直接复用旧表。应使用新表名，或者明确删除并重建专用索引表，再重新索引全部文档。

## 8. SeekDB 表结构

默认数据库与表：

```text
forexplore.code_symbols
```

关键字段：

| 字段 | 内容 |
| --- | --- |
| `id` | 稳定符号 ID，主键 |
| `title` | class/function/method 名称 |
| `repository` | 语料仓库标识 |
| `language`、`kind` | 结构过滤字段 |
| `path`、`signature` | 源码定位和契约 |
| `summary`、`preview` | 展示与排序内容 |
| `dependencies`、`compatibility`、`risks` | JSON 元数据 |
| `search_text` | 扩展后的全文检索文本 |
| `embedding` | `VECTOR(n)` |

索引：

- `FULLTEXT INDEX idx_code_text`：全文检索。
- `VECTOR INDEX idx_code_embedding`：HNSW cosine 检索。

所有普通查询值和过滤条件都使用参数化 SQL。数据库名和表名只允许字母、数字和下划线。

## 9. 检索和排序逻辑

### 9.1 查询文本

检索文本由以下内容组成：

- 目标名称。
- 目标签名。
- 目标 kind 和 language。
- 目标路径。
- 用户自然语言需求。
- camelCase、snake_case、路径和常见领域词的扩展结果。

因此搜索 `settleBatch` 时，也会检索 `settle`、`batch`、`settlement` 等词。

### 9.2 Repository Scope

`repositoryScopes` 中：

- `repo:owner/name` 会转换为 `owner/name`。
- `owner/name` 会作为显式仓库过滤。
- UI 标签 `configured-repositories`、`mock-catalog` 会被忽略。
- 包含 `*` 的值目前不会生成 SQL 过滤。

如要给前端实现真实的仓库筛选器，应传递索引中实际保存的 repository 值，例如：

```text
fixture/settlement-queue-py
```

### 9.3 三种模式

| 模式 | 行为 |
| --- | --- |
| `semantic` | 只执行向量检索，再做符号和契约重排 |
| `structure` | 只执行全文检索，并限制候选 kind 与目标一致 |
| `hybrid` | 并行执行向量与全文检索，通过 RRF 融合后重排 |

Hybrid 的 RRF 权重：

```text
semantic: 0.65
full text: 0.35
```

最终综合评分包含：

- `semantic`：向量或需求文本相似度。
- `text`：全文检索分数与本地词项重叠。
- `symbol`：目标名称、签名和路径上下文的相似度。
- `contract`：kind、language 和依赖复杂度的兼容性。

为适配大型索引，系统不会只读取 `topK * 3` 个初始结果。重排池大小为：

```ts
Math.min(250, Math.max(50, topK * 5))
```

最终仍只返回请求中的 `topK`。

## 10. 本地启动

### 10.1 前置条件

- Node.js 与 npm。
- Docker Desktop。
- Windows 上应使用 Docker 或远程 SeekDB；SeekDB embedded 不能直接作为原生 Windows 库运行。

### 10.2 安装依赖

```powershell
cd D:\CodeProjects\Weichai
npm install
```

### 10.3 启动 SeekDB

```powershell
docker compose -f services/retrieval-service/docker-compose.yml up -d
docker compose -f services/retrieval-service/docker-compose.yml ps
```

默认映射：

- SQL：`127.0.0.1:2881`
- 额外服务端口：`2886`
- 容器名：`forexplore-seekdb`
- 持久卷：`seekdb-data`

### 10.4 配置

```powershell
Copy-Item services/retrieval-service/.env.example `
  services/retrieval-service/.env
Copy-Item apps/workflow-web/.env.example `
  apps/workflow-web/.env
```

默认前端配置：

```text
VITE_RETRIEVAL_API_URL=http://127.0.0.1:8787
```

删除或留空该变量，前端就会回退到原 Mock 检索。

### 10.5 建表和索引

服务默认 `SEEKDB_AUTO_MIGRATE=true`，启动时会自动建表。也可以显式执行：

```powershell
npm run schema --workspace @forexplore/retrieval-service
```

重建默认语料：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
```

### 10.6 启动后端和前端

终端一：

```powershell
npm run dev:retrieval
```

终端二：

```powershell
npm run dev
```

访问：

```text
http://localhost:4173/
```

## 11. 调试方法

### 11.1 检查 Docker

```powershell
docker compose -f services/retrieval-service/docker-compose.yml ps
docker logs forexplore-seekdb
```

容器状态应为 `healthy`。

### 11.2 检查检索服务

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

如果前端显示 `Mock Search Port`，优先检查：

1. `apps/workflow-web/.env` 是否存在。
2. `VITE_RETRIEVAL_API_URL` 是否正确。
3. 修改 `.env` 后是否重启了 Vite。
4. 检索服务是否监听 `8787`。
5. `RETRIEVAL_CORS_ORIGIN` 是否与浏览器地址一致。

### 11.3 手工调用检索

```powershell
$body = @{
  target = @{
    id = "settle-batch"
    name = "settleBatch"
    kind = "function"
    path = "src/application/settlement/settlement-service.ts"
    language = "TypeScript"
    signature = "settleBatch(request): Promise<Result>"
  }
  requirement = "批量结算，保证幂等并处理失败重试"
  topK = 5
  retrievalMode = "hybrid"
  repositoryScopes = @("configured-repositories")
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/v1/search `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### 11.4 “结果还是固定预设”

通常表示前端仍在使用 Mock Adapter。查看页面右侧 Port 信息或状态栏：

- 显示 `Mock`：检查前端环境变量并重启 Vite。
- 显示 `SeekDB`：请求已经进入真实后端，应检查索引是否完成。

### 11.5 “模块树找不到真实方法”

确认：

- 方法属于当前固定的 target workspace。
- 文件扩展名是 `.ts` 或 `.tsx`。
- 声明是顶层 class、class method 或顶层 function。
- Vite 已在源码修改后重新加载。
- Babel parser 没有遇到当前未支持的语法。

### 11.6 “检索不到刚索引的数据”

索引 CLI 在完成 upsert 后会调用：

```sql
CALL dbms_index_manager.refresh()
```

如果进程中途退出，先重新运行索引。还需确认索引 CLI 和检索服务使用了相同的
`SEEKDB_DATABASE`、`SEEKDB_TABLE`、Embedding Provider 和向量维度。

## 12. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RETRIEVAL_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `RETRIEVAL_PORT` | `8787` | HTTP 端口 |
| `RETRIEVAL_CORS_ORIGIN` | `http://localhost:4173` | 前端 Origin |
| `SEEKDB_HOST` | `127.0.0.1` | SeekDB 地址 |
| `SEEKDB_PORT` | `2881` | SeekDB SQL 端口 |
| `SEEKDB_USER` | `root` | 数据库用户 |
| `SEEKDB_PASSWORD` | 空 | 数据库密码 |
| `SEEKDB_DATABASE` | `forexplore` | 数据库名 |
| `SEEKDB_TABLE` | `code_symbols` | 专用符号表 |
| `SEEKDB_AUTO_MIGRATE` | `true` | 服务启动时建库建表 |
| `SEEKDB_VECTOR_DIMENSION` | `384` | 向量维度 |
| `SEEKDB_EMBEDDING_PROVIDER` | `hash` | `hash` 或 `openai` |
| `SEEKDB_EMBEDDING_URL` | OpenAI embeddings URL | 兼容接口地址 |
| `SEEKDB_EMBEDDING_API_KEY` | 空 | OpenAI 模式必填 |
| `SEEKDB_EMBEDDING_MODEL` | `text-embedding-3-small` | 模型名 |
| `VITE_RETRIEVAL_API_URL` | 未设置 | 设置后启用真实检索 |

## 13. 测试与交付检查

根目录完整验证：

```powershell
npm test
npm run build
npm run build:retrieval
git diff --check
```

当前测试覆盖：

- 工作流核心目标转换。
- 浏览器 Adapter 成功、失败和中止。
- Hash/OpenAI-compatible Embedding。
- 多语言符号提取和 manifest 边界。
- SeekDB SQL 辅助逻辑。
- 三种检索模式、查询扩展、候选池和融合。
- HTTP 健康检查、正常搜索、非法 JSON、无效请求和超大请求。
- 真实模块树生成与 React 工作流交互。

涉及索引器或搜索排序时，还应执行：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
Invoke-RestMethod http://127.0.0.1:8787/health
```

并至少用一个目标符号做浏览器或 HTTP 端到端搜索。

## 14. 已知限制与建议演进

### 14.1 当前限制

- 目标工作区仍硬编码为 fixture。
- 只有检索是真实后端，适配和回填仍是 Mock。
- 源码索引器不是完整语法解析器，复杂多行声明、嵌套声明和部分语言特性可能漏检。
- 模块树目前只解析 TypeScript/TSX。
- 索引是全量目录扫描和逐符号 upsert，没有 Git 增量索引。
- HTTP API 没有鉴权、租户隔离、速率限制和结构化日志。
- 仓库过滤只支持精确 repository 值，不支持通配符。
- Hash Embedding 主要反映词法接近度。
- `CREATE TABLE IF NOT EXISTS` 不会自动迁移已有表的向量维度或字段结构。

### 14.2 推荐开发顺序

面向巨大项目继续开发时，建议按以下顺序推进：

1. 将目标工作区和语料仓库改成显式项目配置。
2. 使用 Git commit/file hash 实现增量索引和删除同步。
3. 用 Tree-sitter/LSP 替换正则符号提取，并保存调用关系、类型和引用。
4. 增加 chunk、类级上下文和调用图检索，避免只靠函数文本。
5. 使用生产 Embedding，并建立离线 relevance benchmark。
6. 增加 reranker 或学习排序，保留当前混合检索作为召回层。
7. 接入真实 Adaptation/Backfill 服务。
8. 增加鉴权、租户/仓库 ACL、审计和可观测性。

## 15. 全部改动文件索引

### 根目录和文档

```text
README.md
package.json
package-lock.json
docs/architecture/repository-structure.md
```

### 共享契约和工作流

```text
packages/contracts/src/module.ts
packages/workflow-core/src/module-target.ts
```

### SeekDB 浏览器 Adapter

```text
packages/seekdb-adapter/package.json
packages/seekdb-adapter/src/index.ts
packages/seekdb-adapter/src/seekdb-code-search.ts
packages/seekdb-adapter/src/seekdb-code-search.test.ts
```

### Web 和真实模块树

```text
apps/workflow-web/.env.example
apps/workflow-web/build/target-module-tree.ts
apps/workflow-web/build/target-module-tree.test.ts
apps/workflow-web/package.json
apps/workflow-web/src/App.tsx
apps/workflow-web/src/App.test.tsx
apps/workflow-web/src/main.tsx
apps/workflow-web/src/styles.css
apps/workflow-web/src/vite-env.d.ts
apps/workflow-web/src/features/candidate-selection/CandidateBrowser.tsx
apps/workflow-web/src/features/target-selection/ModuleTree.tsx
apps/workflow-web/tsconfig.node.json
apps/workflow-web/vite.config.ts
```

### Retrieval Service

```text
services/retrieval-service/.env.example
services/retrieval-service/README.md
services/retrieval-service/docker-compose.yml
services/retrieval-service/examples/code-symbols.jsonl
services/retrieval-service/package.json
services/retrieval-service/tsconfig.json
services/retrieval-service/src/config.ts
services/retrieval-service/src/corpus-index-cli.ts
services/retrieval-service/src/corpus-indexer.ts
services/retrieval-service/src/corpus-indexer.test.ts
services/retrieval-service/src/embedding.ts
services/retrieval-service/src/embedding.test.ts
services/retrieval-service/src/http-server.ts
services/retrieval-service/src/http-server.test.ts
services/retrieval-service/src/index-cli.ts
services/retrieval-service/src/runtime.ts
services/retrieval-service/src/schema-cli.ts
services/retrieval-service/src/search-engine.ts
services/retrieval-service/src/search-engine.test.ts
services/retrieval-service/src/seekdb-store.ts
services/retrieval-service/src/seekdb-store.test.ts
services/retrieval-service/src/server.ts
services/retrieval-service/src/text-analysis.ts
services/retrieval-service/src/types.ts
```

## 16. 本次实现的提交

```text
9b23b3b feat: add SeekDB-backed code retrieval
8a1ffe0 feat: index methods and translation fixtures
c3b7ed6 fix: harden retrieval service for large corpora
```

继续修改时请保持现有边界：共享数据放 `contracts`，工作流时序放
`workflow-core`，浏览器协议适配放 Adapter，索引、存储和排序逻辑放
`retrieval-service`，不要让 UI 直接访问 SeekDB。
