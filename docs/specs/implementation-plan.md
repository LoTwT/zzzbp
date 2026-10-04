# 首版开发方案（草案）

本稿整理技术选型、模块职责、实现顺序和验收重点，更新于 2026-10-04。工程引导已完成：仓库内已有应用包、Worker 与运行配置，`shared/` 与 `server/` 已落地 BP 规则、房间命令契约、HTTP 建房/入房/读取/目录入口与成员/展示 WS 实时通道（命令执行、去重回执与在线同步，见[架构与协议](../architecture.md)）；PR6 已交付常规浏览器房间界面（首页/入房/房间工作区、两选用布局与控制面板）及 WS 客户端连接管理，断线恢复等异常收口与展示页、归档记录随后续 PR 提供，规格与线框保留。前端沿用 Vue 3 与 TypeScript，由 `pnpm create vite` 的 `vue-ts` 模板初始化；代码质量采用 Oxlint、Oxfmt、simple-git-hooks 与 lint-staged，样式采用 Tailwind CSS 与 `@ayingott/theme`，Cloudflare 命令入口采用 `cf`，测试统一使用 Vitest 及其生态，输入校验采用 Zod。具体接入方式和兼容版本如下；依赖已安装并锁定在锁文件中，日常开发与验证命令见[开发指南](../development.md)。

## 目标与依据

首版交付一套能在电脑浏览器中完成建房、入房、安排选手、单局 BP、实时展示与归档查看的网站。以多人操作时结果一致、权限正确、断线后能恢复、历史结果可读取为验收主线。

产品规则继续由以下文档维护，本稿不复制完整规则：

- [单局常规 BP](single-game-bp.md)：顺序、预选、提交、暂停、撤回、换人与完成。
- [房间角色](room-roles.md)：成员身份、房主席位、进入方式与生命周期。
- [房间布局](room-layout.md)：当前采用的页面结构、权限差异与线框。
- [Cloudflare 部署与预算评估](cloudflare-budget.md)：已确认的 SQLite 存储与费用边界。

范围沿用上述首版定义，包括两个选用布局和独立展示页。传奇对决、移动端、账号系统、跨房间赛事管理、完整操作回放，以及向其他数据库复制记录均不加入本次实现。

## 技术组合

| 部分 | 方案 | 作用 |
|---|---|---|
| 前端 | Vue 3、TypeScript、Vite、Vue Router | 实现首页、房间、展示页和记录页，按身份切换可操作内容。 |
| 样式 | Tailwind CSS 4、`@ayingott/theme`（用户已指定） | 使用主题变量与基础样式，共用槽位、头像、表单和面板的视觉规则，按已确认线框实现。 |
| 前端辅助 | Reka UI、Lucide Vue、VueUse（用户已确认） | 复用基础交互、通用图标与浏览器组合式工具。 |
| 代码质量与提交 | Oxlint、Oxfmt、simple-git-hooks、lint-staged（用户已指定） | 负责代码检查、格式化、Git 钩子与暂存文件处理。 |
| 静态分发与动态入口 | 一个 Cloudflare Worker，配合 Workers Static Assets | 前后端同域，页面与静态数据直接分发，动态入口集中在 `/api/`。 |
| 房间服务 | 每个房间一个 SQLite Durable Object | 保存房间状态，校验权限与轮次，处理命令及广播。 |
| 实时连接 | WebSocket Hibernation API | 同步 BP、公开预选及成员状态，并支持空闲休眠。 |
| 到期处理 | Durable Object Alarm | 按生命周期处理空房间、归档及快照到期。 |
| 本地开发与验证 | pnpm、Cloudflare CLI（`cf`）、Cloudflare Vite 插件、Vitest | 在本地 Workers 运行时验证动态逻辑与存储。 |

最小实现采用一个应用包、一个 Worker 和一个房间对象类型。前端主要是客户端交互，现有需求没有必须由服务端渲染页面的部分，使用 Vue 与 Vite。

初始化使用 `pnpm create vite@latest` 的 `vue-ts` 模板，再接入 Cloudflare 插件及房间 Worker；保留现有规格和线框。2026-10-04 核对时，`create-vite` 最新发布为 9.2.1（2026-09-10），发布包中的 Vue TypeScript 模板含 Vue `^3.5.42`、Vite `^8.3.0`、TypeScript `~6.0.2`、`vue-tsc` 与 `@vue/tsconfig`。官方仓库模板仍在更新，主分支已经进一步更新部分依赖，因此发布包与主分支不能混为同一版本。依据 [create-vite 更新记录](https://github.com/vitejs/vite/blob/main/packages/create-vite/CHANGELOG.md)与[官方模板](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vue-ts)，发布包内容亦已只读核对。

静态页面使用 SPA 路由回退，`/api/*` 明确交给 Worker，避免接口地址被页面回退处理。路由语义参照官方 [SPA 路由文档](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)，配置采用下述 `cf` 的 TypeScript 格式。

## 初始化依赖

以下清单包含模板已有基础包、用户指定的替换项，以及接入所需的配套依赖；保留此前已指定的 Oxlint、Oxfmt、simple-git-hooks、Tailwind CSS 与主题包。清单已在工程引导中安装并写入锁文件；Cloudflare 相关工具按运行验证过的组合固定精确版本。

| 用途 | 包 | 说明 |
|---|---|---|
| 页面与路由 | `vue`、`vue-router` | 首页、房间、展示页及只读记录的前端基础。 |
| 基础交互组件 | `reka-ui` | 已确认首版加入，复用弹窗、提示及键盘与焦点管理，样式由 Tailwind 和主题包控制。 |
| 通用界面图标 | `@lucide/vue` | 已确认首版加入，按需导入设置、返回、关闭和复制等图标。 |
| Vue 组合式工具 | `@vueuse/core` | 已确认采用，在对应功能实现时按需引入，用于剪贴板、个人布局存储等浏览器能力。 |
| 构建与类型检查 | `vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc`、`@vue/tsconfig`、`@types/node` | 沿用模板提供的构建与类型工具；Node 类型用于构建配置，不混入浏览器环境。 |
| 样式接入 | `@tailwindcss/vite` | 使用 Tailwind 的 Vite 插件编译样式。 |
| 暂存文件检查 | `lint-staged` | 配合 simple-git-hooks，在提交前对暂存文件执行 Oxlint 与 Oxfmt。 |
| Cloudflare 开发 | `cf`、`@cloudflare/vite-plugin@beta` | 使用 `cf` 的 Vite 接入路径运行本地 Worker、Durable Object、静态资源及部署工具。 |
| 规则与房间测试 | `vitest`、`@cloudflare/vitest-plugin` | 当前选择满足 `^4.1.0` 的 Vitest 4.x，验证 BP 规则与 Workers 环境中的持久化、权限及同步逻辑。 |
| 浏览器交互测试 | `@vitest/browser-playwright`，按测试需要引入 | 通过 Vitest Browser Mode 在真实浏览器中验证交互；配套版本与 Vitest 一致。 |
| 运行时输入校验 | `zod` | 使用 Zod 4 的共享 schema 校验 HTTP 与 WebSocket 消息结构，并推导类型；成员权限与 BP 合法性仍由服务端业务逻辑检查。 |

代理人数据使用已选定的 `@randomplay/data`（LoTwT/fairy 仓库 packages/data 的发布包名），已按精确版本 0.2.1 归入开发依赖并生成只读目录，来源、生成脚本与更新办法见[代理人数据接入](agent-data.md)。开发工具归入开发依赖，应用运行所需的 Vue、路由与输入校验包归入应用依赖；数据包仅由生成脚本与测试使用，运行时只读取生成的目录产物，不进入构建产物。首次安装时核对插件的 peer dependencies，并将兼容版本写入锁文件。

`@ayingott/theme` 的公开约定要求 Tailwind CSS `^4.0.0`，入口顺序为先引入 Tailwind，再引入主题；字体入口按实际视觉需求选择。它提供主题变量、基础样式与工具类，房间组件依据本站规格实现。依据[主题包说明](https://github.com/LoTwT/design-system/tree/main/packages/theme)与 [Tailwind Vite 接入指南](https://tailwindcss.com/docs/installation/using-vite)。

格式化直接使用 Oxfmt 的 npm 包，支持 Vue 文件，并可开启 Tailwind 类名排序；排序配置指向本站 CSS 入口以识别主题扩展。依据 [Oxfmt 语言支持](https://oxc.rs/docs/guide/usage/formatter/language-support.html)与[排序配置](https://oxc.rs/docs/guide/usage/formatter/sorting.html)。

Oxlint 当前仅检查 Vue 文件的 `<script>` 区域；`vue-tsc` 用于 Vue 脚本及模板的类型检查，不能将这套组合视为完整 Vue 模板 lint 覆盖。依据 [Oxlint 支持范围](https://oxc.rs/docs/guide/usage/linter)与 [Vue TypeScript 指南](https://vuejs.org/guide/typescript/overview.html)。

暂存文件处理按用户选择采用 [lint-staged](https://github.com/lint-staged/lint-staged)。对同一批源码的 Oxlint 修复与 Oxfmt 格式化按顺序执行，避免不同 glob 的并发写入；保留其默认的部分暂存文件保护。输入校验按用户选择采用 [Zod](https://zod.dev/)，开启 TypeScript `strict`。

前端辅助依赖已确认采用 [Reka UI](https://reka-ui.com/docs/overview/introduction)、[Lucide Vue](https://lucide.dev/guide/vue/getting-started) 与 [VueUse](https://vueuse.org/guide/)。Reka UI 提供无预设样式的基础交互，本站仍自行实现 BP 槽位、代理人池和房间控制等业务组件。Lucide 负责通用界面图标，代理人属性、特性等游戏图标继续使用数据资源。复用上一轮对官方文档与包元数据的核对结果，具体依赖版本在初始化时锁定。

依赖选型已足以启动基础工程。脚本、Git 钩子、类型环境隔离和测试组织等常规配置由实现方按当前方案处理；后续确有新增库需要时，以实际功能和现有能力决定是否引入。CLI 与测试配置的实际兼容性仍需按下文验证。

### Cloudflare CLI 与测试兼容性

2026-10-04 核对时，`cf` 最新为 `1.0.0-beta.12`，官方仍标为 Beta。Vite 接入使用 `@cloudflare/vite-plugin` 的 2.0 Beta 分支，核对到的版本支持 Vite 7 与 8。采用 `cloudflare.config.ts` 统一声明 Worker 与绑定，并通过 SQLite Durable Object 导出配置声明房间类；此项目尚无旧配置需要迁移。依据 [cf 概览](https://developers.cloudflare.com/cf/)与[程序化配置](https://developers.cloudflare.com/cf/projects/cloudflare-config/)。初始化时将验证后的具体版本锁定，升级时重新验证配置与构建行为。

开发、构建、部署分别使用 `cf dev`、`cf build`、`cf deploy`。Worker 类型通过 `cf workers types` 生成到 `.cloudflare/types/index.d.ts`，前端、构建配置与 Worker 分开配置类型环境。`cf build` 和 `cf deploy` 直接调用 Vite 构建，不执行 `package.json` 中附加的检查步骤，因此项目脚本必须显式串联类型检查与构建；发布复用已检查的构建产物。依据 [cf 开发与构建指南](https://developers.cloudflare.com/cf/projects/)。

测试继续统一以 Vitest 为入口，但版本由 Workers 插件约束：核对时 `@cloudflare/vitest-plugin` 为 1.3.6，其 Vitest、runner 与 snapshot 的 peer 范围均为 `^4.1.0`，而 Vitest 最新主版本已为 5。首版使用兼容的 Vitest 4.x（工程引导锁定 4.1.11，插件锁定 1.3.6），浏览器 provider、UI 或覆盖率插件按需要选择同一版本。依据 [Workers 测试接入指南](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)及发布包元数据；浏览器方案依据 [Vitest Browser Mode](https://vitest.dev/guide/browser/)。

Workers 测试插件内部仍包含 Wrangler 依赖，其常规文档面向 Wrangler 配置，提供旧配置路径及 `main`、`miniflare` 参数。工程引导实际运行验证了另一条路径：1.3.6 的 `experimental.newConfig` 选项可以直接加载 `cloudflare.config.ts`，测试与 `cf dev`/`cf build`/`cf deploy` 共用同一份 Worker 入口、兼容性设置与 SQLite 房间对象声明，无需为测试单独维护绑定配置；依赖该插件的 Wrangler 内部依赖时须重新验证。项目日常命令采用 `cf`，不把 CLI 替换理解为整个依赖树完全移除 Wrangler。依据 [Workers 测试配置](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)。

## 模块职责

```text
浏览器页面 ----页面与静态文件----> Workers Static Assets
     |
     +------ HTTP / WebSocket --> Worker 动态入口
                                      |
                                      v
                              对应房间 Durable Object
                                      |
                                      v
                                 内置 SQLite
```

前端负责显示服务端状态和发送操作意图。选手、房主、观众与展示页共用禁选结果组件；控制能力依据服务端返回的当前身份和房间状态派生。

Worker 负责路由、输入检查与房间定位。房间对象拥有最终决定权：客户端传入的昵称、角色、轮次或选用结果不能直接成为可信状态。

建议目录按职责划分：

| 路径 | 职责 |
|---|---|
| `src/` | Vue 页面、共用组件、连接管理与个人显示设置。 |
| `shared/` | BP 顺序、状态转换、命令和公开视图的 TypeScript 定义。 |
| `server/` | Worker 入口、房间对象、身份校验、SQLite 持久化与 Alarm。 |
| `public/` | 可直接分发的静态文件。 |
| `tests/` | 规则与房间集成场景。 |
| `vite.config.ts`、`cloudflare.config.ts` | 本地运行、静态路由、房间绑定与 SQLite 对象导出及变更声明。 |

完整首版会涉及超过 8 个源码与配置文件。工程引导已按此结构建立骨架并逐步充实：`src/` 已落地首页、入房与房间工作区页面、房间组件与常规 WS 客户端连接管理（PR6，见[架构与协议](../architecture.md)），`shared/` 已落地 BP 规则、房间命令契约、纯函数状态转换与 HTTP/WS/视图/归档记录合同，`server/` 已落地 HTTP 入口、房间 Durable Object 与成员/展示 WS 通道（命令执行、去重回执与在线同步随 PR5 接入），后续运行时接入位置见架构文档。

## 页面与接口边界

建议页面入口为：

| 路径 | 行为 |
|---|---|
| `/` | 首页创建房间。 |
| `/rooms/:roomId` | 根据房间生命周期和身份，展示首次入房、实时房间或只读记录。 |
| `/rooms/:roomId/display` | 独立展示页，仅接收公开 BP 内容。 |

动态入口按建房、读取房间、加入成员和建立连接划分。实时命令统一交给房间对象处理，避免 HTTP 与 WebSocket 各自维护一套状态转换。只读记录按普通 HTTP 请求读取。

成员凭据由服务端生成并校验，浏览器保存用于恢复身份；昵称只作展示。展示连接单独标记，不能占据选手席位、计入成员在线状态或延长房间保留时间。具体权限仍以[房间角色](room-roles.md)为准。

## 状态与同步原则

1. 将 26 步及动作合法性整理为可独立验证的 TypeScript 规则。房间状态、生命周期、成员身份和选手席位分别表达，避免将房主等同于某一方选手，或将归档等同于 BP 完成。
2. 命令携带唯一操作标识与所依据的 BP 版本。服务端在保存前重新检查当前成员权限、操作位、房间状态和代理人可用性；重复提交、旧页面及换人前发出的过期命令不得推进流程。
3. 正式变更保存成功后再广播成功状态。发生写入或连接错误时，保留最后确认的结果，客户端明确显示失败或连接异常，不能自行把待提交内容当成成功结果。
4. 首版广播按访问权限生成的完整房间视图，重连也取得最新视图。身份凭据不进入广播，展示页仅获得公开 BP 内容。个人搜索、筛选和布局设置留在浏览器。
5. 保存当前预选及恢复房间所需的数据；SQLite 持久状态与 WebSocket 附件共同支持休眠恢复。附件用于识别连接，成员权限每次仍从房间当前状态判断，避免换人后沿用旧权限。
6. 暂停与换人后的状态变化复用同一规则入口。房主兼任选手、同身份多页面及原选手重新入房均按既有规格处理。

休眠时普通内存会被重建，连接附件和持久数据必须足以恢复状态。采用官方推荐的 [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)，不依赖常驻进程或定时写入整份状态。

## 数据与记录

代理人来源为固定版本的 `@randomplay/data` 数据包（fairy 仓库 packages/data 的 npm 发布名，当前 0.2.1、游戏数据 3.1）：构建时以锁文件固定依赖版本，由 `pnpm run generate:agent-catalog` 生成本站只读目录并提交入库，记录来源版本；实际名单、属性与特性字段及缺失数据见[代理人数据接入](agent-data.md)的导入概况。名称、头像缺失处理、排序与筛选遵循[代理人池规则](room-layout.md#代理人头像)，不从草图反推数据。

已部署页面使用随版本发布的目录产物，构建与 BP 运行不依赖上游仓库在线读取。头像继续使用数据包已记录路径，缺失头像留空；用户在上游补齐后通过数据版本更新接入。

每个房间保存房间元信息、成员与席位、当前 BP 状态、有效提交序列、预选及生命周期时间。按变化更新对应数据，不把完整广播内容当作每次必须重写的存储格式。

归档快照固定保存本局有效结果及顺序、必要的名称与展示信息、规则和数据版本、归档时间及到期时间，后续数据更新不能把旧记录解释成另一场结果。快照仍在该房间 SQLite 中，查看快照不建立成员连接。

Alarm 每次执行都重新检查当前生命周期和实际期限，重复执行不应生成第二份归档或重复推进状态。平台每个对象同时仅有一个 Alarm，且可能重试，因此归档与删除由同一生命周期处理器调度。依据 [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)。

## 实现顺序

首版作为一次完整功能交付，以下为内部实现顺序：

1. 整合官方开发结构和代理人数据，完成 BP 规则、权限及命令去重的测试。
2. 接通真实建房、入房、身份恢复与席位安排，用本地房间对象跑通从第一步到完成的完整流程。
3. 按已确认线框实现房间主界面、公共预选、筛选、两个选用布局与统一控制面板，并验证多个浏览器页面同步。
4. 补齐掉线暂停、重连、替换选手、撤回与重开，验证休眠后的状态和权限恢复。
5. 接入独立展示页、只读记录、归档与删除，完成多人流程、异常路径、桌面布局和资源用量验证。

主要工作量集中在身份与席位变化、多页面连接、休眠恢复及生命周期竞态。静态页面可以较快搭建，但只有上述流程全部通过才作为首版发布。

## 验证方式

在项目初始化时提供以下脚本入口，并由锁文件固定验证时使用的工具版本：

| 命令 | 检查目标 |
|---|---|
| `pnpm dev` | 运行前端与本地 Workers 环境。 |
| `pnpm lint` | 使用 Oxlint 检查源码。 |
| `pnpm format:check` | 使用 Oxfmt 检查格式。 |
| `pnpm format` | 使用 Oxfmt 格式化文件。 |
| `pnpm typecheck` | 先生成 Worker 类型，再检查前后端类型与共享协议。 |
| `pnpm test` | 执行 BP 规则和房间集成测试。 |
| `pnpm build` | 显式执行类型检查与 `cf build`，验证前端及 Worker 产物。 |

上述脚本已在工程引导中落地于 `package.json`，工具版本由锁文件固定。测试统一由 Vitest 执行，规则测试、Workers 集成测试与必要的浏览器交互测试使用独立配置，兼容版本与接入边界见上文。

必须覆盖的行为包括：

- 完整 26 步、连续本方选用、代理人互斥、AP9 完成，以及完成后撤回与重开。
- 越权操作、过期命令、重复确认、写入失败，以及同一身份两个页面几乎同时提交。
- 多页面仅关闭其中一个时仍在线；最后一个页面断开时触发既定暂停；换人后原选手的旧连接立即失去席位操作权。
- 休眠后恢复预选与权限；重连取得最新结果，恢复后仍按规则保持暂停。
- 展示连接不计为成员；只读记录没有写权限；归档执行与重新入房同时发生时结果一致；重复 Alarm 和快照到期清理。
- 已完成及未完成记录、空记录清理、缺头像、长房间名与队名、长代理人名、筛选后状态、展示页全量可读性。
- 在 1440 × 900 与 1280 × 640 的真实浏览器内容区检查布局；静态草图不能替代此项验证。

## 成本、依赖与实施前边界

推荐先使用 Workers Free 验证实际用量，继续沿用[费用边界](cloudflare-budget.md#费用边界)。免费方案支持 SQLite Durable Objects，超出对应免费限额后相关操作会失败；不能把 Workers Paid 的基础费用视为硬性账单上限。能力与计费依据 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)和 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)。

本方案最需验证的假设是：实际赛事连接数和消息频率能落在可接受额度内，同时掉线检测符合比赛使用需要。若不成立，需要依据实测调整容量或服务策略，不能直接以升级套餐解决预算约束。预选、重连和展示连接都纳入用量统计，测试记录检测到断线及暂停广播的实际延迟。

本地已发现 Node.js `v24.18.0` 与 pnpm `12.6.0`。`cf` 已作为项目开发依赖安装并在本地完成构建、开发与测试验证，不要求全局安装；Cloudflare 账户状态与部署凭据尚未配置，部署作为独立的发布动作处理。

本地开发不需要第三方业务 API 密钥。正式部署需要 Cloudflare 账户与部署凭据，使用 CLI 登录或环境凭据配置，不把凭据写入仓库。当前阶段不需要新增付费服务或修改 `fairy` 上游。

尚需收敛的事项及责任如下：

| 事项 | 推荐与责任 |
|---|---|
| 新 CLI 与测试配置适配 | 已在工程引导中完成并锁定：`cf` 1.0.0-beta.12、`@cloudflare/vite-plugin` 2.0 Beta、`@cloudflare/vitest-plugin` 1.3.6（`experimental.newConfig`）与 Vitest 4.1.11 的组合通过本地运行验证；升级任一依赖时重新验证配置与构建行为。 |
| 本场代理人名单与数据版本 | 已接入：npm `@randomplay/data` 0.2.1（游戏数据 3.1）导入 58 人名单（含 3 名缺头像），见[代理人数据接入](agent-data.md)的导入概况与更新办法。比赛专用白名单未核定（当前为主表全量，不构成功能阻塞）；fairy main 已合入未发布的 3.2 数据（60 人），后续以 npm 新发布版本走既定更新流程。 |
| 正式使用规模 | 用户提供预计同时开房与观众规模后，由实现方据此验证连接、预选与存储用量，作为部署前的容量依据。 |

生命周期与记录范围已经确认，统一遵循[房间保留与只读记录](room-roles.md#房间保留与只读记录)；上表事项在对应的实现与部署阶段处理。

## 发布与回退

实现先在本地完成，部署作为单独的发布动作。发布前完成上述检查，核对账户套餐和运行时用量，并保存当前代码版本与数据库结构版本。

前端展示调整可回退至兼容的上一构建。涉及房间持久数据时，迁移应保持旧数据可读；回退代码不得自动删除房间或回滚玩家已确认的结果。首次发布尚无现存应用数据，本轮方案整理也不涉及外部状态变更。
