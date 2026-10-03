# Cloudflare 部署与预算评估

本文维护部署平台与预算约束，以及支撑方案选择的费用评估。价格和平台能力核验于 2026-10-03，正式部署前需复核。

## 已确认的约束

- 计划后续部署在 Cloudflare，目前没有订阅；此前的 [Railway 评估](railway-budget.md)保留为平台比较资料。
- 优先避免付费；如需 Workers 每月 $5 套餐，目标是用量落在套餐包含额度内，避免超额费用。
- 首版实时房间和到期后的只读快照均采用 Durable Objects 内置的 SQLite Storage，复用现有房间存储；暂不增加向 D1、Workers KV 或 R2 的跨库实时同步或独立归档。历史记录规模或查询需求明确后再评估拆分。
- 容量接近上限时，届时根据实际规模与成本评估迁移历史快照到更有性价比的存储，或删除记录；迁移目标、删除范围和触发阈值留到实际需要时确定。
- 首版房间生命周期与记录范围以[房间保留与只读记录](room-roles.md#房间保留与只读记录)为准；服务组合的实现细节由[首版开发方案](implementation-plan.md)维护。

## 费用边界

Workers Paid 的 $5 是账户每月基础费用，超出各项包含额度后继续计费；预算提醒只发送通知，不会停止使用或封顶账单。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[预算提醒](https://developers.cloudflare.com/billing/manage/budget-alerts/)

若必须保证本项目不产生用量费用，建议先采用 Workers Free，并只使用免费方案支持的资源。免费配额耗尽时，相关动态操作会失败，不能同时承诺无限容量与持续可用。Durable Objects 已支持免费方案，但需使用 SQLite 存储后端。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

与候选方案相关的主要额度如下。额度按账户汇总，同账户其他项目也会占用；日额度与月额度不能直接视为相同容量。

| 项目 | Workers Free | Workers Paid 包含额度 |
|---|---|---|
| Worker 动态请求 | 10 万次／天 | 1,000 万次／月 |
| Worker CPU | 每次调用最多 10 ms | 3,000 万 CPU ms／月 |
| Durable Objects 请求 | 10 万次／天 | 100 万次／月 |
| Durable Objects 运行时长 | 13,000 GB-s／天 | 400,000 GB-s／月 |
| SQLite 行读取 | 500 万行／天 | 250 亿行／月 |
| SQLite 行写入 | 10 万行／天 | 5,000 万行／月 |
| SQLite 存储 | 总计 5 GB | 5 GB-month |

表中数据来自 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)与 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。请求数、CPU、运行时长和存储分别计量；经 Worker 进入 Durable Object 的请求可能同时消耗两者的额度。表格不是完整账单清单，日志等附加功能需要另行检查。

## 建议的服务组合

1. 前端页面、代理人头像与公共代理人数据通过 Workers Static Assets 分发。直接命中静态资源的请求免费，避免让所有资源经过 Worker 脚本。[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
2. Worker 只承担建房、入房、身份校验及 WebSocket 接入等必要动态入口，保持处理轻量。
3. 每个房间使用一个 SQLite Durable Object，统一处理角色权限、操作顺序、预选、确认及广播，并保存房间状态。到期后的只读快照继续保存在同一 SQLite 中。头像无需按房间复制。
4. 使用 WebSocket Hibernation API，让连接存在但无操作时的房间可以休眠。避免服务器端轮询、常驻计时器和每秒广播。休眠会丢失普通内存状态，重要数据需随状态变更保存，包括恢复当前预选所需的数据，不能等最后一人离开才保存。[Durable Object 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
5. 空房间到期处理使用平台 Alarm。触发时重新检查是否仍为空房间且已到期，按已确认的[到期处理规则](room-roles.md#房间保留与只读记录)清理房间或生成快照，归档后终止房间操作权限；到期前有实际成员重新进入则按该规则取消本次到期任务。任务执行和写入仍会消耗额度。[Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)

上述组合中，Durable Objects 内置 SQLite 的存储选型已经确认；其余内容为费用约束下的候选架构。前端与依赖选型见[首版开发方案](implementation-plan.md)，数据结构和限额数值仍需在实现时细化。

具体技术组合、模块职责与实现顺序见[首版开发方案草案](implementation-plan.md)。该草案不将本节其余建议自动转为已确认决策，价格与预算约束继续由本文维护。

## 存储选型与跨库同步

首版已确定使用 Durable Objects 内置 SQLite 保存实时房间和到期后的只读快照，暂不增加跨库实时同步或独立归档。以下比较保留为当前选择及未来扩展的取舍依据，实时展示沿用已确认的产品规则。

| 产品 | 与本项目相关的用途 | 免费存储额度 | 超出包含额度的存储单价 |
|---|---|---|---|
| Durable Objects SQLite | 房间权威状态，配合对象处理权限、禁选与广播 | Workers Free 账户合计 5 GB | Workers Paid：$0.20／GB-month |
| D1 | 跨房间查询、赛事历史、统计等关系数据 | Workers Free 账户合计 5 GB | Workers Paid：$0.75／GB-month |
| Workers KV | 读多写少、允许读取旧值的配置或缓存 | 1 GB | Workers Paid：$0.50／GB-month |
| R2 Standard | 按文件保存大量历史快照；属于对象存储 | 10 GB-month／月 | $0.015／GB-month |

单价来源：[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers KV](https://developers.cloudflare.com/kv/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)。此表仅比较存储，不能代替完整费用估算；请求、读写、对象运行时长等仍按相应产品计量。R2 需单独开通订阅，免费额度用完后按用量收费，不能将其理解为 Workers Free 的硬配额或由 $5 套餐封顶。[R2 开通与计费](https://developers.cloudflare.com/r2/get-started/)

D1 与 Durable Objects SQLite 的行读取、行写入额度及超额单价相同，单就读写计费没有将数据同步到 D1 的优势；完整方案还需计入房间协调和广播的成本。D1 可以保存事务数据，但实时推送仍需应用层通信机制。KV 采用最终一致性，其他地区可能要 60 秒甚至更久才能读到更新，因此不适合作为本项目当前 BP 状态与权限的权威来源。[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

客户端实时同步与跨库复制分别处理：

- 房间到客户端：建议通过 WebSocket 广播已确认的 BP 变化、公开预选和成员状态，重连时获取最新状态。持久化正式操作后再确认成功；预选也保留恢复所需的当前值。避免让每个观众定时查询数据库或用固定频率重复写入整份状态。
- 房间到其他存储：首版暂不增加实时复制。将同一次变化同时写入 SQLite 和 D1 会增加写入及失败重试，还需处理版本冲突；仅复制而保留原数据不会减少 SQLite 占用。对象在无操作且满足休眠条件时本就不计运行时长，因此为降低闲置运行成本搬迁数据也没有必要。

## 只读快照的存放位置

用户已确认首版只读快照继续存放在 Durable Objects 内置 SQLite 中，复用已有存储，以减少服务数量并遵守当前预算约束；等历史记录规模或查询需求明确后再评估拆分。快照内容与生命周期以[房间保留与只读记录](room-roles.md#房间保留与只读记录)为准，以下保留其他方案的比较依据。

- 继续使用 Durable Objects SQLite：复用现有存储和原房间定位方式，实现最少，也无需新增存储产品的订阅。归档访问仍会消耗对象请求、读取及运行时长额度；历史数据继续占用 SQLite 容量。
- 转存 R2 Standard：适合将每个房间的快照保存为一份 JSON，按房间标识整份读取。若决定独立归档，优先考虑此方案；记录查看无需维持实时连接，读取路径也可以避开原房间对象。R2 自带免费额度，但另行按量计费。
- 转存 D1：若后续需要按赛事、队伍、日期查询历史列表或做统计，可用关系表建立索引。仅为打开一个链接查看完整快照，目前没有必须引入 D1 的需求，也没有单纯依靠存储单价节省费用的优势。

R2 Standard 每月包含 10 GB-month 存储、100 万次 Class A 操作及 1,000 万次 Class B 操作；写入快照通常属于 Class A，读取属于 Class B。超过包含额度后，分别按 $0.015／GB-month、$4.50／百万次、$0.36／百万次计费，并按官方计费单位向上取整。互联网出站流量免费，经过 Worker 的请求仍需计入 Workers 用量。免费额度仅适用于 Standard。[R2 定价](https://developers.cloudflare.com/r2/pricing/)

R2 需要单独开通订阅，其超额费用不由 Workers 的 $5 基础费用抵扣，也不受其封顶。这是首版快照继续留在 SQLite 的费用考量；未来只有需要独立归档并接受 R2 的用量计费边界时，再考虑采用 R2。存储量较小不能代替对读取次数和整体用量的控制。[R2 开通说明](https://developers.cloudflare.com/r2/get-started/)、[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)

如果未来采纳独立归档，建议采用一次性迁移：到期先冻结房间操作，生成快照并写入目标存储，确认保存成功后再清理活动数据；失败时保留 SQLite 中的完整记录，并允许幂等重试。重试使用稳定的房间与快照版本标识，不能重复生成不同的最终记录。原链接继续提供快照查看，查看不恢复操作权限。这里只保留未来迁移的评估边界，不属于首版实施范围。

由于[已完成后仍允许撤回和重开](single-game-bp.md)，AP9 提交不代表结果永久冻结；已确认在房间到期时冻结并归档。快照保留期限及到期清理由[房间保留与只读记录](room-roles.md#房间保留与只读记录)维护；容量控制阈值待实际用量验证后细化，换存储本身不能替代保留与清理规则。

## 房间保留与快照的成本

房间生命周期、快照内容与保留期限以[房间保留与只读记录](room-roles.md#房间保留与只读记录)为准。

保留数据不要求房间进程持续运行。符合休眠条件的空闲 Durable Object 不计运行时长。只读快照可以按需读取，避免保持 WebSocket；实际读取仍消耗请求、读取行数和短暂运行的额度。[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

仅作量级示例：假设一份快照连同数据库开销共占 100 KB，同时保留 1,000 份约为 100 MB。100 KB 是估算假设，并非已测得的大小；内容、索引与数据库开销需要实测。数据库本身及内部元数据也占用存储，不能只按快照 JSON 大小估算。[存储开销说明](https://developers.cloudflare.com/durable-objects/platform/pricing/#frequently-asked-questions)

到期后保留快照不会释放全部房间存储。缩短可恢复期限主要改变操作窗口，空记录房间和已过保留期限的快照按已确认规则清理；容量上限仍需另行确定。固定保留期限可以限制记录的累积时间，但不能单独限制保留期内的房间总量或保证用量不超出额度。

相反，若 WebSocket 用法导致房间始终无法休眠，按每个对象分配 128 MB 计算，一个连续运行 24 小时的对象就会消耗 `86,400 × 0.128 = 11,059.2 GB-s`，约占每日免费时长的 85%；两个这样的对象会超过每日额度。这是根据官方计费规则计算的反例，不是本项目的预期用量。[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## 对现有设计的约束

- 多页面与观众连接都要纳入容量估算。重连采用退避，控制异常建房、入房和消息频率；房间数、观众数等具体上限待规模预估与测试后确定。
- 单局虽然只有 [26 个正式操作位](single-game-bp.md)，用量还包括公开预选、撤回、重开、成员变化与心跳，不能只按 26 次写入估算。
- 心跳应采用兼容休眠的方式，避免每次心跳写数据库或向全房间广播。仍须满足检测到房主或选手所有页面断线后立即暂停的既定规则；断线检测延迟需在实现时验证。
- 归档必须在服务端终止操作权限，并实际保存可恢复读取的快照；到期任务与重新入房的竞态需保护。需要释放容量时应实际清理对应数据，不能只标记过期。期限本身也不能替代对恶意建房或长期占用房间的限制。
- 日志与追踪采样，避免记录每条心跳和完整广播。Cloudflare 已公告 2026-12-01 调整日志与追踪计费，部署时按届时的 [Observability 定价](https://developers.cloudflare.com/observability/pricing/)复核。
- 容量接近上限时，按[已确认的处置方向](#已确认的约束)评估迁移历史快照或删除记录，具体策略留到实际需要时确定。默认继续遵循已确认的快照保留与到期清理规则；若届时考虑提前删除未到期记录，应同时明确范围与保留规则的调整。此前暂停新建房间的建议尚未确定为默认策略。免费额度最终耗尽仍可能影响进行中的房间，界面必须明确显示连接或提交失败，不能显示虚假的提交成功。具体降级交互尚待设计。

## 当前结论与未验证事项

建议首版以免费运行作为设计目标，保留可升级能力。实时房间和只读快照均使用 SQLite 已获确认；R2、D1 保留为未来有明确规模或查询需求时的评估选项。快照遵循已确认的固定保留期限与到期清理规则，容量不足时的具体迁移或删除方案留到实际需要时确定。若以后升级 Paid，可通过容量控制降低超额风险，但 $5 套餐和预算提醒都不能构成严格的费用上限。

尚未取得预计同时开房数、观众规模、每日场次及实际性能数据。目前仅完成价格核验与架构评估，不能据此承诺免费方案可承载某一比赛规模。实施后应验证休眠是否生效、连接与预选的用量、持久化与清理开销，以及额度不足时的行为，再决定是否需要付费。
