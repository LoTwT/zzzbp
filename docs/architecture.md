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
| `tests/workers/` | Worker 与房间对象集成测试（真实 workerd）：HTTP/身份/Cookie（`rooms.test.ts`）、SQLite 持久化与实例重建（`room-storage.test.ts`）、WS 通道边界（`room-websocket.test.ts`）、命令管线与去重回执（`room-commands.test.ts`）、在线计数与休眠恢复（`room-presence.test.ts`），共享辅助 `ws-helpers.ts`。 | — |

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
- 命令入口只接收服务端凭据解析出的 `RoomActor`；客户端载荷中的自报字段
  被 Zod 剥离，`targetMemberId` 只是席位的被安排对象，不是操作者身份。

## HTTP 接口

合同定义于 [shared/contracts/http.ts](../shared/contracts/http.ts)；
`/api/health` 为既有引导契约（[shared/api.ts](../shared/api.ts)）。

| 路径 | 行为 |
|---|---|
| `POST /api/rooms` | 建房（房名 + 首次昵称），创建者成为房主；响应房间 ID 与其成员视图，并经 Set-Cookie 下发房主身份。 |
| `GET /api/rooms/:roomId` | 按生命周期分流：live 返回房名（携带有效身份时附成员视图以恢复角色，匿名为 null 供首次入房）；archived 返回只读快照（PR9 接入）；不存在返回 404 错误体。 |
| `POST /api/rooms/:roomId/members` | 新成员以昵称作为观众加入并取得新身份；携带有效身份时恢复原身份（昵称被忽略、凭据不轮换、不重复建成员）。新成员写入成功后向已连接的成员/展示连接广播最新视图。 |
| `GET /api/rooms/:roomId/catalog` | 返回该房间建房时固定的代理人目录快照（含来源版本）；只读，无需身份，不含成员或凭据数据，不计在线、不影响保留计时。 |
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
未知 `/api` 路径维持引导期的 404 JSON。归档房间在 PR9 前没有任何转入
路径，读取归档分支当前是防御实现（410 `ROOM_ARCHIVED`），届时替换为
快照响应。

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
| `room_catalog`（单行） | 建房时一次性保存的目录快照 JSON 文本。 |
| `schema_meta`（单行） | 业务表结构版本；`ensureRoomSchema` 是幂等的初始化/版本升级入口（当前版本 2：v1 → v2 只新增 `command_receipts`，无历史数据搬移；更高版本拒绝加载，防降级误读）；读取路径先经只读的 `hasRoomSchema` 判断实例是否已初始化。 |
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
  当前时刻）；HTTP 读写、目录读取与展示连接都不影响该计时；到期执行
  与 Alarm 在 PR9。

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
  附件）推导实际在线成员集合，存储中的 online 标志只是它的持久投影。
  成员连接、断开、每条业务命令与 HTTP 入房都会先做在线协调
  （reconcilePresence，同一事务）：把存储标志对齐到注册表——断开者
  置离线（进行中房主或在席选手立即暂停）、仍有连接者保持在线并取消
  空房计时、全员离线且计时未记录时补写离开时间；无分叉时零写入
  （重算幂等，不会重复离线/暂停）。新连接的接纳顺序保证已观测的掉线
  不被吞掉：先在「新连接未计入注册表」时协调既有离线差异（含待补的
  掉线暂停），再注册连接并做常规协调；协调写入失败（短暂存储故障）
  时拒绝正常接入，防止快速重连让最终快照一致而跳过暂停。
  命令事务内的协调写入失败时：命令整体回滚并以 `INTERNAL` 拒绝推进
  （不基于无法确认的在线状态判权）；断开路径启动有界
  重试链（250ms 起约 6 分钟内按退避重试，覆盖短暂故障后无任何新
  事件的场景），链结束不再占用 timer，不影响休眠。错误
  （`webSocketError` 仅处理非断线错误，主动 close 后清理交给
  `webSocketClose`）与关闭回调不会双重扣减。
- 休眠语义：本兼容日期（2026-09-01）下 `webSocketClose` 触发前
  runtime 已完成 close 握手，关闭的连接不再出现在 `getWebSockets`；
  实例被驱逐（休眠）不触发任何回调，连接与附件由运行时保留，消息
  到达时以附件身份唤醒——不依赖实例内存的成员计数或权限，也没有
  常驻 timer 阻止休眠。
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
- 持久化现状（PR5）：`lastMemberLeftAt` 已在 `room_meta` 落地：建房时
  初始化为创建时刻，实际成员 WS 连接取消本次计时，最后一名在线成员
  离开时重新写入（见[房间持久化与固定目录](#房间持久化与固定目录)）；
  到期执行、Alarm 与归档快照生成在 PR9。

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
  展示，人数按实际房间成员统计（展示页连接不是成员，PR8 接入）。

| PR | 接入点 |
|---|---|
| PR6（房间界面与常规连接） | 房间主界面、角色权限 UI、两个选用布局与常规 WS 客户端连接管理；命令与视图协议已就位。 |
| PR7（恢复交互收口，已落地） | 断线重连同步门、结果未知同载荷重发核对与换人列表稳定反馈；全链路容量与端到端复核并入 PR10。 |
| PR8（展示页） | 展示页 UI；展示通道传输已就位（只读、无身份、不计在线）。 |
| PR9（归档与清理） | Alarm 与读写路径共用到期检查（读 `room_meta.last_member_left_at`）；到期经 `projectArchiveSnapshot` 生成快照或清理空房间；`GET /api/rooms/:roomId` 的 archived 分支替换为只读快照响应。 |
