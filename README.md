# 口述家史编辑器

React + TypeScript 前端、Fastify API、BullMQ worker、PostgreSQL 和 Redis 组成的 pnpm monorepo。当前版本支持注册登录、创建工作区、上传真实音频、异步读取音频时长、创建固定时间范围片段、按时间段播放，以及章节/内容块和发布接口。

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 9
- Docker（本地 PostgreSQL、Redis）
- FFmpeg 可选。worker 优先使用 `ffprobe`，未安装时会使用 `music-metadata` 读取常见音频时长

## 本地启动

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

打开 <http://localhost:5173>。首次注册会自动登录并创建一个默认工作区；上传音频后，worker 会异步读取元数据，状态变为 `READY` 后即可创建片段。

开发阶段也可以用 `pnpm db:push` 直接同步 schema。根目录脚本会自动读取 `.env`；若文件不存在则回退到 `.env.example`。

## 检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 主要接口

- `POST /v1/auth/register`、`POST /v1/auth/login`
- `GET/POST /v1/workspaces`
- `POST /v1/workspaces/:id/recordings/uploads`
- `POST /v1/recordings/:id/playback-ticket`（签发短时播放票据）
- `GET /v1/recordings/:id/file`（支持 HTTP Range、`If-Range`/`ETag` 断点续传，`?ticket=` 或 `Authorization: Bearer` 鉴权）
- `GET/POST /v1/recordings/:id/clips`
- `PATCH /v1/clips/:id`（乐观锁，版本冲突返回 409）
- `GET/POST /v1/workspaces/:id/chapters`
- `PATCH /v1/chapters/:id`
- `POST /v1/chapters/:id/blocks`
- `POST /v1/chapters/:id/publish`
- `GET /v1/workspaces/:id/events`
- `GET /v1/realtime?workspaceId=...`（WebSocket）

健康检查为 `GET /health` 和 `GET /ready`。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

## 音频流安全

- 前端播放不再把登录 JWT 放在 URL 里，而是先调用 `POST /v1/recordings/:id/playback-ticket` 换取短时票据（默认 120 秒，`PLAYBACK_TICKET_TTL_SECONDS` 可调），再用 `?ticket=` 拉流。票据只绑定单条录音与签发用户，过期或被撤销后立即失效；无效票据返回 401，无权限用户一律返回 404。
- 服务端按固定大小（默认 1 MiB）把音频分段缓存在 Redis，缓存键包含录音 ID 与文件 ETag，文件被替换后旧段永远不会命中。缓存装配失败一律回退磁盘流，不会返回错位或不完整的字节。
- 响应携带 `ETag`/`Last-Modified` 并支持 `If-Range`：断线续传时若文件版本已变化，服务端回退 200 全量响应，客户端重新下载，避免多段内容跨版本拼接。

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
