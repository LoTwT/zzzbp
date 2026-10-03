# 架构与协议

本文维护模块边界、共享合同结构与运行时接入位置，是当前实现边界的唯一正文。
产品业务规则由 [specs](specs/) 各文档维护，此处只链接、不重复；部署与工具链见
[开发指南](development.md)。

## 模块与依赖

| 路径 | 职责 | 依赖方向 |
|---|---|---|
| `src/` | Vue 页面、组件与浏览器连接管理。 | 依赖 `shared/` |
| `shared/bp/` | BP 规则：26 步权威顺序、互斥池、BP 进度状态。 | 不依赖浏览器或 Workers 运行时，可依赖 Zod 与共享 schema |
| `shared/`（根） | 房间状态、命令契约与纯函数状态转换（`room.ts`、`commands.ts`、`transitions.ts`、`ids.ts`）。 | 依赖 `shared/bp/` |
| `shared/contracts/` | 网络合同：HTTP、视图投影、WebSocket、归档记录、版本信息。 | 依赖 `shared/` 根与 `shared/bp/` |
| `shared/api.ts` | 引导期的 `/api/health` 契约，保留兼容；房间协议不在此扩展。 | — |
| `server/` | Worker 入口与房间 Durable Object 骨架；业务运行时随后续 PR 接入。 | 依赖 `shared/` |
| `tests/rules/` | 纯规则与合同测试（Node 环境）。 | — |
| `tests/workers/` | Worker 与房间对象集成测试（真实 workerd）。 | — |

`shared/` 不依赖前端与服务端实现；服务端把 `shared/` 的纯函数作为唯一状态
权威，前端只用它做类型与展示推导。

## 身份与凭据边界

- 成员凭据由服务端生成并验证，推荐经同域 HttpOnly Cookie 保存于浏览器；
  客户端不可读、不可自报。
- JSON 响应与 WebSocket 广播绝不包含凭据；有效身份重开页面即可恢复当前
  角色（房主、席位或观众由房间状态派生）。
- 昵称仅用于展示，不用于身份查找；房间与成员 ID 由服务端生成，代理人 ID
  来自构建时固定的数据目录；路由参数与各类 ID 均由服务端校验。
- 命令入口只接收服务端凭据解析出的 `RoomActor`；客户端载荷中的自报字段
  被 Zod 剥离，`targetMemberId` 只是席位的被安排对象，不是操作者身份。

## HTTP 接口

合同定义于 [shared/contracts/http.ts](../shared/contracts/http.ts)；
`/api/health` 为既有引导契约（[shared/api.ts](../shared/api.ts)）。

| 路径 | 行为 |
|---|---|
| `POST /api/rooms` | 建房（房名 + 首次昵称），创建者成为房主；响应房间 ID 与其成员视图。 |
| `GET /api/rooms/:roomId` | 按生命周期分流：live 返回房名（携带有效身份时附成员视图以恢复角色）；archived 返回只读快照；不存在返回 404 错误体。 |
| `POST /api/rooms/:roomId/members` | 新成员以昵称作为观众加入；携带有效身份时恢复原身份（昵称被忽略）。 |
| `GET /api/health` | 引导期存储链路自检。 |

归档房间的原 URL 经普通 HTTP 读取快照，无需成员加入或 WebSocket。

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

## 后续运行时接入位置

| PR | 接入点 |
|---|---|
| PR4（持久房间与 HTTP） | 房间 Durable Object 持久化、HTTP 建房/入房路由、匿名身份凭据与 Cookie 生成。 |
| PR5（成员 WS 与同步） | 成员 WS 命令经 `applyRoomCommand` / `setMemberOnline` 执行并按身份投影广播、多页面在线计数、`operationId` 持久化去重回执。 |
| PR9（归档与清理） | Alarm 与读写路径共用到期检查；到期经 `projectArchiveSnapshot` 生成快照或清理空房间。 |
