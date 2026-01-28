# memebubbles

一个用于追踪 Dexscreener 热门/最新 token，并以“气泡图”形式展示的全栈项目。

- Web：Next.js（App Router）+ React + Tailwind + d3-force（Canvas 物理仿真）
- API：Fastify + Zod（聚合上游数据、去重、缓存、限流）
- Shared：前后端共享 TypeScript 类型，减少契约漂移

## 目录结构

```text
.
├── apps
│   ├── api            # Fastify API 服务（默认 3001）
│   └── web            # Next.js Web（默认 3000）
├── packages
│   └── shared         # 前后端共享类型（@memebubbles/shared）
├── pnpm-workspace.yaml
└── turbo.json
```

## 架构与数据流

1. Web 端通过相对路径请求：`/api/v1/...`
2. Web 端使用 Next.js `rewrites()` 将 `/api/v1/*` 代理到 `NEXT_PUBLIC_API_BASE_URL`（见 `apps/web/next.config.ts`）
3. API 服务从 Dexscreener 拉取数据（包含 top / latest boosts / ads / token profiles 等来源），做去重与补全（token meta、market cap、pair address 等）
4. API 内部带缓存与后台刷新：
   - `fresh` TTL：30s
   - `stale` TTL：120s（可返回陈旧数据，同时触发后台刷新）
   - 定时刷新：30s

## API（apps/api）

基础路径：`/api/v1`

- `GET /health`
  - 用途：健康检查 + 缓存状态
- `GET /bubbles/top-boosts?limit=30`
  - `limit`：`1~100`，默认 `30`
  - 返回：`TopBoostBubblesResponse`
- `GET /bubbles/recent?limit=100`
  - `limit`：`1~100`，默认 `100`
  - 返回：`RecentBoostBubblesResponse`

共享类型定义在：`packages/shared/src/index.ts`

## 环境变量

### Web（apps/web）

建议使用 `.env.local`：

- `NEXT_PUBLIC_API_BASE_URL`
  - 示例：`http://localhost:3001`
  - 作用：让 Next.js 将 `/api/v1/*` 代理到 API 服务

参考：`apps/web/.env.local.example`

### API（apps/api）

建议使用 `.env`：

- `HOST`：监听地址（默认 `0.0.0.0`）
- `PORT`：监听端口（默认 `3001`）
- `FRONTEND_ORIGIN`：CORS 允许的前端 Origin（本地默认 `http://localhost:3000`）
- `DEXSCREENER_TIMEOUT_MS`：Dexscreener 请求超时（毫秒）

参考：`apps/api/.env.example`

## 本地开发

### 1) 安装依赖

```bash
pnpm i
```

### 2) 配置环境变量

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local
```

> 注意：`.env` / `.env.local` 属于本地配置，建议不要提交到仓库。

### 3) 启动开发环境（推荐）

在仓库根目录：

```bash
pnpm dev
```

这会通过 Turborepo 同时启动 Web 与 API。

### 也可以分别启动

```bash
pnpm --filter @memebubbles/api dev
pnpm --filter web dev
```

## 构建与检查

```bash
pnpm build
pnpm typecheck
pnpm lint
```

API 单独测试（Vitest）：

```bash
pnpm --filter @memebubbles/api test
```

## 常见问题

- Web 请求 `/api/v1/...` 404
  - 检查 `apps/web/.env.local` 是否配置 `NEXT_PUBLIC_API_BASE_URL`，并重启 `pnpm --filter web dev`
- API 返回 502（上游暂不可用）
  - 通常是 Dexscreener 网络波动/限速/超时导致；可适当调大 `DEXSCREENER_TIMEOUT_MS`
- CORS 报错
  - 检查 `apps/api/.env` 的 `FRONTEND_ORIGIN` 是否与本地 Web 地址一致
