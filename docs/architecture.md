# 架构与协议

本文维护模块边界、共享合同结构与运行时接入位置，是当前实现边界的唯一正文。
产品业务规则由 [specs](specs/) 各文档维护，此处只链接、不重复；部署与工具链见
[开发指南](development.md)。

## 模块与依赖

| 路径 | 职责 | 依赖方向 |
|---|---|---|
| `src/` | Vue 页面、组件与浏览器连接管理。 | 依赖 `shared/` |
| `shared/bp/` | BP 规则：26 步权威顺序、互斥池、BP 进度状态。 | 不依赖浏览器或 Workers 运行时，可依赖 Zod 与共享 schema |
| `shared/agents/` | 代理人目录：固定版本的只读数据产物（`catalog.json`）、共享 Zod schema、目录派生接口（含头像图片 URL 派生）与纯数据搜索筛选。 | 不依赖浏览器或 Workers 运行时，可依赖 Zod；运行时只读产物，不导入上游数据包 |
| `shared/`（根） | 房间状态、命令契约与纯函数状态转换（`room.ts`、`commands.ts`、`transitions.ts`、`ids.ts`）。 | 依赖 `shared/bp/` |
| `shared/contracts/` | 网络合同：HTTP、视图投影、WebSocket、归档记录、版本信息。 | 依赖 `shared/` 根、`shared/bp/` 与 `shared/agents/` 的 schema（房间目录合同复用） |
| `shared/api.ts` | 引导期的 `/api/health` 契约，保留兼容；房间协议不在此扩展。 | — |
| `server/` | Worker 动态入口与房间 Durable Object：HTTP 路由与输入校验（`index.ts`）、房间对象编排（`room.ts`）、身份凭据与 Cookie（`credentials.ts`）、SQLite 持久化（`persistence.ts`）；BP 命令与 WS 随 PR5 接入。 | 依赖 `shared/` |
| `tests/rules/` | 纯规则与合同测试（Node 环境）。 | — |
| `tests/workers/` | Worker 与房间对象集成测试（真实 workerd）。 | — |

`shared/` 不依赖前端与服务端实现；服务端把 `shared/` 的纯函数作为唯一状态
权威，前端只用它做类型与展示推导。

## 身份与凭据边界

- 成员凭据由服务端生成并验证：256 位强随机秘密只在 `Set-Cookie` 响应中
  向浏览器交付一次，服务端只保存其 SHA-256 摘要（`members` 表，唯一
  约束，按摘要等值查找）；原始秘密不进入 JSON 响应、共享 `RoomState`、
  日志或公开目录。
- 身份 Cookie 按房间命名（`zzzbp_room_{roomId}`），属性为 HttpOnly、
  Secure、SameSite=Lax、Path=/，有效期 90 天（覆盖房间最长保留窗口的
  量级，过期后按新观众重新入房）。一房一 Cookie：同一浏览器的多房间
  身份共存互不覆盖；恢复身份不轮换凭据（不下发新 Set-Cookie，其他
  页面继续有效）；摘要只在对应房间的成员表内查找，凭据无法跨房间
  恢复权限。
- 带 Cookie 的写请求（POST 建房/入房）校验同源 Origin：携带第三方
  Origin 的 POST 一律拒绝；未带 Origin 的非浏览器请求放行，跨站防护
  由 SameSite=Lax 与本检查共同承担。
- JSON 响应与 WebSocket 广播绝不包含凭据；有效身份重开页面即可恢复当前
  角色（房主、席位或观众由房间状态派生）。
- 昵称仅用于展示，不用于身份查找；房间与成员 ID 由服务端生成（随机
  UUID），代理人 ID 来自构建时固定的数据目录；路由参数与各类 ID 均
  由服务端校验。
- 命令入口只接收服务端凭据解析出的 `RoomActor`；客户端载荷中的自报字段
  被 Zod 剥离，`targetMemberId` 只是席位的被安排对象，不是操作者身份。

## HTTP 接口

合同定义于 [shared/contracts/http.ts](../shared/contracts/http.ts)；
`/api/health` 为既有引导契约（[shared/api.ts](../shared/api.ts)）。

| 路径 | 行为 |
|---|---|
| `POST /api/rooms` | 建房（房名 + 首次昵称），创建者成为房主；响应房间 ID 与其成员视图，并经 Set-Cookie 下发房主身份。 |
| `GET /api/rooms/:roomId` | 按生命周期分流：live 返回房名（携带有效身份时附成员视图以恢复角色，匿名为 null 供首次入房）；archived 返回只读快照（PR9 接入）；不存在返回 404 错误体。 |
| `POST /api/rooms/:roomId/members` | 新成员以昵称作为观众加入并取得新身份；携带有效身份时恢复原身份（昵称被忽略、凭据不轮换、不重复建成员）。 |
| `GET /api/rooms/:roomId/catalog` | 返回该房间建房时固定的代理人目录快照（含来源版本）；只读，无需身份，不含成员或凭据数据，不计在线、不影响保留计时。 |
| `GET /api/health` | 引导期存储链路自检。 |

归档房间的原 URL 经普通 HTTP 读取快照，无需成员加入或 WebSocket。

通用约定：`/api/*` 的 JSON 响应均带 `Cache-Control: no-store`；请求体必须
是合法 JSON 并通过对应 schema（失败返回 400 `INVALID_REQUEST`）；已知
路径的非法方法返回 405；路由中的 roomId 非法返回 400；房间不存在返回
404 `ROOM_NOT_FOUND`（错误体均为 `apiErrorResponseBodySchema`）；未知
`/api` 路径维持引导期的 404 JSON。归档房间在 PR9 前没有任何转入路径，
读取归档分支当前是防御实现（410 `ROOM_ARCHIVED`），届时替换为快照响应。

## 房间持久化与固定目录

每个房间一个 SQLite Durable Object：`server/room.ts` 承担编排与视图
投影，`server/persistence.ts` 承担表结构与行级读写。表结构职责：

| 表 | 职责 |
|---|---|
| `room_meta`（单行） | 房间 ID/名称/lifecycle/创建时间、hostMemberId、revision、BP 状态/有效序列元信息（bp_status/bp_version/bp_preselect）、建房时固定的 rule_version 与 agent_data_version、last_member_left_at。 |
| `members` | 成员昵称、凭据 SHA-256 摘要（唯一约束）、加入时间、在线标志（初始恒为 0，仅实际成员 WS 连接可改变）。 |
| `seats` / `team_names` | A/B 席位占用与双方队名（初始空席、空队名）。 |
| `bp_submissions` | 当前有效序列：按 position 递增，装配时与权威顺序前缀校验。 |
| `room_catalog`（单行） | 建房时一次性保存的目录快照 JSON 文本。 |
| `schema_meta`（单行） | 业务表结构版本；`ensureRoomSchema` 是幂等的初始化/版本升级入口（当前版本 1，尚无更旧的已发布数据需要迁移）。 |
| `room_info`（legacy） | 引导期 `/api/health` 的存储自检记录（`shared/api.ts` 合同），由 DO 的 health 方法单独维护，与业务表互不干扰。 |

- 建房在单个 DO 方法内原子完成（连续同步 SQL 写入在输入门内不被
  交错）：房间行 + 首位房主成员 + 席位 + 队名 + 目录快照。初始状态为
  waiting、空席、空队名、无提交无预选，revision 与 bp.version 均为 0；
  房主身份（hostMemberId）与席位分开管理。成员加入只新增一行
  `members` 并递增 revision，不重写目录快照或其他成员。
- 目录与版本固定：建房时把当前部署经校验的目录快照与
  `BP_RULE_VERSION`（`shared/bp/version.ts`，规则版本的单一常量来源）
  写入该房间。此后该房间的规则名单（`toAgentCatalog`）、归档展示
  lookup（`toAgentDisplayLookup`）与 `GET /api/rooms/:roomId/catalog`
  一律从其持久快照派生；`server/` 不导入全局目录，部署升级不重解释
  旧房间的名单、展示或可选资格。数据来源与更新办法见
  [代理人数据接入](specs/agent-data.md)。
- 载入状态一律经 `roomStateSchema` / `agentCatalogSchema` 校验，不建立
  第二套 BP 规则；BP 命令语义（PR5）继续走 `shared/transitions.ts`
  纯函数，持久层只按变化更新对应行。
- 任意 GET 或错误 roomId 不创建业务房间：未建房的实例只会得到空表
  结构壳（`room_meta` 无行），一切读取按不存在处理。
- `last_member_left_at` 初始化为创建时刻：从未有成员连接的空房自创建
  起即开始 12 小时保留窗口的计时。只有实际成员 WS 连接（PR5）会将其
  置空并在全员离开时重置；HTTP 读写、目录读取与展示连接都不影响该
  计时；到期执行与 Alarm 在 PR9。

## WebSocket 通道

合同定义于 [shared/contracts/websocket.ts](../shared/contracts/websocket.ts)。
成员通道 `/api/rooms/:roomId/ws`（凭据经 Cookie 验证）与展示通道
`/api/rooms/:roomId/display/ws` 分离：

- 客户端业务消息复用 `roomCommandSchema`；系统入口（`setMemberOnline`）
  不在客户端联合中，无法注入。
- 展示通道始终没有写入口：即使携带房主凭据连接展示通道，也只接收
  展示视图，客户端消息一律不被接受。
- 服务端按连接身份推送 `memberView` / `hostView` / `displayView`、
  `commandResult` 与连接通知（`INVALID_MESSAGE`、`AUTH_FAILED`、
  `ROOM_ARCHIVED`、`ROOM_NOT_FOUND`）。
- 命令结果关联 `operationId` 与命令生效后的 `bp.version` / `revision`，
  不把包含全部成员的内部状态直接下发；结果之后服务端推送最新视图。
- 结果未知（超时或断线）时，客户端重连并取得最新完整视图后再决定；
  重发必须复用同一 `operationId`。
- `operationId` 持久化去重回执由后续 PR 实现。约定按
  room + member + operationId 辨认操作：重复的合法请求只返回同一处理
  结果而不再推进；同一 ID 配不同载荷不得当成新操作。去重是有限回执，
  不是完整操作历史。

## 状态、版本与命令

- 房间状态与 BP 进度由 `roomStateSchema` / `bpProgressSchema` 定义并
  校验（含序列前缀、代理人不重复、预选不得已用等不变量）。
- `agentDataVersion` 与规则版本在每间房间建房时固定：新房间建自
  `shared/agents` 目录（`agentDataVersion` 导出，构建时由固定版本数据
  包生成），规则版本取自 `shared/bp/version.ts` 的 `BP_RULE_VERSION`
  常量（单一来源）；已建房间的 `AgentCatalog.agentIds` 与归档展示
  lookup 从其持久目录快照派生（见[房间持久化与固定目录](#房间持久化与固定目录)）。
  数据来源与更新办法见[代理人数据接入](specs/agent-data.md)。
- `bp.version` 与公开 `revision` 职责分开：前者只随预选、提交、控制
  命令与席位权限变化递增（重开不重置），用于命令过期判断；后者随
  任何可见状态变化递增，用于视图同步。
- 命令由 `applyRoomCommand` 纯函数执行：检查顺序固定（身份 → live →
  在线 → 权限 → 前提 → 版本门 → 生效），失败零写入，空操作返回原引用；
  `setMemberOnline` 为服务端专用系统入口。
- 业务规则（暂停、撤回、换人、掉线）见[单局常规 BP](specs/single-game-bp.md)
  与[房间角色](specs/room-roles.md)。

## 视图投影

合同定义于 [shared/contracts/views.ts](../shared/contracts/views.ts)。
投影按显式白名单构造（嵌套对象同样逐字段重建，不共享输入引用），
绝不直接转发 `RoomState`：

| 视图 | 内容 | 接收者 |
|---|---|---|
| 公开 BP 视图 | 房名、队名、席位占用（匿名布尔，支撑空席「待选择」展示）、BP 状态、当前操作位、公开结果、公开预选、规则与数据版本、revision。 | 全部查看者可见的最小集合 |
| 成员视图 | 公开内容 + 自身身份/席位 + 命令所需 `bpVersion`。 | 普通成员 |
| 房主管理视图 | 成员视图 + 全体成员（昵称、席位、在线）。 | 仅房主 |
| 展示视图 | 与公开 BP 视图同形，无成员数据。 | 匿名展示连接 |

房主兼任选手、被换下席位后仍为房主等情形由 `isHost` 与 `seatTeam`
两个独立字段表达，投影始终正确。

## 生命周期与归档记录

合同定义于 [shared/contracts/records.ts](../shared/contracts/records.ts)。
产品规则见[房间保留与只读记录](specs/room-roles.md#房间保留与只读记录)；
时间常量：全员离开后空房保留 12 小时，只读快照自归档起 90 天。

- 本轮只定义时戳结构（`roomRetentionSchema`）、快照结构
  （`archiveSnapshotSchema`）、到期推导与 `projectArchiveSnapshot` 纯投影；
  Alarm 与自动归档不在此实现。
- 快照只保留最后一局当前有效顺序；每步含操作位、阵营、动作与归档时
  固定的代理人名称/头像，后续数据包更新不改变旧记录解释；不含预选、
  成员凭据或撤回/重开历史。空有效序列的房间到期直接清理，不生成快照。
- 运行时职责：实际成员 WS 连接在期限前回来即取消本次 12 小时计时，
  下次全员离开重新计算；展示连接永不影响计时；到期检查在 join、read、
  write 与 Alarm 中共用同一规则，不允许靠延迟 Alarm 延长可写期限；
  快照 90 天期限自转为只读起算，查看不延长。
- 持久化现状（PR4）：`lastMemberLeftAt` 已落在 `room_meta` 并在建房时
  初始化为创建时刻（见[房间持久化与固定目录](#房间持久化与固定目录)）；
  计时的取消/重置随 PR5 的成员 WS 接入，到期执行与 Alarm 在 PR9。

## 后续运行时接入位置

PR4 已落地持久房间、HTTP 建房/入房/读取/目录入口与匿名身份 Cookie
（见[身份与凭据边界](#身份与凭据边界)与[房间持久化与固定目录](#房间持久化与固定目录)）。

| PR | 接入点 |
|---|---|
| PR5（成员 WS 与同步） | 成员 WS 命令经 `applyRoomCommand` / `setMemberOnline` 执行并按身份投影广播（名单校验用 `loadRoomCatalog` 派生）、多页面在线计数与空房计时的取消/重置、`operationId` 持久化去重回执。 |
| PR9（归档与清理） | Alarm 与读写路径共用到期检查（读 `room_meta.last_member_left_at`）；到期经 `projectArchiveSnapshot` 生成快照或清理空房间；`GET /api/rooms/:roomId` 的 archived 分支替换为只读快照响应。 |
