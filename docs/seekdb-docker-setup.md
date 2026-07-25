# ForeXplore SeekDB Docker 配置记录

本文记录在 Windows Docker Desktop + WSL 环境中，为 ForeXplore 启动和配置
SeekDB 的完整过程。所有命令均从仓库根目录执行：

```text
/mnt/e/CS/devsys/weichai
```

## 1. 检查 Docker 环境

```bash
docker version
docker compose version
```

作用：

- `docker version` 同时检查 Docker CLI 和 Docker Engine 是否可用。
- `docker compose version` 确认 Compose 插件已经安装。
- 如果只能看到 Client、看不到 Server，通常说明 Docker Desktop 尚未启动或 WSL
  Integration 未开启。

本次环境使用 Docker Desktop，WSL 可以正常访问 Docker Engine。

## 2. Compose 配置说明

项目使用的配置文件是：

```text
services/retrieval-service/docker-compose.yml
```

核心配置如下：

```yaml
services:
  seekdb:
    image: oceanbase/seekdb:latest
    container_name: forexplore-seekdb
    ports:
      - "2881:2881"
      - "2886:2886"
    environment:
      SEEKDB_DATABASE: forexplore
      MEMORY_LIMIT: 2G
      CPU_COUNT: 2
    volumes:
      - seekdb-data:/var/lib/oceanbase
```

各配置项的作用：

| 配置 | 作用 |
| --- | --- |
| `oceanbase/seekdb:latest` | 使用 SeekDB 官方容器镜像 |
| `forexplore-seekdb` | 固定容器名称，便于查看日志和执行命令 |
| `2881:2881` | 暴露 MySQL 兼容数据库端口 |
| `2886:2886` | 暴露 SeekDB 管理端口 |
| `SEEKDB_DATABASE=forexplore` | 首次初始化时创建 `forexplore` 数据库 |
| `MEMORY_LIMIT=2G` | 将 SeekDB 内存限制设为 2 GiB |
| `CPU_COUNT=2` | 为 SeekDB 配置 2 个 CPU |
| `seekdb-data` | 使用 Docker 命名卷持久化数据库文件和索引 |

Compose 还配置了健康检查，每 10 秒通过 `mysqladmin ping` 检查一次数据库。

## 3. 启动 SeekDB

```bash
docker compose -f services/retrieval-service/docker-compose.yml up -d
```

作用：

1. 在本地没有镜像时拉取 `oceanbase/seekdb:latest`。
2. 创建名为 `forexplore-seekdb` 的容器。
3. 创建命名卷 `seekdb-data`。
4. 将容器的 2881、2886 端口映射到宿主机。
5. 在后台启动容器；`-d` 表示 detached 模式。

该命令是幂等的。容器已经存在时再次执行，会按当前 Compose 配置启动或更新容器。

## 4. 查看初始化日志

```bash
docker logs -f forexplore-seekdb
```

作用：持续输出容器日志。`-f` 表示 follow，用于观察首次初始化、数据库创建和
健康检查过程。

本次启动日志中的关键结果是：

```text
SeekDB started successfully
Database forexplore created.
Initialization complete.
Seekdb started
```

看到这些信息说明 SeekDB 已启动并创建了 `forexplore` 数据库。按 `Ctrl+C` 只会
退出日志跟踪，不会停止容器。

## 5. 检查容器状态

```bash
docker compose -f services/retrieval-service/docker-compose.yml ps
```

作用：显示该 Compose 项目中的容器、镜像、运行状态和端口映射。

正常状态应包含：

```text
forexplore-seekdb   Up ... (healthy)
```

`healthy` 表示 Compose 中定义的数据库健康检查已经通过。

## 6. 直接检查数据库端口

```bash
docker exec forexplore-seekdb mysqladmin ping -h 127.0.0.1 -P 2881 -u root
```

作用：

- `docker exec` 在正在运行的 SeekDB 容器内执行命令。
- `mysqladmin ping` 检查 2881 端口是否接受数据库连接。
- 当前开发配置使用 `root` 用户和空密码。

正常输出：

```text
mysqld is alive
```

本次检查已经通过，说明 SeekDB 容器和数据库端口均可用。

## 7. 数据存储位置

数据库数据通过命名卷挂载：

```yaml
seekdb-data:/var/lib/oceanbase
```

因此镜像、容器层和 `seekdb-data` 都由 Docker Desktop 管理，实际位于 Docker
Desktop 设置的 **Disk image location** 中，而不是项目目录。移动 Disk image
location 时应通过 Docker Desktop 设置操作，不能直接移动内部数据文件。

可以查看实际创建的卷：

```bash
docker volume ls
docker volume inspect retrieval-service_seekdb-data
```

Compose 会在卷名前添加项目名。本次实际创建并验证的卷名是
`retrieval-service_seekdb-data`。

## 8. 配置 ForeXplore 连接 SeekDB

SeekDB 容器启动后，还需要配置 retrieval service 和 Web。以下不是 Docker
命令，但它们是让 ForeXplore 真正使用 SeekDB 的必要步骤。

创建本地配置文件：

```bash
cp services/retrieval-service/.env.example services/retrieval-service/.env
cp apps/workflow-web/.env.example apps/workflow-web/.env
```

两个文件的职责：

- `services/retrieval-service/.env`：配置 SeekDB 地址、数据库、表、向量维度和
  embedding provider。
- `apps/workflow-web/.env`：设置 `VITE_RETRIEVAL_API_URL`，让 Web 从 Mock
  检索切换到真实 retrieval service。

`.env` 可能包含数据库密码或 API Key，不应提交到 Git。

## 9. 初始化检索表和代码索引

```bash
npm run schema --workspace @forexplore/retrieval-service
```

作用：在 `forexplore` 数据库中创建或更新 `code_symbols` 表、向量索引和全文索引。

```bash
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
```

作用：

1. 扫描 `fixtures/code-corpus` 下的多语言代码仓库。
2. 提取 class、method 和 function 符号。
3. 生成 embedding。
4. `--replace` 先清空现有代码符号，再重新写入完整索引。
5. 刷新 SeekDB 索引，使新数据立即可检索。

开发环境默认使用 `hash` embedding，适合离线联调；生产质量语义检索应配置
OpenAI-compatible embedding 服务。

## 10. 启动并验证 retrieval service

```bash
npm run dev:retrieval
```

作用：启动 ForeXplore retrieval HTTP service。它连接 SeekDB，并在
`http://127.0.0.1:8787` 提供检索 API。

在另一个终端检查：

```bash
curl http://127.0.0.1:8787/health
```

正常返回：

```json
{"status":"ok","storage":"seekdb"}
```

该响应证明 HTTP service 和 SeekDB 两层连接都正常。

## 11. 启动 Web

```bash
npm run dev:web
```

Web 启动时会读取 `apps/workflow-web/.env`。当
`VITE_RETRIEVAL_API_URL=http://127.0.0.1:8787` 存在时，检索端口使用 SeekDB；
缺少该变量时自动回退到 Mock。成功接入后，界面状态栏会显示 `SeekDB`。

## 12. 日常启停命令

停止容器但保留容器和数据：

```bash
docker compose -f services/retrieval-service/docker-compose.yml stop
```

重新启动已停止的容器：

```bash
docker compose -f services/retrieval-service/docker-compose.yml start
```

删除容器和网络，但保留命名卷数据：

```bash
docker compose -f services/retrieval-service/docker-compose.yml down
```

重新创建并启动容器：

```bash
docker compose -f services/retrieval-service/docker-compose.yml up -d
```

删除容器并同时删除数据库卷：

```bash
docker compose -f services/retrieval-service/docker-compose.yml down -v
```

最后一条命令会永久删除 SeekDB 数据库和代码索引，只应在明确需要完全重建时使用。

## 13. 本次执行结果

本次已完成的 Docker 阶段包括：

1. 确认 Docker Engine 和 Compose 可用。
2. 使用 Compose 启动 `forexplore-seekdb`。
3. 观察日志，确认 `forexplore` 数据库创建完成。
4. 确认容器状态为 `healthy`。
5. 使用 `mysqladmin ping` 确认 2881 数据库端口可用。

SeekDB 基础设施已经就绪。后续需要完成 `.env` 配置、schema 初始化、corpus
索引和 retrieval service 启动，ForeXplore Web 才会从 Mock 切换到真实检索。
