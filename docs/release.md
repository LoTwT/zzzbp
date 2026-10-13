# 首版发布与验收说明

本文是首版（第一版）验收事实与发布条件的单一来源：记录已合入范围、验收结论、覆盖映射、
分层证据的适用范围、资源基线指向与发布条件清单；部署目标、部署记录与云端状态的证据边界、
人工验收指南与回退方案由[预发布部署与操作交接](deployment.md)维护。产品规则仍由
[specs/](specs/) 维护，实现边界由[架构与协议](architecture.md)维护，本文不重复正文。

## 当前状态

2026-10-13 核对的代码基线为 `main` `e2271dfd706e857adbdf88fcc39869218fdf0271`，
已通过该提交的完整 CI（见[验收门禁结果](#验收门禁结果已确认)）。以下是已合入代码的能力；
部署与公网验收状态统一见[当前部署证据边界](deployment.md#当前部署证据边界)，不由合并状态推断。

- 首版主线已完成：建房与入房身份、实时协作与权限、完整 26 步 BP、断线/重连/换人/
  结果未知核对、独立展示页、12 小时归档与 90 天只读记录、生命周期清理。后续已修复
  WebSocket 关闭处理、异步入房/接纳跨越期限时的重新裁决，以及存储故障后的在线投影与
  Alarm 补偿；合同与故障边界见[生命周期与归档记录](architecture.md#生命周期与归档记录)。
- 首页已有本机[最近参与](specs/room-layout.md#最近参与)清单：状态读取、显示更多、移除、
  清空确认，以及跨标签移除后迟到响应不复活记录。实时房间和记录页可返回首页；桌面布局、
  面板关闭与焦点、队名和成员管理、禁用按钮反馈已完成交互收尾，见[房间布局](specs/room-layout.md)。
- 固定目录仍为 `@randomplay/data` 0.2.1（游戏数据 3.1），58 人。本站同源方图、分类图标、
  已收录旧圆图副本与旧快照兼容已落地；图片重访使用后台重验证，冷加载使用新修订的重编码
  母图，保留旧路径。资源事实与更新流程以[代理人数据接入](specs/agent-data.md)为准；
  数据升级演练的适用范围见[分层证据边界](#分层证据边界)。
- [BP 结果导出](specs/room-layout.md#bp-结果导出)已支持文本复制与 PNG 下载：实时房间完成后
  可导出，归档可导出最后有效序列并标明未完成状态；包含图片失败占位、剪贴板降级与异步
  取消。Firefox/WebKit 导出专项及焦点修复已完成；后续 E2E 队名保存助手已按保存结论与重试
  语义收敛，main CI 已通过，证据见下文。

业务范围仍仅限桌面，登录与跨设备同步暂缓，不提供搜索；本机清单不赋予房间权限。房间只保留
最后一局的最终有效结果，归档后保留 90 天，不保存整场撤回/重开历史；权威规则见
[房间角色](specs/room-roles.md)与[房间布局](specs/room-layout.md#设备支持范围)。

## 验收主线与结论

以「多身份操作一致、权限正确、断线可恢复、展示只读、最终记录可读取、生命周期清理有效」
为一条完整交付线，验收结论如下（证据来源与适用范围见[覆盖映射](#覆盖映射)与
[分层证据边界](#分层证据边界)）：

| 验收目标 | 结论 | 主要证据 |
|---|---|---|
| 多身份操作一致 | 通过 | 真实浏览器 E2E 主线：UI 建房、隔离身份入房、分席开局、完整 26 步、公开预选与双页面同步；真人报告另见部署文档 |
| 权限正确 | 通过 | 观众/房主/选手权限断言（E2E + Workers 集成）；换人后原选手降级、房主兼任、越权命令拒绝 |
| 断线可恢复 | 通过 | 部分页面关闭不掉线、最后一页掉线暂停、断线期间本地可用/服务端禁用、原选手重连、结果未知同 operationId 收敛 |
| 展示只读 | 通过 | 匿名直开、实时同步、58 人全量同屏（卡片数量 + 裁剪容器无内部滚动 + 网格与末卡片几何包含）、零成员 WS/零 POST/零身份 Cookie |
| 最终记录可读取 | 通过 | 完成/未完成快照记录页、终态分流、真实 404；真实归档与 90 天清理由 Workers 生命周期测试证明 |
| 生命周期清理有效 | 通过 | 真实 workerd + SQLite 的到期裁决/快照/删除测试；本地测量确认清理后无业务表 |

## 验证方式与命令

统一以 Vitest 为入口；各命令职责分离，互不重复执行同一套测试（详见[开发指南](development.md)
「测试组织」）：

| 命令 | 内容 | 是否常规门禁 |
|---|---|---|
| `pnpm test` | 纯规则（`tests/rules`）、浏览器端纯逻辑（`tests/web`）与真实 Workers 集成（`tests/workers`） | 是（CI `verify`） |
| `pnpm test:e2e` | 真实浏览器验收（`tests/e2e`，Playwright 驱动真实 `cf dev`） | 是（CI `e2e`） |
| `pnpm measure:rooms` | 本地资源基准（`tests/measure`，真实 workerd + SQLite） | 否（按需运行） |
| `pnpm lint` / `format:check` / `typecheck` / `build` | 既有质量门禁 | 是 |

`pnpm test:e2e` 的进程与数据边界：默认端口 4517（`ZZZBP_E2E_PORT` 可覆盖），不占用 5173；
启动前检查端口占用，发现冲突即失败而不终止他人进程；`cf dev` 以独立进程组启动并在退出时
只回收自身进程；workerd 本地状态使用一次性临时目录，测试数据与开发状态互不污染。CI 的
`e2e` job 安装 Chromium（`pnpm exec playwright install --with-deps chromium`）后运行同一命令。

浏览器验收按下表映射到[现有 E2E 文件](../tests/e2e/)；用例集合以测试源码为准，执行结果以
对应提交的 CI 日志为准，不另维护动态总数。[CI](../.github/workflows/ci.yml) 常规浏览器门禁
仍为 Chromium，Firefox/WebKit 的专项证据与真实 Safari 边界见[分层证据边界](#分层证据边界)。

## 覆盖映射

| 规格主题 | 自动化位置 | 浏览器/人工证据 |
|---|---|---|
| 26 步顺序、代理人互斥、预选/确认/撤回/重开（[单局常规 BP](specs/single-game-bp.md)） | `tests/rules/bp-*`、`tests/workers/room-commands` | [mainline.spec.ts](../tests/e2e/mainline.spec.ts)：完整 26 步、公开预选与双页面同步、撤回/重开 |
| 身份、Cookie、权限、房主兼任、换人（[房间角色](specs/room-roles.md)） | `tests/workers/rooms`、`room-websocket`、`room-presence` | [mainline.spec.ts](../tests/e2e/mainline.spec.ts)、[resilience.spec.ts](../tests/e2e/resilience.spec.ts)：隔离身份、权限、换人与兼任 |
| 多页面、掉线暂停、重连核对（[房间角色](specs/room-roles.md)、[单局常规 BP](specs/single-game-bp.md)） | `tests/web/room-session`、`tests/workers/room-presence`、`room-commands` | [resilience.spec.ts](../tests/e2e/resilience.spec.ts)：部分页面关闭不掉线、末页关闭暂停、同 operationId 回执丢失重放只推进一次 |
| 桌面布局、筛选与控制面板（[房间布局](specs/room-layout.md)） | `tests/web/pick-layout`、`host-panels`、`operation-feedback`、`form-validation`、`team-name-draft` | [ui-details.spec.ts](../tests/e2e/ui-details.spec.ts)：身份提示、长队名、面板滚动/关闭/焦点、外部长按与拖动不穿透、分类图标失败；队名保存竞态回归 |
| 本机最近参与与清单管理（[最近参与](specs/room-layout.md#最近参与)） | `tests/web/room-history`、`history-status` | [home-history.spec.ts](../tests/e2e/home-history.spec.ts)：记录时机、匿名状态读取、状态分流、移除/清空、存储不可用与迟到响应 |
| 独立展示页（[实时展示页](specs/room-layout.md#实时展示页)） | `tests/web/display-*`、`tests/workers/room-websocket` | [display-record.spec.ts](../tests/e2e/display-record.spec.ts)：全量同屏几何断言、仅展示 WS、零 POST/零身份 Cookie |
| 归档、只读记录、12 小时与 90 天（[房间保留与只读记录](specs/room-roles.md#房间保留与只读记录)） | `tests/workers/room-lifecycle`、`room-presence`：受控时间戳 + 真实 Alarm、跨 await 到期重裁决、故障补偿与终态收口；`tests/web/record-view` | [display-record.spec.ts](../tests/e2e/display-record.spec.ts)：合法快照注入、完成/未完成记录、到期信息、零业务 WS/POST、终态分流与真实 404 |
| 数据目录、同源图片与旧快照（[代理人数据接入](specs/agent-data.md)） | `tests/rules/agent-catalog`、`agent-image-assets`、`agent-image-import`、`tests/web/record-view` | [mainline.spec.ts](../tests/e2e/mainline.spec.ts)：缺上游 `avatarPath` 的新目录代理人纳入主线，验证名称与流程；[display-record.spec.ts](../tests/e2e/display-record.spec.ts)：旧图加载失败占位；[result-export.spec.ts](../tests/e2e/result-export.spec.ts)：混合图片占位下导出；图片缓存/冷加载、旧修订兼容及数据升级演练见下文专项证据 |
| 文本/PNG 结果导出（[BP 结果导出](specs/room-layout.md#bp-结果导出)） | `tests/web/result-export` | [result-export.spec.ts](../tests/e2e/result-export.spec.ts)：多角色实时导出、完整/未完成归档、混合图片占位、剪贴板降级与焦点、内容变化/关闭面板/离页的异步取消 |
| 资源与预算估算（[Cloudflare 部署与预算评估](specs/cloudflare-budget.md)） | `tests/measure/room-resources`（按需运行） | 本地基准数字见预算文档 |

首版早期浏览器验收属于一次性证据，不作为维护入口；其中仍有效的验收事实（多身份 Cookie
隔离、全量同屏、记录页注入快照等）已由现有 `tests/e2e` 承接。2026-10-05 用户报告的预览实机多人
流程验收、2026-10-06 的自然归档只读回读（API 合同层）同属一次性证据，来源与适用边界见
[历史部署与公网验收](deployment.md#历史部署与公网验收)与[未验证边界](deployment.md#未验证边界与最小必要输入)。

## 分层证据边界

本轮文档对齐只核对源码、规格、Git 历史与已有记录，复用已执行的 CI 和专项证据；未重跑
全套单测/E2E、真人多人 BP 或自然归档。以下结论分别来自不同层，不得互相冒称：

- **Firefox/WebKit 导出专项（2026-10-12）**：复用 [PR #32](https://github.com/LoTwT/zzzbp/pull/32)
  的实施与审阅记录（合入 `6a6135b`）：Playwright 1.63.0 配套 Firefox 155、WebKit 26.6
  在本地 `cf dev` 上验证实时/归档导出的文本、剪贴板回读、PNG、降级、焦点与异步取消。
  这是导出专项的引擎覆盖，不是全站跨浏览器门禁，也不是生产构建或真实 Safari 实机验收；
  测试构建的剪贴板授权行为不代表零售浏览器默认权限。真实 Safari 当时因远程自动化未启用
  而未驱动，后续仅在相应授权与环境满足时验证。
- **图片缓存与冷加载（2026-10-12）**：复用 [PR #28](https://github.com/LoTwT/zzzbp/pull/28)
  （基于 `a3cdb5c`）的最终 SWR 方案及 [PR #31](https://github.com/LoTwT/zzzbp/pull/31)
  （基于 `a6fbc17`）的冷加载测量。两者使用本地构建产物 + workerd preview、Chromium；
  记录页采用合法归档夹具。前者验证响应头、后台重验证与缺失图片补齐后的恢复；后者验证
  冷加载传输量下降、旧修订/legacy 保留，以及桌面 DPR 1/2 和导出 PNG 的画质对照。
  SWR 仍有后台请求，冷加载优化不减少图片请求数；这些结果不证明云端响应头或其他浏览器
  的缓存性能。已否决的 immutable 方案不作为发布依据，最终语义见
  [浏览器缓存策略](specs/agent-data.md#浏览器缓存策略)，部署后抽查见部署文档。
- **数据升级演练（2026-10-12）**：复用 [PR #29](https://github.com/LoTwT/zzzbp/pull/29)
  （合入 `ae759da`）的历史回放与隔离合成演练：0.2.0 → 0.2.1 代理人输入相同；新增角色/
  分类、头像补齐、图片修订、缺项失败保留产物及旧目录/快照解释由合成输入验证。
  「npm 尚无 0.2.1 后续发布、真实新版本未验收」是 2026-10-12 的核验记录；本轮未重查
  npm 或升级数据包，不能将演练视为真实未来版本验收，见[未验证项](specs/agent-data.md#未验证项)。
- **真实 12 小时 / 90 天到期**：由 `tests/workers/room-lifecycle` 在真实 workerd + SQLite 上
  以受控时间戳 + 真实 Alarm 触发证明（该自动化层不等待自然 12 小时，也不在生产环境快进
  时间）；预览环境的自然归档回读见下条，两者勿互相冒称。
- **用户实机报告与自然归档只读回读（2026-10-05/06）**：沿用
  [历史部署与公网验收](deployment.md#历史部署与公网验收)中的用户报告与单次匿名 API 回读。
  前者没有完整设备/网络矩阵，后者只证明归档快照的 API 合同；不推导当前云端状态、浏览器
  记录页渲染或 90 天自然到期结果。
- **记录页 UI**：浏览器侧以「合法固定快照响应」注入验证（与 PR9 验收同一手法）；这不代表
  浏览器端走过自然归档流程，自然期限的受控测试与公网回读分别见上两条。
- **本地资源数字**：来自本地 workerd 观测（`pnpm measure:rooms`；SQL 行成本在测试侧透明
  包装房间实例的 `sql`、按真实执行路径读取语句消费后的 `cursor.rowsRead`/`cursor.rowsWritten`，
  不做语句复制或乘数推算；内容为 UTF-8 字节，存储为 `databaseSize` 分配），不是 Cloudflare
  计费实测；`setAlarm` 与平台内部读写未计入，运行时长不做本地换算。换算规则与边界见
  [预算文档](specs/cloudflare-budget.md#容量估算方法与本地基准)。
- **桌面布局与可读性**：当前测试覆盖 1024×768、1440×900 等桌面视口，以及 1280×640
  的较矮窗口；具体断言见覆盖映射中的文件。低于最小尺寸时允许整页滚动，不能把历史
  「同屏」结论套到所有页面与窗口。尺寸合同以[设备支持范围](specs/room-layout.md#设备支持范围)
  为准，移动端与更长名单不在这些证据的适用范围。

## 独立消融审查结论（冻结基线 8289bf2）

2026-10-05 的一次独立消融审查（冻结基线 `8289bf25d79a7556690b75cbd53bb692bbeef0e1`，
28 项机制消融 + 跨版本回执与字体环境追加探针）结论如下。这是一次过程性审查，不随仓库
维护；证据保存在任务临时目录，仅作当次核验用途，**不是未来部署必须存在的前置依赖**：

- 在本次代表性审查范围内，**未发现原版可复现的产品缺陷**；原版基准的 362 条常规测试、
  4 条真实浏览器 E2E 与 2 条资源测量全部通过，资源测量与冻结结果一致。该结论不表示
  穷尽正确性，也不替代部署验收。
- 初轮 28 项消融中 26 项被既有测试捕获（覆盖规则、Workers、web 与 E2E 层）；消融结果
  支持保留被检验的机制，本次未证明存在可安全删除的方案（适用边界见本节末）。
- **保留 `stableStringify`**（`server/ws.ts` 的命令载荷规范化；`server/room.ts` 的持久回执
  比较依赖其字节表示）：替换为 JSON 键序原样序列化后，同版本新回执无差异，但跨版本已存
  回执（模拟旧格式 payload 重放）会被误报 `OPERATION_ID_CONFLICT`。这属于删除方案的
  升级兼容风险与现有测试未覆盖的升级场景，不是当前产品缺陷；该次审查在部署前完成，当时
  无线上数据（预览上线后的当前状态见[预发布部署与操作交接](deployment.md)）。未来
  若改变持久载荷表示，必须先处理已有回执兼容并补跨版本重放回归。
- **保留字体实测**（`src/components/room/DisplayPool.vue`）：字符估算在默认本机环境被
  布局余量吸收，在受控字体注入下由既有几何断言捕获（`1006x563 vs 1006x555`，与历史 CI
  失败数值一致）；不将默认环境全绿称为测试缺口。组件级角色可见性回归仅由 E2E 层覆盖，
  继续保留该层门禁。
- 适用边界：真实云端部署与计费、跨版本升级、自然 12h/90d 生命周期（以受控时间戳 + 真实
  Alarm 替代）、公网延迟与非 Chromium 环境、全量 mutation 与移动端均未覆盖。

以上数字与结论均为冻结基线 `8289bf2` 的当次结果，不随仓库维护；2026-10-05 的关闭处理
修复（PR #15）另有独立回归与 CI，见「验收门禁结果」。

## 部署前检查清单

以下条件供后续获得授权的部署使用，本轮仅对齐文档。当前代码的门禁成功不代表已上线；
云端证据、操作步骤与预期结果由[预发布部署与操作交接](deployment.md)维护：

1. **代码与自动化基线**：记录待部署提交及对应 CI；本次核对结果见下节。后续代码变更应按
   影响补验，不能用 PR #13/#15 的冻结数字表示当前全量结果。
2. **账户、套餐与规模**：历史有界冒烟的授权、费用约束与未核实项见部署文档，不自动扩展为
   下一次部署或正式发布授权。正式规模需提供同时开房数、每房成员与展示页数、
   每日场次、预选频率；据此按[预算文档](specs/cloudflare-budget.md#容量估算方法与本地基准)
   的公式复核请求、行读写、运行时长与存储（存储关注每日场次 × 90 天）。
3. **剩余验证的条件**：真实 Safari 需相应环境与授权；真实未来数据版本需正式发布后按
   [版本更新办法](specs/agent-data.md#版本更新办法)验收。历史真人多人 BP 与自然归档已有
   有界结论，本轮不重跑，也不等待 90 天自然期限。
4. **部署后抽查**：获得部署授权并完成部署后，再核对健康检查、受影响流程、图片响应头与
   缺失路径行为；范围见[后续验证](deployment.md#后续验证)。既有人工指南用于按影响选择
   项目，不要求无差别重跑历史验收。
5. **回退准备**：操作时重新核对当前活动部署、目标版本与 schema 兼容性，保留历史恢复记录
   作为过程证据；不得据旧记录选定当前回退目标。房间结果、旧图片修订与 legacy 副本均须
   保留，规则见部署文档「回退方案」及[图片资源与公开路径](specs/agent-data.md#图片资源与公开路径)。

## 验收门禁结果（已确认）

### 最新核对基线（2026-10-13）

- `main` `e2271dfd706e857adbdf88fcc39869218fdf0271`（[PR #33](https://github.com/LoTwT/zzzbp/pull/33)
  合入）。[CI run 38280742185](https://github.com/LoTwT/zzzbp/actions/runs/38280742185)
  为该提交的 `push` 运行，状态 `completed/success`：`verify` 的 lint、format、typecheck、
  常规测试与 build，以及 `e2e` 的 Chromium 浏览器验收均成功。本轮只读复核并复用结果，
  没有在文档工作区重跑这些套件；用例数量与逐项结果以该次日志为准。
- PR #32 合入后的 [main CI 38274140788](https://github.com/LoTwT/zzzbp/actions/runs/38274140788)
  曾因队名保存尚未结算就继续开局准备而失败；
  PR #33 只修复 E2E 助手并增加确定性回归，等待保存结论、按界面提示重试。上述最新 CI
  已收齐成功结果，这次历史失败不再列为当前未完成项，也不表示新增了业务自动重试。

### 历史冻结基线（PR #13 / PR #15）

以下保留当时提交、测试数字与结论，用于追溯，不代表最新全量覆盖。

- **首版冻结实现 head** `da84d6974bd3cbdaa3deab0ae9e055917ead9997`，经 PR #13 合入 main
  `8289bf25d79a7556690b75cbd53bb692bbeef0e1`（本记录的冻结基线）。
- **GitHub CI run 37255243757**（最终实现 head 的完整 CI，父会话只读复核）：
  - `verify` job success：install（frozen lockfile）→ lint → format:check → typecheck →
    362 条常规测试（32 个文件，含真实 workerd 集成）→ build。
    <https://github.com/LoTwT/zzzbp/actions/runs/37255243757/job/111590789751>
  - `e2e` job success：安装 Chromium 后运行 `pnpm test:e2e`，4 条真实浏览器验收全部通过
    （mainline、resilience、display、record）。
    <https://github.com/LoTwT/zzzbp/actions/runs/37255243757/job/111590789662>
- **关闭处理修复门禁（2026-10-05）**：head `8eeeb90965c993e46527bad6097c017ad1b9b222`，
  经 PR #15 合入 main `a22ae3e4b8b3f92b0f77a289bf5181c221c8b408`
  （<https://github.com/LoTwT/zzzbp/pull/15>）。
  - CI run 37289235922（reviewed head）两个 job success：`verify`（lint/format/typecheck、
    完整 366 条常规测试与 build）与 `e2e`（真实浏览器验收）。
    <https://github.com/LoTwT/zzzbp/actions/runs/37289235922>
  - 实施记录（经父审阅）：4 项新增回归在原实现为红、修复后为绿（红绿日志经父审阅，父
    未重跑原版红）。父独立复核重跑受影响的两个 Workers 测试文件：32/32 通过。该门禁
    当时的云端证据限于匿名展示连接（展示页关闭握手）；成员路径的公网验收随后由用户
    2026-10-05 实机报告完成，自然归档只读回读于 2026-10-06 完成（见部署文档「历史部署与公网验收」
    与「未验证边界」）。
- 历史对照（冻结基线验收期间）：首次 CI run 37253719218 中 display 用例暴露跨字体布局
  缺陷，由后续提交 `a5f5122` 修复；修复后在同一实现期间本地复跑
  lint/format:check/typecheck、362 条测试与 build 均通过（工作树证据，未重跑）。
  `pnpm measure:rooms` 复用冻结提交 `17b3d3b` 的计量结果（展示网格修复未改动测量与服务端
  路径；SQL 计量为真实执行路径的透明包装，数字见预算文档）。
- 本地预发布准备复跑（`chore/preview-release`：main 8289bf2 + 预览名配置改动，部署前
  历史）：`pnpm typecheck`、`pnpm build`、`pnpm test`（362/362）与 `pnpm test:e2e`（4/4）
  通过；`cf deploy -m preview --dry-run` 本地通过且无远端写入（见部署文档）。
