# 代理人数据接入

本文维护代理人目录的数据来源、固定版本、字段映射、生成与更新办法，是这些事实的唯一正文。产品展示规则（排列、搜索筛选、缺头像处理）见[房间布局](room-layout.md)，目录的模块位置与依赖边界见[架构与协议](../architecture.md)。

## 来源与包名

数据来源是 npm 包 `@randomplay/data`，由 [LoTwT/fairy](https://github.com/LoTwT/fairy) 仓库的 [packages/data](https://github.com/LoTwT/fairy/tree/main/packages/data) 发布（fairy 是仓库名/项目名，发布包名是 `@randomplay/data`，两者指同一来源）。包内容为纯 JSON 数据（无图片二进制）。

当前固定版本 **0.2.1**（npm `dist-tags.latest`，发布于 2026-09-26），对应上游声明的游戏数据版本 **3.1**、来源数据集 `nanoka-zzz`。包以精确版本锁定在 `package.json` 的开发依赖中：仅生成脚本与测试使用它，运行时不导入，32 MB 上游数据不进入构建产物。

## 权威入口与生成

- **单一权威产物**：`shared/agents/catalog.json`（提交入库的只读目录，约 13 KB）。
- **生成脚本**：[scripts/generate-agent-catalog.ts](../../scripts/generate-agent-catalog.ts)，命令 `pnpm run generate:agent-catalog`（Node ≥ 24 原生类型剥离执行，无需额外运行器）。
- **运行时入口**：`shared/agents/catalog.ts` 加载产物并用共享 Zod schema（`shared/agents/schema.ts`）完整校验，导出 `agentCatalogData`、`agentDataVersion` 与派生接口；筛选函数在 `shared/agents/filter.ts`。
- 日常开发、CI、`pnpm build` 只读取已提交的产物，不重新生成、不访问网络。构建不依赖在线读取上游。

生成脚本从安装的固定版本包读取 `loadAllAgents("zh")` 与 `calculationDataVersion`、`loadIndex`，映射为目录后在写入前用 schema 完整校验（含 ID 唯一、升序、分类引用有效等不变量）；重复 ID、空名称、无效分类引用、多值分类等异常直接失败，不静默跳过或吞掉条目。产物 JSON 确定性序列化，重复生成结果逐字节一致。

## 字段映射

目录条目的每个字段取自上游实际字段，不拼接、不推测补写：

| 目录字段 | 上游字段 | 说明 |
|---|---|---|
| 稳定 ID | `data.id` | 来源数值 ID 的规范十进制字符串（如 `"1011"`），与规则层 AgentId 字符串衔接。 |
| 官方中文名称 | `details(zh).name` | 中文详情顶层名称原值。 |
| 头像路径 | `data.partnerInfo.iconPath`，缺失时 `details(zh).partnerInfo.iconPath` | 数据包已记录的资源路径原样保留；均缺失为 `null`，展示留空，不按图标编号拼接。 |
| 属性分类 | `data.classificationIds.elementType[0]` + `details(zh).elementType[id]` | 恰一个取值，多值或缺失视为来源歧义并失败。 |
| 特性分类 | `data.classificationIds.weaponType[0]` + `details(zh).weaponType[id]` | 同上；上游沿用 weaponType 用词，本站产品概念为「特性」。 |

属性与特性的筛选项（`elements` / `specialties` 表）由全部代理人条目推导，不做手工维护；schema 校验每个分类都被至少一名代理人使用。分类图标在本数据包中没有结构化资源字段（`fairyRecommend` 内的图标属于驱动盘推荐词条，strategy 文本中的 `<IconMap>` 标记是自由文本且不完整），因此 `iconPath` 恒为 `null`；上游补齐后随数据更新接入。

## 实际导入概况（0.2.1，游戏 3.1）

- **58 名代理人**，按来源 ID 数值升序（`1011` 安比 → `1591` 希格莉德），全部来自上游 `integrated/agents` 代理人主表；上游以目录区分代理人/邦布/怪物/Boss 等类别，代理人主表内不区分已实装与未实装条目，本站按主表全量使用。
- **7 项属性**：物理(200)、火属性(201)、冰属性(202)、电属性(203)、风属性(204)、以太(205)、流明(300)。
- **6 项特性**：强攻(1)、击破(2)、异常(3)、支援(4)、防护(5)、命破(6)。
- **缺头像 3 名**：`1381` 零号·安比、`1531` 星徽·比利、`1551` 佩洛伊斯（上游 `partnerInfo` 无 `iconPath` 记录）；它们保留 ID、官方名、可选资格与筛选信息。
- 名单含尚未实装的游戏内条目（如席德、般岳、琉音等，来自上游 3.1 数据），比赛可用范围由用户在数据接入时核对；名单与 `agentDataVersion` 的组合可被后续房间持久化保存为固定输入，避免升级后把已有预选/结果换成另一版本解释。

## 版本更新办法

1. 查询 npm 最新版本与发布内容，确认与 Tailwind/工具链无关后，修改 `package.json` 中 `@randomplay/data` 的精确版本并 `pnpm install`（pnpm 供应链策略默认生效，过新版本会被拒绝，不放宽设置）。
2. 运行 `pnpm run generate:agent-catalog` 重新生成产物，检查 `shared/agents/catalog.json` 的 diff（数量、缺头像名单、分类变化）。
3. 更新 `tests/rules/agent-catalog.test.ts` 中的固定版本常量与导入概况断言（测试同时校验产物版本与安装依赖一致，防止只升级依赖不重新生成）。
4. 运行 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build` 后提交。

上游头像补齐或分类图标接入后，同一流程更新；不改写 `fairy` 上游、不发 issue、不另选数据来源。

## 未验证项

- 头像路径是游戏内部资源路径，本站尚未接入图片文件服务；实际图片资源的提供方式（用户放置静态文件或另行托管）待后续界面 PR 处理。
- 代理人主表含未实装条目的比赛适用范围待用户确认（见上文导入概况）。
- 上游 0.2.1 之后版本的破坏性结构变化未验证，更新时按上文流程重新核对。
