# 代理人数据接入

本文维护代理人目录的数据来源、固定版本、字段映射、生成与更新办法，是这些事实的唯一正文。产品展示规则（排列、搜索筛选、缺头像处理）见[房间布局](room-layout.md)，目录的模块位置与依赖边界见[架构与协议](../architecture.md)。

## 来源与包名

数据来源是 npm 包 `@randomplay/data`，由 [LoTwT/fairy](https://github.com/LoTwT/fairy) 仓库的 [packages/data](https://github.com/LoTwT/fairy/tree/main/packages/data) 发布（fairy 是仓库名/项目名，发布包名是 `@randomplay/data`，两者指同一来源）。包内容为纯 JSON 数据（无图片二进制）。

本站按 **npm 已发布包** 固定版本，不跟踪仓库 main 分支：

- 当前固定版本 **0.2.1**（2026-10-04 核对仍为 npm `dist-tags.latest`，发布于 2026-09-26），包内声明的游戏数据版本 **3.1**、来源数据集 `nanoka-zzz`、58 名代理人。
- fairy 仓库 main 分支的 `packages/data/package.json` 版本号同为 0.2.1，但 `integrated/index.json` 的 `source.version` 已推进到 3.2（60 名代理人；[integration.md](https://github.com/LoTwT/fairy/blob/main/docs/specs/data/integration.md) 记录 2026-10-03「Nanoka 3.2 正式版本升级验收」agents +2）。**Git main 与 npm 已发布 tarball 不是同一内容快照**，不能把仓库 main 的最新数据当作安装依赖的内容。
- 后续 npm 发布新版本时，按下文「版本更新办法」整体升级；不修改 fairy 上游、不拉取未发布的 3.2 数据、不依据缺头像或名单外的判断删改条目。

包以精确版本锁定在 `package.json` 的开发依赖中：仅生成脚本与测试使用它，运行时不导入，32 MB 上游数据不进入构建产物。包的 `engines.node` 为 `>=24.11.0`，项目环境声明与此对齐（本地已验证 v24.18.0）。

## 权威入口与生成

- **单一权威产物**：`shared/agents/catalog.json`（提交入库的只读目录，约 14 KB）。
- **生成脚本**：[scripts/generate-agent-catalog.ts](../../scripts/generate-agent-catalog.ts)，命令 `pnpm run generate:agent-catalog`（Node ≥ 24.11.0 原生类型剥离执行，无需额外运行器）。
- **运行时入口**：`shared/agents/catalog.ts` 加载产物并用共享 Zod schema（`shared/agents/schema.ts`）完整校验，导出 `agentCatalogData`、`agentDataVersion` 与派生接口；筛选函数在 `shared/agents/filter.ts`。
- 日常开发、CI、`pnpm build` 只读取已提交的产物，不重新生成、不访问网络。构建不依赖在线读取上游。

生成脚本从安装的固定版本包读取 `loadAllAgents("zh")` 与 `calculationDataVersion`、`loadIndex`，映射为目录后在写入前用 schema 完整校验（含 ID 唯一、升序、分类引用有效等不变量）；重复 ID、空名称、无效分类引用、多值分类等异常直接失败，不静默跳过或吞掉条目。产物 JSON 确定性序列化，重复生成结果逐字节一致。

## 字段映射

目录条目的每个字段取自上游实际字段，不拼接、不推测补写：

| 目录字段 | 上游字段 | 说明 |
|---|---|---|
| 稳定 ID | `data.id` | 来源数值 ID 的规范十进制字符串（如 `"1011"`），与规则层 AgentId 字符串衔接。 |
| 官方中文名称（简短名） | `details(zh).name` | 中文详情顶层名称原值，作为默认展示名。 |
| 官方中文全名 | `details(zh).partnerInfo.fullName` | 数据包提供的官方全名（如「星见雅」对应简短名「雅」），与简短名一同参与搜索包含匹配；来源未记录时为 `null`，不推测或合并变体身份。 |
| 头像路径 | `data.partnerInfo.iconPath`，缺失时 `details(zh).partnerInfo.iconPath` | 数据包已记录的资源路径原样保留；均缺失为 `null`，展示留空，不按图标编号拼接。可加载的图片 URL 由消费边界统一派生（见下节）。 |
| 属性分类 | `data.classificationIds.elementType[0]` + `details(zh).elementType[id]` | 恰一个取值，多值或缺失视为来源歧义并失败。 |
| 特性分类 | `data.classificationIds.weaponType[0]` + `details(zh).weaponType[id]` | 同上；上游沿用 weaponType 用词，本站产品概念为「特性」。 |

属性与特性的筛选项（`elements` / `specialties` 表）由全部代理人条目推导，不做手工维护；schema 校验每个分类都被至少一名代理人使用。分类图标在本数据包中没有结构化资源字段（`fairyRecommend` 内的图标属于驱动盘推荐词条，strategy 文本中的 `<IconMap>` 标记是自由文本且不完整），因此 `iconPath` 恒为 `null`；上游补齐后随数据更新接入。

## 头像图片地址派生

目录产物只保留原始来源路径；可加载的图片 URL 在消费边界由共享纯函数 `toAgentImageUrl`（`shared/agents/catalog.ts`）统一派生，归档展示映射与后续界面共用，不在别处重复实现转换。

转换规则来自 fairy 上游的权威来源规格 [nanoka/source.md「已确认的图片地址规则」](https://github.com/LoTwT/fairy/blob/main/docs/specs/nanoka/source.md)（上游 2026-09-14 实测记录）：非空、以 `.png` 结尾的来源图片路径，去掉首尾空白与原目录、扩展名改为 `.webp`，再拼接固定前缀：

```text
UI/Sprite/A1DynamicLoad/IconRoleCircle/UnPacker/IconRoleCircle01.png
  -> https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp
```

- 这是上游文档记录的消费时转换，不是按图标编号猜文件名；`live2_d` 等无图片扩展名的动画资源标识不适用，无来源路径返回 `null`，不制造图片地址。
- 实际可达性探测记录：上游规格 2026-09-14 以 HEAD 复核 4 个样例均 `200 image/webp`；2026-10-04 复测发现普通 Python HEAD 返回 403，而携带 `Mozilla/5.0` UA 与 `Referer: https://zzz.nanoka.cc/` 的 GET 返回 `200 image/webp`（同日本轮 curl HEAD/GET 亦返回 200）。探测结果随客户端与时间波动，**不据此宣称全部 55 张头像已验证**；浏览器与部署环境的最终可达性（含防盗链行为）由界面 PR 验证，本站不抓取全量图片、不新增托管。

## 实际导入概况（npm 0.2.1，游戏 3.1）

- **58 名代理人**，按来源 ID 数值升序（`1011` 安比 → `1591` 希格莉德），全部来自上游 `integrated/agents` 代理人主表；上游以目录区分代理人/邦布/怪物/Boss 等类别，代理人主表内没有已实装/未实装的区分字段，本站按主表全量使用，不凭缺头像或名单外判断删改条目。
- **55 名有官方全名**（`fullName`，如 雅→星见雅、猫又→猫宫又奈）；`1381` 零号·安比、`1531` 星徽·比利、`1551` 佩洛伊斯来源未记录全名，为 `null`。
- **7 项属性**：物理(200)、火属性(201)、冰属性(202)、电属性(203)、风属性(204)、以太(205)、流明(300)。
- **6 项特性**：强攻(1)、击破(2)、异常(3)、支援(4)、防护(5)、命破(6)。
- **缺头像 3 名**：`1381` 零号·安比、`1531` 星徽·比利、`1551` 佩洛伊斯（上游 `partnerInfo` 无 `iconPath` 记录）；它们保留 ID、官方名、可选资格与筛选信息。
- 比赛专用白名单未核定：当前目录即主表全量，本站不因名单范围阻塞现有功能；名单与 `agentDataVersion` 的组合可被后续房间持久化保存为固定输入，避免升级后把已有预选/结果换成另一版本解释。

## 版本更新办法

1. 查询 npm 最新版本与发布内容，确认与 Tailwind/工具链无关后，修改 `package.json` 中 `@randomplay/data` 的精确版本并 `pnpm install`（pnpm 供应链策略默认生效，过新版本会被拒绝，不放宽设置）。
2. 运行 `pnpm run generate:agent-catalog` 重新生成产物，检查 `shared/agents/catalog.json` 的 diff（数量、缺头像名单、分类变化）。
3. 更新 `tests/rules/agent-catalog.test.ts` 中的固定版本常量与导入概况断言（测试同时校验产物版本与安装依赖一致，防止只升级依赖不重新生成）。
4. 运行 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build` 后提交。

上游头像补齐或分类图标接入后，同一流程更新；不改写 `fairy` 上游、不发 issue、不另选数据来源。

## 未验证项

- 头像图片地址按上游已确认规则派生，但浏览器与部署环境的实际可达性（含防盗链对 UA/Referer 的敏感性）未经全量验证，由界面 PR 核实；本站不抓取全量图片、不新增托管。
- 上游 npm 包 0.2.1 之后版本（含 fairy main 已合入但未发布的 3.2 数据）的破坏性结构变化未验证，发布后按「版本更新办法」重新核对。
- 比赛专用白名单未核定（当前为主表全量，不构成功能阻塞）。
