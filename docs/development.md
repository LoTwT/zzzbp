# 开发指南

本文维护本仓库的日常开发与验证方法。产品范围与规格见 [文档索引](index.md)。

## 环境准备

- Node.js ≥ 24.11.0（本地已验证 v24.18.0；`cloudflare.config.ts` 的加载要求 Node ≥ 22.18，
  `@randomplay/data` 的 `engines` 要求 ≥ 24.11.0，项目声明与其对齐）。
- pnpm 12（`package.json` 的 `packageManager` 字段固定版本，CI 与本地保持一致）。
- 克隆后执行 `pnpm install`；CI 与发布验证使用 `pnpm install --frozen-lockfile`。

pnpm 12 默认禁止依赖运行安装脚本。`pnpm-workspace.yaml` 中的 `allowBuilds` 仅放行
`esbuild`、`workerd`（原生二进制）、`simple-git-hooks`（Git 钩子）与 `vue-demi`
（Vue 版本切换），其余依赖保持默认禁止。

pnpm 12 另有最小发布年龄（minimum release age）的供应链策略：过于新发布的版本会被
拒绝解析。升级依赖遇到该拦截时，优先选择已发布一段时间的兼容版本，而不是放宽策略。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | `cf dev`：启动前端与本地 Workers（workerd）环境。 |
| `pnpm lint` | Oxlint 检查源码。 |
| `pnpm format` / `pnpm format:check` | Oxfmt 格式化 / 校验，含 Tailwind 类名排序。 |
| `pnpm typecheck` | 先 `cf workers types` 生成 Worker 类型，再 `vue-tsc -b` 检查所有类型环境。 |
| `pnpm test` | Vitest：纯规则测试与真实 Workers 集成测试。 |
| `pnpm run generate:agent-catalog` | 从固定版本的 `@randomplay/data` 重新生成代理人目录产物；仅在数据版本更新时使用，日常构建与测试不运行（见[代理人数据接入](specs/agent-data.md)）。 |
| `pnpm build` | 显式串联 `typecheck` 与 `cf build`，产出 `.cloudflare/output/v0/`。 |

`cf` 不会执行 `package.json` 中的脚本，因此 `build` 必须自行串联类型检查；部署
（`cf deploy`）复用已检查的构建产物，属于独立的发布动作，CI 中不包含部署步骤。

## 本地开发与路由分流

`pnpm dev` 由 `cf` 委托 Vite 运行：前端走 Vite 开发服务器（含 HMR），Worker 代码在
本地的真实 workerd 运行时执行。分流规则集中在 [cloudflare.config.ts](../cloudflare.config.ts)：

- `/api/*` 通过 `assets.runWorkerFirst` 始终先进入 Worker；
- 其余请求优先匹配静态资源；未匹配的导航请求按 `single-page-application` 回退到
  `index.html`，支撑 SPA 前端路由。

本地自检方式：

```sh
curl http://localhost:5173/rooms/abc      # 返回 index.html（SPA 回退）
curl http://localhost:5173/api/health     # 返回 Worker 响应，包含房间 DO 的 SQLite 记录
curl http://localhost:5173/api/unknown    # Worker 返回 404 JSON
```

## 类型环境

四个 TypeScript 项目分别对应不同的运行环境（见根目录 `tsconfig.*.json`，由
`tsconfig.json` 统一引用）：

| 配置 | 覆盖范围 | 环境 |
|---|---|---|
| `tsconfig.app.json` | `src/`、`shared/` | 浏览器（DOM + Vue）。 |
| `tsconfig.worker.json` | `server/`、`shared/`、`cloudflare.config.ts` | Workers 运行时。 |
| `tsconfig.node.json` | `vite.config.ts`、`vitest.config.ts` | Node 构建配置。 |
| `tsconfig.test.json` | `tests/`、`shared/` | 测试（Workers 测试类型）。 |

Worker 的运行时与绑定类型由 `cf workers types`（或 Cloudflare Vite 插件在 dev/build
时）生成到 `.cloudflare/types/index.d.ts`；该目录被 gitignore，不要手工编辑或提交。
类型检查前必须先生成（`pnpm typecheck` 已串联该步骤）。房间 Durable Object 通过
`ctx.exports.Room` 访问，不需要 env 绑定；其声明与 SQLite 存储引擎在
`cloudflare.config.ts` 的 `exports` 中维护。

## 测试组织

`vitest.config.ts` 定义两个独立项目：

- `tests/rules/`：纯 TypeScript 规则与契约测试，Node 环境，不依赖 Worker 运行时；
  BP 规则测试在对应 PR 中加入。
- `tests/workers/`：Worker 与房间对象集成测试，运行在真实 workerd（miniflare）；
  通过 `@cloudflare/vitest-plugin` 的 `experimental.newConfig` 直接加载
  `cloudflare.config.ts`，与部署配置共用同一份入口、兼容性设置与 SQLite 房间对象
  声明。该组合（cf 1.0.0-beta.12 / vite-plugin 2.0 Beta / vitest-plugin 1.3.6 /
  Vitest 4.1.11）已在初始化时实际运行验证。房间 HTTP/身份/Cookie 流程经
  `exports.default.fetch` 以真实请求驱动；SQLite 持久化用 `cloudflare:test` 的
  `runInDurableObject` 直接观察实例内表行，实例重建用 `evictDurableObject`
  拆除实例（保留持久存储）后读回验证。

浏览器交互测试 provider（`@vitest/browser-playwright`）在需要真实浏览器验证交互时
引入，与 Vitest 保持同一版本；本阶段不编写空泛的 UI 测试。

Workers 集成测试中的 WebSocket 客户端模式：本套件选择对 Worker 发起带
`Upgrade: websocket` 头的 fetch，从 101 响应的 `webSocket` 字段取得客户端
socket 并 `accept()`（与 Worker 代理 DO 的官方模式一致）；当前生成的运行时
类型也声明了 `new WebSocket(url)` 构造器，但本套件未走该路径，未验证其
行为差异。实测边界：该 fetch 会把带 Upgrade 头的子请求规范化为 GET 握手，
因此「非 GET 方法拒绝 WS 升级」这类防御分支无法经此通道驱动。休眠语义用
`evictDurableObject` 验证：实例拆除后 hibernatable 连接与附件由运行时
保留，原连接上的消息以附件身份唤醒新实例（tests/workers/ 中的探针
结论已固化为 room-presence.test.ts 的回归测试）。

## 代码质量与提交

- Oxlint（`.oxlintrc.json`）负责代码检查；Oxlint 目前仅检查 Vue 文件的 `<script>`
  区域，模板与样式的类型检查依赖 `vue-tsc`。
- Oxfmt（`.oxfmtrc.json`）负责格式化，`sortTailwindcss` 指向
  `src/assets/main.css` 以识别主题扩展的类名顺序；`docs/` 与锁文件不参与格式化。
- 提交钩子由 simple-git-hooks + lint-staged 组成：pre-commit 对暂存文件先执行
  `oxlint --fix` 再执行 `oxfmt`（同一批文件顺序执行，避免并发写入），并保留
  lint-staged 默认的部分暂存保护。`pnpm install` 时自动安装钩子。
- 钩子安装依赖 `allowBuilds` 放行的 `simple-git-hooks`；若钩子缺失，运行
  `pnpm exec simple-git-hooks` 重新安装。

## CI

`.github/workflows/ci.yml` 在 push（main）与 pull_request 时执行：install
（frozen lockfile）→ lint → format:check → typecheck → test → build。不包含任何
部署步骤；部署凭据不进入仓库。
