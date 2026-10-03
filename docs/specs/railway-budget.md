# Railway 部署与预算评估

本文保留此前对 Railway 的平台比较，预算约束为最多采用每月 $5 套餐并避免超额费用；未订阅或部署 Railway。价格与平台能力核验于 2026-10-03，当前部署方向以 [Cloudflare 部署与预算评估](cloudflare-budget.md)为准。

## $5 套餐的边界

Hobby 每月支付 $5，包含价值 $5 的资源用量。用量为 $3 时仍支付 $5，用量为 $8 时资源与套餐费用合计 $8。它是最低消费，不是固定资源包或费用上限。[Railway 套餐](https://docs.railway.com/pricing/plans)

Railway 提供达到费用硬限额后停止工作负载的机制，但当前官方 CLI 文档规定，工作区 Compute 硬限额的非零值最低为 $10，不能配置为 $5。Email alert 最低为 $5，仅发送提醒。这里的 Compute 涵盖服务的 CPU、内存、存储和出站流量；Railway Agent 的限额单独管理，其 $5 默认上限不能用于限制应用服务费用。[费用控制](https://docs.railway.com/pricing/cost-control)、[用量限额取值](https://docs.railway.com/cli/usage#set-workspace-compute-limits)

因此，可将本项目正常用量设计在 $5 内，但不能把 Hobby 或费用硬限额当作严格的 $5 账单保证。

## 资源成本示例

下表假设仅有一个服务、单实例、整月运行，使用量均为举例，尚未经本项目测量。平均 CPU 与内存是实际消耗，不是分配上限。公式使用官方展示的月度单价，实际账单按用量计量。

| 资源 | 官方单价 | 假设用量 | 估算费用 |
|---|---|---|---|
| 内存 | $10／GB／月 | 平均 0.25 GB | $2.50 |
| CPU | $20／vCPU／月 | 平均 0.05 vCPU | $1.00 |
| 出站流量 | $0.05／GB | 每月 10 GB | $0.50 |
| 持久卷 | $0.15／GB／月 | 平均已用 1 GB | $0.15 |
| 合计 | 全部资源 | 上述假设用量 | $4.15 |

该假设下，资源消耗低于包含额度，套餐与资源费合计仍为 $5，另购项目或适用税费不在此估算内。单价来自 [Railway 定价](https://docs.railway.com/pricing)。这证明存在落在预算内的用量组合，不能证明本项目已达到该用量。

仅平均内存达到 0.5 GB 并持续运行整月，内存费用就约为 $5，再叠加 CPU、流量和存储会超过预算。网页、头像与 WebSocket 广播由 Railway 服务发送时，均需纳入出站流量估算。

## 候选实现

- 一个轻量应用服务同时处理静态前端、HTTP 接口和 WebSocket，所有房间共用同一进程。先采用单实例，不为每个房间创建服务。
- SQLite 文件保存在 Railway 持久卷，保存进度、身份与权限、预选及恢复所需信息；不使用容器临时文件系统保存房间。初版不额外部署 PostgreSQL、Redis 等常驻服务。
- 内存中主要保留正在使用的房间和连接，空房间数据保存在数据库。清理房间时也要管理数据库文件、WAL 和备份占用，不能把删除记录等同于文件立即缩小。
- 关闭不需要的预览环境与副本，限制异常连接、建房及消息频率，压缩头像和广播数据；资源上限需经测试设置，过低会使服务崩溃。
- 不使用 Railway Agent 消耗部署预算；如启用该产品，应单独纳入用量与限额管理。

Railway 支持 WebSocket。持久卷不支持多副本，带卷服务重新部署会有短暂停机，因此该候选方案需要正确保存状态并处理全员重连，正式 BP 期间应避免部署。[网络能力](https://docs.railway.com/networking/public-networking/specs-and-limits)、[持久卷限制](https://docs.railway.com/volumes/reference)、[资源限额](https://docs.railway.com/pricing/cost-control)

## 空房间保留与休眠

房间可恢复期限与快照保留期限见[房间保留与只读记录](room-roles.md#房间保留与只读记录)。假设所有保留房间及快照的额外数据合计 100 MB，并保持一整月，按持久卷单价计算约为 $0.015／月，实际还需计入文件系统开销与备份。对本项目而言，更应优先控制进程内存和流量，并按已确认的保留规则清理快照。[持久卷计费](https://docs.railway.com/volumes/reference)、[备份计费](https://docs.railway.com/volumes/backups)

Railway Serverless 休眠的是整个服务。官方说明按出站流量检测闲置，最后一次出站流量后约 5～10 分钟可能进入休眠；唤醒有冷启动延迟，首个请求可能返回 502。BP 广播和心跳持续产生出站流量时，不能依靠该机制省去运行费用。[Serverless](https://docs.railway.com/deployments/serverless)

所以，上面的预算示例按整月运行估算，不预先扣除休眠节省。可在无人连接时尝试让服务休眠，作为后续优化。若采用休眠，到期检查仍需在访问时执行，物理清理可在运行时批量完成；不能仅依赖进程内定时器保证重启或休眠后的过期行为。

## 与 Cloudflare 的取舍

| 关注点 | Railway Hobby 候选方案 | Cloudflare Free 候选方案 |
|---|---|---|
| 严格避免额外费用 | $5 包含用量，Compute 硬限额最低 $10，不满足严格 $5 封顶 | 仅用免费资源，配额耗尽时相关操作失败 |
| 后端形态 | 普通常驻服务、WebSocket、SQLite | Worker、Durable Objects、休眠式 WebSocket |
| 低流量时的主要成本 | 常驻内存，另有 CPU、流量和存储 | 免费额度内无需资源付费 |
| 闲置处理 | 整个服务休眠，有冷启动 | 符合条件的房间对象可保持连接并休眠 |

Cloudflare 的价格与能力依据由[对应评估](cloudflare-budget.md)维护。

如果「每月绝不超过 $5」是硬要求，当前仍优先建议 Cloudflare Free。若接受 Railway 用量控制与监测，并承担超过预估的可能性，单服务方案有落在 $5 内的空间。服务实际内存、CPU、观众流量与并发容量尚未测试，不能承诺具体比赛规模或持续可用性。
