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
| `pnpm test` | Vitest：纯规则测试、浏览器端纯逻辑与真实 Workers 集成测试（不含 E2E 与测量）。 |
| `pnpm test:e2e` | Vitest + Playwright：真实浏览器验收，自动启动/回收本地 `cf dev`（见「测试组织」）。 |
| `pnpm measure:rooms` | 本地资源基准：在真实 workerd + SQLite 上测量消息量、存储与耗时，输出 JSON（按需运行，部署前复核）。 |
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

五个 TypeScript 项目分别对应不同的运行环境（见根目录 `tsconfig.*.json`，由
`tsconfig.json` 统一引用）：

| 配置 | 覆盖范围 | 环境 |
|---|---|---|
| `tsconfig.app.json` | `src/`、`shared/` | 浏览器（DOM + Vue）。 |
| `tsconfig.worker.json` | `server/`、`shared/`、`cloudflare.config.ts` | Workers 运行时。 |
| `tsconfig.node.json` | 构建与测试配置（`vite.config.ts`、`vitest*.config.ts`） | Node 构建配置。 |
| `tsconfig.test.json` | `tests/`（不含 `tests/e2e`，含 `tests/measure`）、`shared/` | 测试（Workers 测试类型）。 |
| `tsconfig.e2e.json` | `tests/e2e/` 及其共享依赖 | Node + DOM 类型（Playwright 驱动与页面内 `evaluate`）。 |

Worker 的运行时与绑定类型由 `cf workers types`（或 Cloudflare Vite 插件在 dev/build
时）生成到 `.cloudflare/types/index.d.ts`；该目录被 gitignore，不要手工编辑或提交。
类型检查前必须先生成（`pnpm typecheck` 已串联该步骤）。房间 Durable Object 通过
`ctx.exports.Room` 访问，不需要 env 绑定；其声明与 SQLite 存储引擎在
`cloudflare.config.ts` 的 `exports` 中维护。

## 测试组织

`vitest.config.ts` 定义三个独立项目（常规门禁，`pnpm test`）：

- `tests/rules/`：纯 TypeScript 规则与契约测试，Node 环境，不依赖 Worker 运行时；
  BP 规则测试在对应 PR 中加入。
- `tests/web/`：浏览器端纯逻辑回归，Node 环境：表单字段校验（中文文案与
  trim/码点边界）、选用区布局推导、房主面板派生与 WS 会话状态机（注入假
  传输驱动，不依赖真实浏览器）、本机「最近参与」清单的存储与状态映射
  （注入假存储与假时钟）。
- `tests/workers/`：Worker 与房间对象集成测试，运行在真实 workerd（miniflare）；
  通过 `@cloudflare/vitest-plugin` 的 `experimental.newConfig` 直接加载
  `cloudflare.config.ts`，与部署配置共用同一份入口、兼容性设置与 SQLite 房间对象
  声明。该组合（cf 1.0.0-beta.12 / vite-plugin 2.0 Beta / vitest-plugin 1.3.6 /
  Vitest 4.1.11）已在初始化时实际运行验证。房间 HTTP/身份/Cookie 流程经
  `exports.default.fetch` 以真实请求驱动；SQLite 持久化用 `cloudflare:test` 的
  `runInDurableObject` 直接观察实例内表行，实例重建用 `evictDurableObject`
  拆除实例（保留持久存储）后读回验证。

真实浏览器验收（`pnpm test:e2e`，`tests/e2e/` + `vitest.e2e.config.ts`）：Vitest
的独立 Node 项目用 Playwright 驱动真实 `cf dev` 服务（Vite 前端 + 本地 workerd
Worker/SQLite），不 mock 建房/入房/命令结果。选型说明：多身份 Cookie 隔离、多页面
协同与 `page.routeWebSocket` 断线注入需要从 Node 编排并行浏览器上下文，
`@vitest/browser-playwright` 的测试代码运行在浏览器页面内、不适合作为编排入口，
故直接引入 `playwright`（1.63.0）而不引入 browser mode；测试入口仍统一为 Vitest。
服务由 `tests/e2e/global-setup.ts` 启动与回收：默认端口 4517
（`ZZZBP_E2E_PORT` 可覆盖），端口被占用时直接失败而不动他人进程；`cf dev` 以独立
进程组启动，退出时只向该进程组发信号并清理一次性持久化目录
（`ZZZBP_DEV_PERSIST_STATE` 注入，vite.config.ts 读取）。需要本机或 CI 安装
Chromium：`pnpm exec playwright install chromium`（CI 加 `--with-deps`）。
`pnpm test` 不包含 E2E，避免同一条命令重复运行同一套测试；CI 以独立 job 执行。

本地资源基准（`pnpm measure:rooms`，`tests/measure/` + `vitest.measure.config.ts`）：
同样在真实 workerd + SQLite 运行，测量典型房间与有界示例规模的消息量、UTF-8
内容字节、表行数、SQLite 分配大小、SQL 行成本（官方 SQL API 的
`cursor.rowsRead`/`cursor.rowsWritten`）与本地耗时；报告既打印到标准输出，也由
配置内的 reporter 持久化到 `node_modules/.tmp/measure-report.json`。按需运行，
不进入常规门禁。结论与估算方法见
[Cloudflare 部署与预算评估](specs/cloudflare-budget.md#容量估算方法与本地基准)。

浏览器交互测试 provider（`@vitest/browser-playwright`）未被首版采纳，理由同上；
如后续需要组件级浏览器测试再按需引入，并与 Vitest 保持同一版本。

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
- 界面配色统一取 `@ayingott/theme`（当前为默认 Paper 浅色主题）的语义角色：
  背景用 `--surface-canvas` / `--surface-panel` / `--surface-elevated` /
  `--surface-subtle` / `--surface-muted`，文字用 `--text-primary` /
  `--text-secondary` / `--text-muted` / `--text-inverse` / `--text-accent`，
  边界用 `--border-subtle` / `--border-default` / `--border-strong`，操作与强调用
  `--accent-primary(-hover/-active)` / `--accent-soft` / `--accent-contrast(-hover/-active)`，
  状态用 `--status-*`，焦点用 `focus-ring` 工具类；不再直接指定
  `neutral`/`lavender` 等固定色阶（图像遮罩、禁选状态遮罩按实际用途处理）。
  主题入口、密度变量与槽位动效见 `src/assets/main.css`；本轮不引入主题切换、
  深色（`.dark`）或 Neo-Brutalism 方案。
- 提交钩子由 simple-git-hooks + lint-staged 组成：pre-commit 对暂存文件先执行
  `oxlint --fix` 再执行 `oxfmt`（同一批文件顺序执行，避免并发写入），并保留
  lint-staged 默认的部分暂存保护。`pnpm install` 时自动安装钩子。
- 钩子安装依赖 `allowBuilds` 放行的 `simple-git-hooks`；若钩子缺失，运行
  `pnpm exec simple-git-hooks` 重新安装。

## CI

`.github/workflows/ci.yml` 在 push（main）与 pull_request 时执行两个 job：

- `verify`：install（frozen lockfile）→ lint → format:check → typecheck → test → build；
- `e2e`：install → 安装 Chromium（`pnpm exec playwright install --with-deps chromium`，
  浏览器缓存按 playwright 版本键入）→ `pnpm test:e2e`（测试自身启动/等待/回收本地
  `cf dev`）。

两个 job 都不包含部署步骤；部署凭据不进入仓库。E2E 失败时以 Playwright 的调用日志
与测试输出定位，不配置宽松重试。
