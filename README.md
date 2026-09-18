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
- `POST /v1/recordings/:id/playback-ticket`（成员换取短时播放票据，默认 10 分钟有效）
- `GET /v1/recordings/:id/file?ticket=...`（支持 HTTP Range；只接受票据或 Authorization 头，不再接受 URL 上的 JWT）
- `GET/POST /v1/recordings/:id/clips`
- `PATCH /v1/clips/:id`（乐观锁，版本冲突返回 409）
- `GET/POST /v1/workspaces/:id/chapters`
- `PATCH /v1/chapters/:id`
- `POST /v1/chapters/:id/blocks`
- `POST /v1/chapters/:id/publish`
- `GET /v1/workspaces/:id/events`
- `GET /v1/realtime?workspaceId=...`（WebSocket）

健康检查为 `GET /health` 和 `GET /ready`。

## 音频播放安全

`<audio>` 标签无法携带 Authorization 头，因此播放流程分两步：

1. 前端用登录 JWT 调 `POST /v1/recordings/:id/playback-ticket` 换取不透明的随机票据；
   票据绑定具体录音和用户、存于 Redis、默认 10 分钟过期，前端在到期前自动换新。
2. 媒体请求使用 `GET /v1/recordings/:id/file?ticket=...`，服务端逐请求校验票据与录音归属；
   A 录音的票据不能用于 B 录音，越权 Range 请求在鉴权之前得不到任何文件信息
   （无权限返回 404，票据无效返回 401，通过鉴权后范围非法才返回 416）。

票据和 token 查询参数不会写入访问日志；媒体响应固定带 `Cache-Control: private, no-store`
与 `Referrer-Policy: no-referrer`。

服务端另有进程内的分片缓存（默认 1 MiB/片、上限 256 MiB，LRU），缓存键含录音 ID、
文件大小、mtime 与分片索引，文件被替换后旧分片永不命中；只有长度精确的完整分片才入缓存，
多段 Range 下载与断线重连始终按字节位置切分/拼接，不错位、不串内容。可通过
`SEGMENT_CACHE_SEGMENT_BYTES`、`SEGMENT_CACHE_MAX_BYTES`、`PLAYBACK_TICKET_TTL_SECONDS` 调整。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
