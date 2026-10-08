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
| `server/` | Worker 动态入口与房间 Durable Object：HTTP 路由与输入校验（`index.ts`）、房间对象编排与 WS 生命周期（`room.ts`）、身份凭据与 Cookie（`credentials.ts`）、SQLite 持久化与命令回执（`persistence.ts`）、WS 协议构件（`ws.ts`）。 | 依赖 `shared/` |
| `tests/rules/` | 纯规则与合同测试（Node 环境）。 | — |
| `tests/web/` | 浏览器端纯逻辑回归（Node 环境，注入假传输）。 | — |
| `tests/workers/` | Worker 与房间对象集成测试（真实 workerd）：HTTP/身份/Cookie（`rooms.test.ts`）、SQLite 持久化与实例重建（`room-storage.test.ts`）、WS 通道边界（`room-websocket.test.ts`）、命令管线与去重回执（`room-commands.test.ts`）、在线计数与休眠恢复（`room-presence.test.ts`）、生命周期裁决/归档快照/Alarm 调度与 90 天清理（`room-lifecycle.test.ts`），共享辅助 `ws-helpers.ts`。 | — |
| `tests/e2e/` | 真实浏览器验收（PR10）：Vitest Node 项目 + Playwright 驱动真实 `cf dev`；`global-setup.ts` 管理服务与临时持久化目录，覆盖主线 26 步、断线/换人/核对、展示页与记录页，以及首页「最近参与」清单（`home-history.spec.ts`：记录时机、状态分流、清空确认、在途响应不复活记录、键盘与滚动）。 | — |
| `tests/measure/` | 本地资源基准（PR10，按需运行）：真实 workerd + SQLite 的消息量、表行数、SQLite 分配与本地耗时测量。 | — |

`shared/` 不依赖前端与服务端实现；服务端把 `shared/` 的纯函数作为唯一状态
权威，前端只用它做类型与展示推导。

## 身份与凭据边界

- 成员凭据由服务端生成并验证：256 位强随机秘密只在 `Set-Cookie` 响应中
  向浏览器交付一次，服务端只保存其 SHA-256 摘要（`members` 表，唯一
  约束，按摘要等值查找）；原始秘密不进入 JSON 响应、共享 `RoomState`、
  日志或公开目录。
- 身份 Cookie 按房间命名（`zzzbp_room_{roomId}`），属性为 HttpOnly、
  Secure、SameSite=Lax、Path=/，有效期 90 天。90 天是凭据自身的寿命，
  与房间生命周期独立（live 房间没有固定的最大存续时长）；过期后浏览器
  丢失该房间身份，按新观众重新入房，房间数据与保留计时不受影响。
  一房一 Cookie：同一浏览器的多房间身份共存互不覆盖；恢复身份不轮换
  凭据（不下发新 Set-Cookie，其他页面继续有效）；摘要只在对应房间的
  成员表内查找，凭据无法跨房间恢复权限。
- 带 Cookie 的写请求（POST 建房/入房）校验同源 Origin：携带第三方
  Origin 的 POST 一律拒绝；未带 Origin 的非浏览器请求放行，跨站防护
  由 SameSite=Lax 与本检查共同承担。
- JSON 响应与 WebSocket 广播绝不包含凭据；有效身份重开页面即可恢复当前
  角色（房主、席位或观众由房间状态派生）。
- 昵称仅用于展示，不用于身份查找；房间与成员 ID 由服务端生成（随机
  UUID），代理人 ID 来自构建时固定的数据目录；路由参数与各类 ID 均
  由服务端校验。
- 浏览器本机另存一份「最近参与」房间清单（`localStorage`，一房一键、
  按格式版本命名，实现见 `src/room/room-history.ts`）：只含房间 ID、
  服务端确认的房间名与最近参与时间，不含身份 Cookie、成员凭据、成员
  名单或 BP 快照，跳转路径由合法 roomId 生成。清单与身份互相独立：
  删除条目或清空清单不改变 Cookie 与成员身份，清单内容也不构成身份或
  权限来源（进入房间仍只由 Cookie 恢复角色）。存储被禁用、配额不足或
  个别记录损坏只降级本功能：读取跳过损坏记录，写入失败返回原因，并由
  首页清单提示未保存（提示是 `sessionStorage` 里的一个失败原因枚举，
  只保留同标签页的会话状态，不含房间数据）。产品规则见
  [本机参与记录](specs/room-roles.md#本机参与记录)，界面见
  [最近参与](specs/room-layout.md#最近参与)。
- 命令入口只接收服务端凭据解析出的 `RoomActor`；客户端载荷中的自报字段
  被 Zod 剥离，`targetMemberId` 只是席位的被安排对象，不是操作者身份。

## HTTP 接口

合同定义于 [shared/contracts/http.ts](../shared/contracts/http.ts)；
`/api/health` 为既有引导契约（[shared/api.ts](../shared/api.ts)）。

| 路径 | 行为 |
|---|---|
| `POST /api/rooms` | 建房（房名 + 首次昵称），创建者成为房主；响应房间 ID 与其成员视图，并经 Set-Cookie 下发房主身份。 |
| `GET /api/rooms/:roomId` | 按生命周期分流：live 返回房名（携带有效身份时附成员视图以恢复角色，匿名为 null 供首次入房）；archived 返回只读快照（原房主、成员与匿名取得同一份，读取不建立实时连接、不刷新期限）；不存在或已清理返回 404 错误体。首页「最近参与」清单的状态读取以 `credentials: "omit"` 走同一入口的匿名响应，不恢复身份、不创建成员、不建立任何实时连接，也不延长保留期限；读取路径仍会执行已到期的归档/清理裁决，并在裁决前按实际连接协调在线投影——故障遗留的分叉在存储恢复后的第一次读取就补齐（协调无法完成时读取闭口为 500，不对外返回已知分叉的投影）（见[生命周期与归档记录](#生命周期与归档记录)）。 |
| `POST /api/rooms/:roomId/members` | 新成员以昵称作为观众加入并取得新身份；携带有效身份时恢复原身份（昵称被忽略、凭据不轮换、不重复建成员）。新成员写入成功后向已连接的成员/展示连接广播最新视图。归档房间返回 410 `ROOM_ARCHIVED`（读取记录走 GET 房间入口，不需要加入成员）。 |
| `GET /api/rooms/:roomId/catalog` | live 房间返回建房时固定的代理人目录快照（含来源版本）；只读，无需身份，不含成员或凭据数据，不计在线、不影响保留计时（与房间入口同一在线协调与裁决，仅在投影与实际连接分叉时补齐）。归档房间返回 410（目录行随操作期数据清理，记录展示信息全部固定在快照内）。 |
| `GET /api/rooms/:roomId/ws` | 成员实时连接升级（详见[WebSocket 通道](#websocket-通道)）。非 GET 返回 405；缺少 `Upgrade: websocket` 头返回 426；第三方 Origin 返回 403。 |
| `GET /api/rooms/:roomId/display/ws` | 匿名展示连接升级（同上协议校验）；通道语义见[WebSocket 通道](#websocket-通道)。 |
| `GET /api/health` | 引导期存储链路自检。 |

归档房间的原 URL 经普通 HTTP 读取快照，无需成员加入或 WebSocket。

通用约定：`/api/*` 的 JSON 响应均带 `Cache-Control: no-store`；请求体必须
是合法 JSON 并通过对应 schema（失败返回 400 `INVALID_REQUEST`），且按
实际字节数限制在 8 KiB 内（流式计数，缺失或不真实的 Content-Length 不
能绕过；超限返回 413）；已知路径的非法方法返回 405；路由中的 roomId
非法返回 400；房间不存在返回 404 `ROOM_NOT_FOUND`（错误体均为
`apiErrorResponseBodySchema`）；未预期异常（DO RPC、存储、状态装配等）
由统一错误边界转换为 500 `INTERNAL` 通用错误体，不泄漏内部细节，并记录
结构化诊断（见[错误诊断与可观测性](#错误诊断与可观测性)）；
未知 `/api` 路径维持引导期的 404 JSON。

## 错误诊断与可观测性

- 统一错误边界在返回通用 500 错误体的同时，向 Workers Logs 输出一条
  结构化 JSON 诊断，字段固定为白名单：事件名、本次请求生成的
  `requestId`、HTTP 方法、路径（不含查询串）与静态分类 `internal`。
  错误自身的 message、name、cause、stack 与任何原始错误值一律不写入
  应用日志：统一边界无法甄别任意异常内容，这些字段可能携带上游或请求
  相关的敏感输入（例如请求体流读取失败的异常文本），可自定义的
  `error.name` 也不是可信分类；更细的稳定分类应在抛出点定义，不由边界
  透传错误自带字段。请求头、Cookie、请求体、凭据秘密或摘要同样不记录。
  500 响应通过 `X-Request-Id` 头返回同一 `requestId`，便于把现场报告
  与日志对照。
- 日志与 trace 的开关与采样集中在 [cloudflare.config.ts](../cloudflare.config.ts)，
  不依赖平台或账户默认值：日志开启，`headSamplingRate` 为 1 使错误
  诊断不被随机丢弃，但 `invocationLogs` 关闭，成功请求不产生逐请求
  日志；trace 开启并按 0.05 头部采样，控制在满足低成本约束的前提下
  保留可查样本；日志与 trace 中的查询串一律脱敏。
- 代码事实与部署事实分开：上述配置随构建写入 `worker.config.json`，
  实际采集、保留与计费取决于部署账户的日志/trace 状态与采样；官方
  说明新建 Worker 的 Workers Logs 默认可开启、trace 需独立开启，本项目
  不依赖这些默认状态，但未部署验证前不能把“已显式配置”当成“已生效”。

## 房间持久化与固定目录

每个房间一个 SQLite Durable Object：`server/room.ts` 承担编排与视图
投影，`server/persistence.ts` 承担表结构与行级读写。表结构职责：

| 表 | 职责 |
|---|---|
| `room_meta`（单行） | 房间 ID/名称/lifecycle/创建时间、hostMemberId、revision、BP 状态/有效序列元信息（bp_status/bp_version/bp_preselect）、建房时固定的 rule_version 与 agent_data_version、last_member_left_at。 |
| `members` | 成员昵称、凭据 SHA-256 摘要（唯一约束）、加入时间、在线标志（初始恒为 0，仅实际成员 WS 连接可改变）。 |
| `seats` / `team_names` | A/B 席位占用与双方队名（初始空席、空队名）。 |
| `bp_submissions` | 当前有效序列：按 position 递增，装配时与权威顺序前缀校验。 |
| `command_receipts` | operationId 去重回执：按 (member_id, operation_id) 主键，保存规范化载荷与原结果（含稳定错误码与版本），写入时裁剪到每房间 2048 条的保留窗口（见[WebSocket 通道](#websocket-通道)）。 |
| `room_catalog`（单行） | 建房时一次性保存的目录快照 JSON 文本；归档时随操作期数据清理（记录展示信息固定进快照）。 |
| `archive_snapshot`（单行，v3） | 归档快照 JSON 文本（`archiveSnapshotSchema` 生成并校验）；归档转换与生命周期标记、操作期数据清理同事务写入，是归档房间的唯一可服务数据。 |
| `schema_meta`（单行） | 业务表结构版本；`ensureRoomSchema` 是幂等的初始化/版本升级入口（当前版本 3：v1 → v2 新增 `command_receipts`，v2 → v3 新增 `archive_snapshot`，均无历史数据搬移；更高版本拒绝加载，防降级误读）；读取路径先经只读的 `hasRoomSchema` 判断实例是否已初始化。 |
| `room_info`（legacy） | 引导期 `/api/health` 的存储自检记录（`shared/api.ts` 合同），由 DO 的 health 方法单独维护，与业务表互不干扰。 |

- 建房与入房各为一个 `transactionSync` 同步事务闭包：schema 初始化、
  存在性检查、全部写入与写入后的状态装配同在一个事务内，任一步骤抛
  异常（SQL 故障、校验失败、装配失败）时平台回滚整个事务，不留半建房
  或无凭据交付的孤儿成员。DO 的单线程执行与输入门只保证语句不被其他
  事件交错，不提供异常回滚，两者不可混同。建房初始状态为 waiting、
  空席、空队名、无提交无预选，revision 与 bp.version 均为 0；房主身份
  （hostMemberId）与席位分开管理。成员加入只新增一行 `members` 并递增
  revision，不重写目录快照或其他成员。
- 目录与版本固定：建房时把当前部署经校验的目录快照与
  `BP_RULE_VERSION`（`shared/bp/version.ts`，规则版本的单一常量来源）
  写入该房间。此后该房间的规则名单（`toAgentCatalog`）、归档展示
  lookup（`toAgentDisplayLookup`）与 `GET /api/rooms/:roomId/catalog`
  一律从其持久快照派生；房间对象与一切房间读取只使用该持久快照
  （全局目录仅在 Worker 建房入口作为创建输入注入一次），部署升级不
  重解释旧房间的名单、展示或可选资格。数据来源与更新办法见
  [代理人数据接入](specs/agent-data.md)。
- 载入状态一律经 `roomStateSchema` / `agentCatalogSchema` 校验，不建立
  第二套 BP 规则；BP 命令语义走 `shared/transitions.ts` 纯函数，持久层
  只按变化更新对应行（`persistRoomStateChange`：room_meta 标量、变化的
  队名/席位/成员在线行、有效序列按前缀追加或删除，空操作零写入）。
- 读取路径不初始化存储：房间读取、目录读取与入房失败先经只读的
  `hasRoomSchema` 检查实例是否已有业务表结构；从未建房的实例保持
  完全空存储（不创建任何业务表），一切读取按不存在处理。随机或错误
  的 roomId 不会因 GET 或失败入房建立 7 张业务表与版本行、留下永不
  回收的持久数据。表结构已存在时（建房与既有房间）仍经
  `ensureRoomSchema` 幂等校验或迁移，建房与写入的事务保障不变。
- `last_member_left_at` 初始化为创建时刻：从未有成员连接的空房自创建
  起即开始 12 小时保留窗口的计时。只有实际成员 WS 连接会将其置空
  （首个连接取消计时）并在全员离开时重置（最后一名在线成员离开时写入
  当前时刻）；HTTP 读取、目录读取与展示连接都不建立参与、不影响该
  计时——读取只在投影与实际连接分叉时按实际连接补齐离线与计时起点
  （一致时零写入，展示连接从不触发协调）；到期裁决
  与 Alarm 调度见[生命周期与归档记录](#生命周期与归档记录)。

## WebSocket 通道

合同定义于 [shared/contracts/websocket.ts](../shared/contracts/websocket.ts)；协议构件在
[server/ws.ts](../server/ws.ts)，连接生命周期与编排在
[server/room.ts](../server/room.ts)。成员通道 `/api/rooms/:roomId/ws`
（凭据经 Cookie 验证）与展示通道 `/api/rooms/:roomId/display/ws` 分离，
均经 WebSocket Hibernation API 接入（`acceptWebSocket` + 附件 + 标签）：

- 升级校验分工：Worker 做协议级校验（方法 GET、`Upgrade` 头、同源
  Origin——与 HTTP 写请求同一策略，未带 Origin 的非浏览器请求放行）；
  房间 DO 校验路径形态（roomId 与实例名一致）、房间存在性与生命周期、
  成员通道的身份。房间级失败（`ROOM_NOT_FOUND` / `ROOM_ARCHIVED` /
  `AUTH_FAILED`）接受连接后以通知说明并关闭（1008）：浏览器拿不到握手
  状态码，通知比 HTTP 错误体更可用，且不产生任何持久写入。
- 未知 roomId 的实例保持完全空存储：升级前经只读 `hasRoomSchema` 探测。
- 接纳顺序：升级时先做生命周期裁决（新连接尚未计入注册表），到期房间
  在接纳前完成归档或清理：归档按 `ROOM_ARCHIVED`、清理后按
  `ROOM_NOT_FOUND` 拒绝。收口的异步存储操作（Alarm 应用、终态收口）
  之后、实际注册连接之前再按当前时刻同步重判一次——await 期间的时钟
  推进不能让已到期房间连同写权限一起被恢复，重判与注册在同一同步段内
  完成，不重复打开该窗口（见[生命周期与归档记录](#生命周期与归档记录)）。
- 客户端业务消息复用 `roomCommandSchema`：系统入口（`setMemberOnline`）
  不在客户端联合中，无法注入；命令操作者一律来自连接附件中的可信身份
  （升级时验证的成员 ID），角色/席位/轮次/状态/版本与名单每次从当前
  持久状态重新判断，不从附件缓存权限。
- 展示通道始终没有写入口：即使携带房主凭据连接展示通道，也只接收
  展示视图，客户端消息一律不被接受；展示连接不计任何成员在线、不
  影响保留计时，也永远不成为成员。
- 消息边界：二进制消息（1003）与超过 8 KiB 的文本消息（1009）在解析
  前拒绝并关闭连接；非法 JSON 与不符合命令契约的小消息只回
  `INVALID_MESSAGE` 通知，连接保持。
- 命令处理（`processMemberCommand`）在一个 `transactionSync` 闭包内原子
  完成：读取当前状态 → 回执去重 → 规则版本门 → `applyRoomCommand` →
  按变化差异持久化 → 写回执；写成功后才发送 `commandResult` 并广播。
  SQL 或状态装配故障时整体回滚（状态与回执一致、无成功广播），按
  `INTERNAL` 稳定错误码回执，客户端可凭同一 operationId 重试。单个
  连接的发送失败不影响已提交命令的对外结果，也不阻塞其他连接。
- 规则版本门：房间的持久 ruleVersion 不等于当前引擎的
  `BP_RULE_VERSION` 时拒绝一切命令（`RULE_VERSION_UNSUPPORTED`），
  不能拿当前语义解释未知版本的已保存状态；视图仍按事实投影恢复。
- 服务端按连接身份推送 `memberView` / `hostView` / `displayView`：
  状态变化（命令、成员上下线、HTTP 新成员加入）时向全部连接广播各自
  形态的最新视图；命令结果之后操作者连接总会再收到最新视图。命令
  结果关联 `operationId` 与命令生效后的 `bp.version` / `revision`。
- operationId 持久化去重回执（`command_receipts` 表）：按
  room + member + operationId 辨认操作，回执与状态更新同事务写入。
  同一规范化载荷（Zod 解析后重建、键序无关）重发返回原结果且不再
  执行；同一 ID 配不同载荷以 `OPERATION_ID_CONFLICT` 拒绝。回执是
  有限窗口：每房间保留最近 2048 条（按写入顺序淘汰最旧，插入时
  裁剪）；窗口内同一身份多页面、连接重建与 DO 重建后的重发都命中
  原回执。窗口外被淘汰后的重发按新命令处理，由可持久验证的前置
  条件兜底：推进 BP 流程或席位权限的命令都会递增 bp.version，旧
  重发以 `STALE_BP_VERSION` 过期或因步位推进被拒
  （`NOT_CURRENT_PLAYER`）；`setTeamName` 是唯一产生可见变化但不递增
  bp.version 的命令，额外携带 `expectedRevision`（必须与当前公开
  revision 严格一致），任何后续可见变化（含后续改名）都使旧载荷以
  `STALE_REVISION` 过期，防止淘汰后的旧重试覆盖后来确认的名称。
  收到过期拒绝的客户端应重新同步视图并以新 operationId 重发。
- 成员在线判定以实际连接为唯一权威：连接注册表（`getWebSockets` +
  附件）推导实际在线成员集合，且只有 readyState 为 OPEN 的成员连接
  计为在线（展示连接与被拒连接从不计入）；存储中的 online 标志只是
  它的持久投影。close 回调触发时，被关闭的连接可能仍处于 CLOSING/
  CLOSED 且仍被注册表枚举（线上观测：2026-10-05 预发布一次匿名展示
  关闭中 close 回调内 readyState=2、listed=true），关闭中的连接已不
  可用，不能按附件直接计为在线；同一身份其他 OPEN 页面仍使成员在线
  （多页面语义不变）。
  成员连接、断开、每条业务命令、HTTP 入房、房间/目录读取与 Alarm
  处理器都会先做在线协调（reconcilePresence，同一事务）：把存储标志
  对齐到注册表——断开者置离线（进行中房主或在席选手立即暂停）、仍有
  连接者保持在线并取消空房计时、全员离线且计时未记录时补写离开时间；
  无分叉时零写入（重算幂等，不会重复离线/暂停）。读取与 Alarm 只在
  投影分叉时写入，读取本身不建立连接、不计在线、不重置已记录的离开
  时间，补齐的计时点随本次裁决收敛 Alarm；读取的协调写入失败时闭口为
  500（客户端按「暂时无法确认」重试），不对外陈述无法确认的在线状态。
  展示通道与被拒升级不做在线协调（展示不计成员、不影响计时），但
  待补偿的在线分叉仍在时不会删除故障补偿的唤醒，也不改写计时或期限。
  新连接的接纳顺序保证已观测的掉线
  不被吞掉：先在「新连接未计入注册表」时协调既有离线差异（含待补的
  掉线暂停），再注册连接并做常规协调；协调写入失败（短暂存储故障）
  时拒绝正常接入，防止快速重连让最终快照一致而跳过暂停。
  命令事务内的协调写入失败时：命令整体回滚并以 `INTERNAL` 拒绝推进
  （不基于无法确认的在线状态判权）；断开路径启动有界
  重试链（250ms 起约 6 分钟内按退避重试，覆盖短暂故障后无任何新
  事件的场景）并在故障发生时补设一次有界唤醒 Alarm（不晚于链应结束
  的时刻，只提前、不推迟已有更早的 Alarm），链结束不再占用 timer，
  不影响休眠；链用尽或随实例驱逐丢失后，恢复的存储由这次唤醒补齐
  （Alarm 处理器先协调再裁决），更长的故障由恢复后的下一次连接/断开/
  命令/入房/读取事件兜底，没有常驻轮询。错误
  （`webSocketError` 仅处理非断线错误，主动 close 后清理交给
  `webSocketClose`）与关闭回调不会双重扣减。
- 关闭握手不依赖运行时按兼容日期自动完成：`webSocketClose` 以幂等、
  安全的关闭回应补齐（只回 1000 或 3000–4999 的合法状态码；1005/1006
  等保留码与无状态码回不带状态码的关闭帧；不回显对端 reason；已
  CLOSED、重复回调与平台异常都安全跳过）。成员、展示与被拒连接一致
  处理，不产生任何存储或在线状态写入。
- 休眠语义：实例被驱逐（休眠）不触发任何回调，连接与附件由运行时
  保留，消息到达时以附件身份唤醒——不依赖实例内存的成员计数或权限，
  也没有常驻 timer 阻止休眠。
- 结果未知（超时或断线）时，客户端重连并取得最新完整视图，再决定
  是否重发；重发必须复用同一 operationId 与同一命令载荷。

## 状态、版本与命令

- 房间状态与 BP 进度由 `roomStateSchema` / `bpProgressSchema` 定义并
  校验（含序列前缀、代理人不重复、预选不得已用等不变量）。
- `agentDataVersion` 与规则版本在每间房间建房时固定：新房间建自
  `shared/agents` 目录（`agentDataVersion` 导出，构建时由固定版本数据
  包生成），规则版本取自 `shared/bp/version.ts` 的 `BP_RULE_VERSION`
  常量（单一来源）；已建房间的 `AgentCatalog.agentIds` 与归档展示
  lookup 从其持久目录快照派生（见[房间持久化与固定目录](#房间持久化与固定目录)）。
  数据来源与更新办法见[代理人数据接入](specs/agent-data.md)。已保存的
  规则版本只是固定标识，不表示实现了历史规则引擎：命令执行入口按
  房间的持久 ruleVersion 校验当前实现是否支持，不支持则拒绝
  （`RULE_VERSION_UNSUPPORTED`，见[WebSocket 通道](#websocket-通道)）。
- `bp.version` 与公开 `revision` 职责分开：前者只随预选、提交、控制
  命令与席位权限变化递增（重开不重置），用于命令过期判断；后者随
  任何可见状态变化递增，用于视图同步。`setTeamName` 产生可见变化但
  不递增 bp.version，因此以 `expectedRevision`（与当前公开 revision
  严格一致）为可持久验证的过期前置条件（`STALE_REVISION`），防止
  回执窗口淘汰后的旧重试覆盖后来确认的值（见
  [WebSocket 通道](#websocket-通道)）。
- 命令由 `applyRoomCommand` 纯函数执行：检查顺序固定（身份 → live →
  在线 → 权限 → 前提 → 版本门（bp.version，setTeamName 另有
  revision 前置条件） → 生效），失败零写入，空操作返回原引用；
  `setMemberOnline` 为服务端专用系统入口。
- 业务规则（暂停、撤回、换人、掉线）见[单局常规 BP](specs/single-game-bp.md)
  与[房间角色](specs/room-roles.md)。

## 视图投影

合同定义于 [shared/contracts/views.ts](../shared/contracts/views.ts)。
投影按显式白名单构造（嵌套对象同样逐字段重建，不共享输入引用），
绝不直接转发 `RoomState`：

| 视图 | 内容 | 接收者 |
|---|---|---|
| 公开 BP 视图 | 房名、队名、席位占用（匿名布尔，支撑空席队名「待设置」展示）、BP 状态、当前操作位、公开结果、公开预选、规则与数据版本、revision。 | 全部查看者可见的最小集合 |
| 成员视图 | 公开内容 + 自身身份/席位 + 命令所需 `bpVersion`。 | 普通成员 |
| 房主管理视图 | 成员视图 + 全体成员（昵称、席位、在线）。 | 仅房主 |
| 展示视图 | 与公开 BP 视图同形，无成员数据。 | 匿名展示连接 |

房主兼任选手、被换下席位后仍为房主等情形由 `isHost` 与 `seatTeam`
两个独立字段表达，投影始终正确。

## 生命周期与归档记录

合同定义于 [shared/contracts/records.ts](../shared/contracts/records.ts)。
产品规则见[房间保留与只读记录](specs/room-roles.md#房间保留与只读记录)；
时间常量：全员离开后空房保留 12 小时，只读快照自归档起 90 天。
运行时实现于 `server/room.ts`（裁决与编排）与 `server/persistence.ts`
（归档行读写）。

- 单一裁决入口（`adjudicateLifecycleInTransaction`）：读取（含目录）、
  入房、WS 接纳、已有 WS 命令与 Alarm 处理器共用同一规则，不复制各自
  期限算法。live 房间以实际成员连接为保留的权威依据（连接存在或
  `last_member_left_at` 为 null 即继续保留）；空房按
  `last_member_left_at + 12h` 判定，`now >= 期限` 必须先完成裁决再考虑
  入房或命令——注册新连接不能清掉已过期期限，也不能靠延迟 Alarm 延长
  可操作时间。经历 await 的入口（入房、WS 接纳）在任何持久影响或连接
  注册之前按当前时刻重新裁决一次，避免 await 跨越期限后沿用旧结论。
- 到期转换在一个 `transactionSync` 内原子完成：有有效提交的房间生成
  快照（`projectArchiveSnapshot`，用该房间持久目录与建房时固定的版本，
  90 天自本次实际转为只读起算，重复读取或 Alarm 不刷新起点）并清理
  操作期数据（成员凭据摘要、席位、队名行、当前序列、命令回执与固定
  目录），只保留快照与必要生命周期元数据（room_meta 的房间标识、名称、
  生命周期、创建时间与版本来源）；任一步失败整体回滚，不留半归档。
  无有效提交（仅预选、全部撤回、重开未提交）不生成空快照，房间经原子
  `deleteAll` 清理（回收整个 SQLite，含兼容日期 2026-09-01 起的 Active
  Alarm；删除后的房间对后续 GET/POST/WS 按不存在处理，不重建表或期限）。
- Alarm 是唤醒信号而非期限本身：每对象同时仅一个 Alarm，建房空房、
  最后成员离开、归档后 90 天分别调度相应期限；真正成员回归取消旧
  Alarm。Alarm 处理器每次触发都先按实际连接协调在线投影，再按当前
  持久状态与实际连接重新裁决（重复/过早/延迟的触发收敛到应设的下一
  期限，不重复归档、不提早清理、不覆盖已设的下一期限）——这也是无人
  访问时补齐「在线协调重试链随实例丢失」遗留分叉的唯一补偿入口；补齐
  成功且房间仍 live 时向现存连接广播最新视图（展示客户端没有心跳，
  不推就停在旧画面），终态只走既有终态收口，不发假成功或旧视图。
  故障补偿的有界唤醒（见上文的在线协调）在待补偿分叉未修复前不会因
  任何入口的 Alarm 收敛被删除；真正修复或成员正常回归后按正常期望值
  收敛或清除。Alarm 是异步存储操作，不进入
  `transactionSync`：裁决（SQL 部分）在事务内原子提交，其后的 Alarm
  应用失败时上抛——读取路径按 500 收口（客户端重试由下一事件恢复）、
  Alarm 处理器交给平台 at-least-once 重试（2 秒起退避，最多 6 次）、
  断开路径交给有界重试链，不留下「对外成功但不再有唤醒信号」的状态。
- 入房是两阶段结构：阶段一先在线协调再裁决、后应用 Alarm（全部在
  成员写入之前）——协调可能修复「存储在线但实际无连接」的持久残留
  （最后断开写入失败且重试链/实例已丢失）并补写全员离开时间，裁决
  的 Alarm 期望值按协调后的最终期限推导，失败 → 500、零成员写入、
  无凭据交付（保持失败零写入契约，重试不产生孤儿成员）。阶段二的
  入房事务先重新裁决到期状态（前置 await 期间的时钟推进或连接事件
  不能让过期房间被入房复活）再做兜底协调与成员写入。live 入房成功后
  不重复应用 Alarm（阶段一已按协调后状态收敛，兜底协调若再写计时，
  由源头断开事件的重试链收敛，持久残留由下一个入房的阶段一兜底）；
  终态（归档/清理）路径没有成员写入，Alarm 失败上抛无孤儿。
- 终态连接收口幂等且不依赖「本次是否发生转换」：归档/清理一旦持久
  成立，任何入口（读取、入房、目录、WS 接纳、命令、Alarm 及其故障后
  的重试）重放收口都向现存实时连接发送终态通知并关闭——归档 →
  `ROOM_ARCHIVED`、清理后与房间不存在 → `ROOM_NOT_FOUND`（均 1008；
  not_found 收口只发 ws 通知不创建存储，未知房间为空操作，而
  「deleteAll 已成功、冗余 deleteAlarm 失败」的半收口故障由此幂等
  补齐）；展示客户端没有心跳，遗漏通知会永远保留「已连接」的旧画面。
  清理的收口在 deleteAll 原子成功后立即执行，冗余的 Alarm 显式清理
  独立处理（失败仅记日志，残留 Alarm 触发时按 not_found 自清；deleteAll
  自身失败上抛、不发假终态）。命令通道经 `beforeConclude` 保序
  （commandResult 先于终态通知与关闭）；SQL 转换回滚不发假终态；
  终态关闭触发的 close 回调对非 live 房间零写入跳过，不按已清理的
  成员/席位装配视图或制造无意义重试。
- 归档房间的原链接经普通 HTTP 返回同一份快照（原房主、成员与匿名
  一致），不自动加入成员、不建立成员或展示实时连接；快照到期清理后
  按 `ROOM_NOT_FOUND` 收口。
- 健康自检使用独立 DO 实例名（`bootstrap-health`，legacy `room_info`
  表），与房间实例的业务表互不干扰；清理只发生在对应房间自己的 DO
  实例内，没有跨房间或批量全局操作。

## 后续运行时接入位置

PR4 已落地持久房间、HTTP 建房/入房/读取/目录入口与匿名身份 Cookie；
PR5 已落地成员/展示 WS 通道、命令执行管线、多页面在线计数、空房计时
元数据与 operationId 去重回执（见[身份与凭据边界](#身份与凭据边界)、
[房间持久化与固定目录](#房间持久化与固定目录)与[WebSocket 通道](#websocket-通道)）；
PR6 已落地房间主界面（首页/入房表单、禁选槽位与代理人池、两个选用布局、
统一控制面板）与常规 WS 客户端连接管理（`src/room/room-session.ts`：
共享 schema 校验、revision 单调视图门与 operationId/版本前置条件）；
PR7 已落地恢复交互收口（`src/room/room-session.ts`、`src/room/host-panels.ts`
与房主面板）：

- 连接以「本连接首个合法权威视图」为同步点：WebSocket open 本身不放行
  操作与动效，每次尝试有覆盖握手与首帧的期限，期限内无有效视图按失败
  收口；退避失败计数只在真正取得同步后清零，open-即断不把失败伪装成
  恢复。
- 结果未知（回执超时或断线）的命令转入「核对中」：保留原 operationId
  与原载荷字节，重新同步后按协议重发，由服务端持久化回执对同载荷幂等
  返回原结果。核对重发收到的失败回执一律不能证明原命令失败——它可能
  是本次核对执行的新拒绝（原命令可能已生效且其回执已越出保留窗口；
  规则在版本门前先判权限与状态，故 NOT_CURRENT_PLAYER、BP_NOT_RUNNING、
  SEAT_TARGET_OFFLINE 等同样可能来自「原先已成功、如今状态变了」），
  也可能是核对处理本身的技术故障（INTERNAL：本次事务回滚），还可能是
  原失败回执的幂等重放（客户端无法区分重放与新执行）——统一按「结果
  未知」诚实反馈；用户以最新状态重新操作，若同样的条件仍在，新命令的
  首发错误会给出准确原因。首发的失败回执仍是原操作的明确结论，按对应
  错误结算。回执超时会主动断开当前连接（半开连接检测），恢复后统一走
  核对路径。
- 挂起命令绑定发送时的成员 ID（权威视图 self.memberId，非秘密）：
  视图携带的身份变化（如浏览器凭据被更换后以新成员重新入房，服务端
  直接返回新身份的有效视图，不经 AUTH_FAILED）时，旧身份的待核对命令
  按「身份已变化、原结果未知」明确放弃，绝不以新身份重发；同一
  memberId 的席位/角色变化不构成身份变化，照常核对。HTTP 初值与每代
  连接的首个视图都经此边界。「身份已变化 / 结果未知」是原操作的结论，
  不随操作位推进清理（旧回合的普通失败仍按需清理），由用户在同区域
  开始新操作或会话结束时结算；放弃同时设置任何角色可见的通用身份
  提示（旧挂起可能是新身份不可见的房主面板操作），用户发送新命令时
  清除。
- AUTH_FAILED 明确结束原身份会话：终止重连与核对重发，页面回首次入房
  流程并保留提示；ROOM_NOT_FOUND/ROOM_ARCHIVED 同为终态，按既有路由
  边界提示不可进入。
- 挂起操作的操作反馈与操作入口可见性解耦：操作位轮到对方、BP 完成、
  被换下或面板按钮因状态切换消失后，旧命令的提交中/核对中状态与
  「结果未知」提示仍在底栏/面板固定区可见（入口自身可见时由入口按钮
  标签展示同一状态，不重复提示）。
- 房主面板成员/换人列表按成员加入顺序以 memberId 认人：换人成功后各行
  保持原位与滚动位置，仅原位更新角色文案、按钮与顶部当前选手；当前
  选手离线也保留原行禁用，另一方在席者不进入候选；同昵称不同身份分行
  展示，人数按实际房间成员统计（展示页连接不是成员，见 PR8）。

PR8 已落地独立实时展示页（`/rooms/:roomId/display`，`src/pages/DisplayPage.vue`、
`src/room/display-session.ts`、`src/room/display-grid.ts` 与 `src/room/display-url.ts`）：

- 只读展示客户端连接（`display-session.ts`）：只连展示通道，消费
  `displayServerMessageSchema`；没有命令入口、挂起命令与身份恢复逻辑。
  连接纪律与成员会话一致——本连接首个合法且不落后的 `displayView` 为
  同步点（open 不放行动效）、视图按公开 revision 单调应用、首帧有界
  等待与自动退避重连、旧连接迟到帧隔离、断线保留最后画面；
  ROOM_NOT_FOUND/ROOM_ARCHIVED 为终态（页面分别按「不存在」与「已归档」
  收口，归档保留原房间链接给 PR9 的记录页），INTERNAL 通知只提示并重试。
- 展示页路径由 `display-url.ts` 构建（`/rooms/:roomId/display`）：选用区
  固定九格竖排，链接不带布局参数，展示页也不读写本地布局偏好。
- 中央代理人池按目录条数与可用宽高全量同屏（`display-grid.ts`）：
  枚举列数取头像最大的可行解，单行名称宽度下限由最长名称推导，极端
  容器退到两行名称预算，不滚动、不翻页、不轮播。
- 房间工作区与展示页共用视图投影（`src/room/view-projections.ts`）与
  状态视觉（`AgentStatusAvatar`）：禁选槽位、空席队名「待设置」、公开预选
  与三种状态视觉在两个场景由同一实现派生。

PR9 已落地归档与只读记录（`server/room.ts` 生命周期裁决、
`src/pages/RoomPage.vue` 记录分流、`src/components/room/RecordView.vue`、
`src/room/record-view.ts` 与 `src/room/api.ts` 的 archived 快照解析）：

- 原房间链接按生命周期分流（`RoomPage.vue`）：live 沿用首次入房/实时
  房间；archived 是成功只读响应，进入同一套只读记录界面（原房主、成员
  与匿名一致）；入房进行中或实时会话被归档（410 / `ROOM_ARCHIVED`
  终态）时同样转记录读取；提交时房间已不存在（404，初始读取 live 之后
  的自然过期竞态）与初始 404、WS `ROOM_NOT_FOUND` 一致转统一不存在页
  （含创建入口），失效的入房表单退出；网络/服务端故障保留表单与重试
  入口，不误报「不存在或已过期」。`room-session.ts` 把 ROOM_ARCHIVED
  终态与 ROOM_NOT_FOUND 分开表达（`room-archived`）。
- 只读记录页（`RecordView.vue` + `record-view.ts`）：快照是唯一数据
  来源（不请求当前 catalog 重解释旧名称或头像）；顶部双方禁用区、房名
  与「只读记录 · 已完成/未完成」；两侧选用结果沿用九格竖排（与操作页
  同一槽位语义）；中央单列禁选顺序列表（1 起连续
  顺序、左右方动作文案、代理人头像与名称，禁用/选用沿用既有视觉），
  仅列表内部滚动；控制面板为右侧覆盖，内容限复制原链接与
  记录到期时间；页面无实时连接、无倒计时轮询。
- 生命周期与 Alarm 语义见[生命周期与归档记录](#生命周期与归档记录)。

| PR | 接入点 |
|---|---|
| PR6（房间界面与常规连接） | 房间主界面、角色权限 UI 与常规 WS 客户端连接管理；命令与视图协议已就位。 |
| PR7（恢复交互收口，已落地） | 断线重连同步门、结果未知同载荷重发核对与换人列表稳定反馈；全链路容量与端到端复核并入 PR10。 |
| PR8（展示页，已落地） | 独立展示页 UI、只读展示客户端连接、URL 冻结布局与全量同屏代理人池；展示通道传输边界不变（只读、无身份、不计在线）。 |
| PR9（归档与清理，已落地） | Alarm 与读写路径共用到期裁决（读 `room_meta.last_member_left_at` 与快照 `expiresAt`）；到期经 `projectArchiveSnapshot` 生成快照或原子清理空房间；`GET /api/rooms/:roomId` 的 archived 分支返回只读快照，原链接进入只读记录页。 |
| PR10（端到端与容量复核，已落地） | 真实浏览器验收平台（`tests/e2e`：Vitest + Playwright 驱动真实 `cf dev`，服务生命周期由 globalSetup 管理）与资源基准（`tests/measure`，`pnpm measure:rooms`）；验收事实、分层证据与部署前检查见[首版发布与验收说明](release.md)，预算方法见[Cloudflare 部署与预算评估](specs/cloudflare-budget.md#容量估算方法与本地基准)。 |
