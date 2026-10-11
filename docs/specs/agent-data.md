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

- **代理人数据产物**：`shared/agents/catalog.json`（提交入库的只读目录，约 22 KB）。
- **图片资源清单**：`shared/agents/assets.json`（提交入库的图片事实记录：来源、固定修订、公开路径、字节数、SHA-256、尺寸与宽幅裁切校准值），结构与校验见 [scripts/import-image-assets.ts](../../scripts/import-image-assets.ts) 使用的 `shared/agents/assets-schema.ts`。
- **目录生成脚本**：[scripts/generate-agent-catalog.ts](../../scripts/generate-agent-catalog.ts)，命令 `pnpm run generate:agent-catalog`（Node ≥ 24.11.0 原生类型剥离执行，无需额外运行器）；读取固定版本数据包与图片资源清单，把图片资源引用（条目 `iconAsset`、分类 `iconAsset`、目录 `imageAssets` 修订与已收录旧圆图文件名摘要）嵌入产物。
- **图片导入脚本**：[scripts/import-image-assets.ts](../../scripts/import-image-assets.ts)，命令 `pnpm run import:image-assets`；只在显式资源更新时运行（允许访问公开 GET 的资源源站），见下文「图片资源导入流程」。
- **运行时入口**：`shared/agents/catalog.ts` 加载产物并用共享 Zod schema（`shared/agents/schema.ts`）完整校验，导出 `agentCatalogData`、`agentDataVersion` 与派生接口；筛选函数在 `shared/agents/filter.ts`；图片 URL 布局与旧地址解析在 `shared/agents/assets.ts`（`assets.json` 与 `assets-schema.ts` 不进入任何运行时 bundle）。
- 日常开发、CI、`pnpm build` 只读取已提交的产物与静态文件，不重新生成、不访问网络。构建不依赖在线读取上游。

目录生成脚本从安装的固定版本包读取 `loadAllAgents("zh")` 与 `calculationDataVersion`、`loadIndex`，映射为目录后在写入前用 schema 完整校验（含 ID 唯一、升序、分类引用有效、图片资源引用与修订标识整体耦合等不变量）；重复 ID、空名称、无效分类引用、多值分类、缺图片资源引用等异常直接失败，不静默跳过或吞掉条目。产物 JSON 确定性序列化，重复生成结果逐字节一致。

**旧目录兼容**：早期目录快照（已建房间持久化的 `room_catalog`）没有 `imageAssets`/`iconAsset` 字段，schema 全部按可选处理，仍可解析；其展示按原始 `avatarPath` 派生旧圆图 URL 并映射到本站本地副本（见「图片资源与公开路径」）。归档快照按保存的 `agentAvatarUrl`/`agentAvatarCrop` 原样解释，新归档保存稳定的本站公开路径。不建立 SQL 迁移、不回写已存储数据、不按当前角色 ID 回填。

## 字段映射

目录条目的每个字段取自上游实际字段，不拼接、不推测补写：

| 目录字段 | 上游字段 | 说明 |
|---|---|---|
| 稳定 ID | `data.id` | 来源数值 ID 的规范十进制字符串（如 `"1011"`），与规则层 AgentId 字符串衔接。 |
| 官方中文名称（简短名） | `details(zh).name` | 中文详情顶层名称原值，作为默认展示名。 |
| 官方中文全名 | `details(zh).partnerInfo.fullName` | 数据包提供的官方全名（如「星见雅」对应简短名「雅」），与简短名一同参与搜索包含匹配；来源未记录时为 `null`，不推测或合并变体身份。 |
| 头像路径 | `data.partnerInfo.iconPath`，缺失时 `details(zh).partnerInfo.iconPath` | 数据包已记录的资源路径原样保留；均缺失为 `null`，展示留空，不按图标编号拼接。旧目录快照缺图片资源引用时按本字段派生旧圆图 URL（见下节）。 |
| 图片资源引用 `iconAsset` | `data.icon` + 本站图片资源清单 | 主干按上游消费库已确认规则由 `data.icon` 推导（`IconRole01` → `IconRoleCrop01`，读取实际字段，不是按角色 ID 猜编号），与清单比对后连同宽幅裁切校准值嵌入；当前 58 人全部有引用，缺 `avatarPath` 的 1381/1531/1551 由此获得方图资源，不伪造它们的旧来源路径。 |
| 属性分类 | `data.classificationIds.elementType[0]` + `details(zh).elementType[id]` | 恰一个取值，多值或缺失视为来源歧义并失败。 |
| 特性分类 | `data.classificationIds.weaponType[0]` + `details(zh).weaponType[id]` | 同上；上游沿用 weaponType 用词，本站产品概念为「特性」。 |

属性与特性的筛选项（`elements` / `specialties` 表）由全部代理人条目推导，不做手工维护；schema 校验每个分类都被至少一名代理人使用。数据包没有分类图标的结构化资源字段（`iconPath` 恒为 null），分类图标由本站图片资源清单按分类 ID 提供（`iconAsset` 主干，如属性 200 → `IconPhysical`），来源见下文「分类图标来源」；旧目录快照缺该字段时筛选按钮回退名称文字。

## 图片资源与公开路径

图片资源与角色数据分开版本管理：`agentDataVersion` 固定 Fairy 数据版本，`imageAssets.revision`（当前 `2026-10-09`）固定图片资源修订。改图片或改裁切校准都产生新修订目录，旧修订目录与旧圆图副本保留（live 房间与归档可能长期引用，不按发布后 90 天删除）。文件路径、资源主干与裁切校准值共同按不可变修订管理；快照保存的稳定路径足以定位资源与裁切修订，不依赖当前最新目录或可变默认配置。

公开 URL 布局由 `shared/agents/assets.ts` 单一所有者维护，组件与投影不自行拼接；同源根路径引用，不含当前机器地址或预发布域名：

| 资源 | 路径 | 用途 |
|---|---|---|
| 方图母图 | `/images/agents/<修订>/<主干>.webp` | 384x384（上游 `IconRoleCrop*`）；池内方图与选用区宽幅裁切共用同一母图。 |
| 缩略图 | `/images/agents/<修订>/<主干>-128.webp` | 由母图离线生成（sharp，128x128），顶部禁用区使用；与母图同修订。 |
| 分类图标 | `/images/classifications/<修订>/<主干>.webp` | 源图约 53–64px、透明，展示保持比例不拉伸。 |
| 旧圆图本地副本 | `/images/agents/legacy/IconRoleCircleNN.webp` | 旧目录/旧归档引用的圆图，142x142，按原文件名保存。 |

旧地址解析（同在 `assets.ts`）：

- `toAgentImageUrl(avatarPath)`：按上游已确认规则由来源路径派生远程圆图 URL（`UI/.../IconRoleCircle01.png` → `https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp`）；`live2_d` 等无图片扩展名的资源标识不适用，无来源路径返回 null。这是旧目录快照的解释路径，不是新资源的来源。
- `localizeLegacyAgentImageUrl(url, localFileNames)`：把 `toAgentImageUrl` 域内、文件名精确匹配 `IconRoleCircleNN.webp` **且实际已收录**的远程 URL 映射到上述本地副本（文件名保持不变，不按角色 ID 推测、不把旧圆图替换为新方图）；收录名单取目录产物内嵌的 `imageAssets.legacyCircleFileNames` 摘要（由清单生成、经测试对齐，含审计事实的完整清单不进入运行时 bundle），形似而未收录的文件名（如 `IconRoleCircle40.webp`）不重写，与未知 URL 一致原样返回，展示按外部图片处理（contain 展示、失败走占位，不自动重新热链）。legacy 副本跨修订只增不改，当前构建的摘要是历史摘要的超集，旧目录快照与旧归档也按当前摘要判断收录。

新归档保存稳定本地路径：带图片资源引用的条目经 `toAgentDisplayLookup`（`shared/agents/catalog.ts`）保存方图母图路径与宽幅裁切（归档操作的 `agentAvatarUrl`/`agentAvatarCrop` 字段）；旧目录条目保存映射后的旧圆图本地副本路径。旧归档快照按其保存的地址原样解释（远程圆图 URL 在展示时映射到本地副本）。

## 图片资源导入流程

导入脚本 `pnpm run import:image-assets`（`scripts/import-image-assets.ts`）只在显式资源更新时运行：

```sh
pnpm run import:image-assets -- --sources <已核验来源目录> --crops <裁切校准文件> [-- --revision <id>]
```

- 方图母图、分类图标与未收录的旧圆图：`--sources` 指定本地已核验来源目录（上游核验缓存，如本机 `~/.cache/zzzbp/` 的验证产物）时从该目录读取（文件名与资源主干一致），缺失即失败、不回退网络；未提供目录则从上游 URL 下载（携带浏览器 UA 与 Referer——普通 HEAD 会被 403，见下文核验记录）。全部来源核验为 WebP（母图 384x384、分类图标 ≤128px）。
- 128 缩略图由母图离线生成（sharp 固定参数，同版本字节可复现）；不引入需要构建时联网的步骤。
- 宽幅裁切校准值来自 `--crops` 文件（逐角色看图校准的 `{ "<主干>": {x, y} }`，x/y 为 object-position 百分比）；必须覆盖全部主干，不使用猜测默认值。未提供时沿用现有清单的同一图标集裁切值。
- 不可变资源约定（写入前整批校验，实现见 `shared/agents/assets-import.ts`，规则测试见 `tests/rules/agent-image-import.test.ts`）：版本目录按修订不可变，复用同一修订重跑必须与现有清单完全一致，图片或裁切校准的任何变化（含新增条目）都必须使用新 `--revision`；legacy 旧圆图副本跨修订只增不改，已收录的记录与文件原样保留、不重新读取来源（上游后续变化不回写副本），仅未收录的文件名读取来源并新增记录；任何冲突（同路径不同内容、清单与磁盘不一致）在写入任何资源或清单之前失败，不产生部分更新；相同内容允许幂等重跑（不重写文件与清单）。
- 产出 `public/images/` 静态资源（沿既有 Vite / Workers Static Assets 分发链路，同源访问）与 `shared/agents/assets.json` 清单；文件与清单的一致性（存在性、字节数、SHA-256、尺寸、目录引用对齐）由 `tests/rules/agent-image-assets.test.ts` 校验，常规构建与 CI 不联网。

### 方图母图来源与核验

母图来自 Nanoka 静态资源 `https://static.nanoka.cc/assets/zzz/<主干>.webp`（主干按 `data.icon` 的 Role → RoleCrop 规则推导，与 hakushin-py 等上游消费库一致）。2026-10-09 已对当前安装包全部 58 人执行真实 GET 下载、尺寸/哈希核对与浏览器解码检查：58/58 HTTP 200、全部 384x384 WebP、互不相同哈希、无空白图；共约 8.43 MiB。57 张含透明区域；`1411` 柚叶（IconRoleCrop47）为完全不透明图的已知例外，保留原貌不做生成式重绘。

### 分类图标来源

| 分类 | 主干 | 来源 |
|---|---|---|
| 属性 200/201/202/203/204/205 | IconPhysical / IconFire / IconIce / IconElectric / IconWind / IconEther | Nanoka 静态资源（已核验下载解码）。 |
| 属性 300 流明 | IconLumiflux | Nanoka `IconLumiflux.webp` 返回 404；使用 Gachabase 分类资源（60x60 WebP，来自其角色页的分类图标）。仅提取分类图标本身，不引入该页面的角色 ID 或名单。 |
| 特性 1–6 | IconAttackType / IconStun / IconAnomaly / IconSupport / IconDefense / IconRupture | Nanoka 静态资源（已核验下载解码）。 |

来源表维护在导入脚本的 `CLASSIFICATION_ICON_SOURCES` 常量（单一事实来源）；数据包新增分类而没有来源记录时导入显式失败。通用操作图标（返回、搜索、清除等）继续使用 `@lucide/vue` 矢量图标，不改为位图。

## 实际导入概况（npm 0.2.1，游戏 3.1）

- **58 名代理人**，按来源 ID 数值升序（`1011` 安比 → `1591` 希格莉德），全部来自上游 `integrated/agents` 代理人主表；上游以目录区分代理人/邦布/怪物/Boss 等类别，代理人主表内没有已实装/未实装的区分字段，本站按主表全量使用，不凭缺头像或名单外判断删改条目。
- **55 名有官方全名**（`fullName`，如 雅→星见雅、猫又→猫宫又奈）；`1381` 零号·安比、`1531` 星徽·比利、`1551` 佩洛伊斯来源未记录全名，为 `null`。
- **7 项属性**：物理(200)、火属性(201)、冰属性(202)、电属性(203)、风属性(204)、以太(205)、流明(300)。
- **6 项特性**：强攻(1)、击破(2)、异常(3)、支援(4)、防护(5)、命破(6)。
- **缺 avatarPath 3 名**：`1381` 零号·安比、`1531` 星徽·比利、`1551` 佩洛伊斯（上游 `partnerInfo` 无 `iconPath` 记录）；三者均有 `data.icon` 并由图片资源清单提供方图资源（IconRoleCrop40/62/63），新目录显示方图；没有图片资源引用且缺少 `avatarPath` 的旧快照继续显示占位。
- **图片资源修订 `2026-10-09`**：58 张方图母图（384x384，约 8.43 MiB）与同修订缩略图、13 个分类图标、55 张旧圆图本地副本（142x142），共 184 个文件约 9.27 MiB；宽幅裁切校准值随逐角色看图检查固定在清单内。
- 比赛专用白名单未核定：当前目录即主表全量，本站不因名单范围阻塞现有功能；名单与 `agentDataVersion` 的组合可被后续房间持久化保存为固定输入，避免升级后把已有预选/结果换成另一版本解释。

## 版本更新办法

Fairy 数据版本更新（npm 包新版本）：

1. 查询 npm 最新版本与发布内容，确认与 Tailwind/工具链无关后，修改 `package.json` 中 `@randomplay/data` 的精确版本并 `pnpm install`（pnpm 供应链策略默认生效，过新版本会被拒绝，不放宽设置）。
2. 运行 `pnpm run generate:agent-catalog` 重新生成产物（图片资源引用按新名单与现有清单比对；新增代理人/分类缺资源记录时显式失败，先按下一条流程补充图片资源）。
3. 检查 `shared/agents/catalog.json` 的 diff（数量、名单、分类变化）。
4. 更新 `tests/rules/agent-catalog.test.ts` 中的固定版本常量与导入概况断言（测试同时校验产物版本与安装依赖一致，防止只升级依赖不重新生成）。
5. 运行 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build` 后提交。

图片资源更新（新角色方图、改图片或改裁切校准）：

1. 准备已核验的母图目录（下载并核对尺寸/哈希/解码；上游 URL 需浏览器 UA 与 Referer），逐角色看图校准宽幅裁切，产出裁切校准文件。
2. 运行 `pnpm run import:image-assets -- --sources <来源目录> --crops <校准文件> [-- --revision <新修订>]`；产出新的 `public/images/agents/<新修订>/`、`public/images/classifications/<新修订>/` 目录与更新后的 `shared/agents/assets.json`（旧修订目录与 legacy 副本保留；新收录的旧圆图仅追加记录，已收录副本不回写）。
3. 运行 `pnpm run generate:agent-catalog` 把新修订引用进目录产物，检查 diff。
4. 更新 `tests/rules/agent-catalog.test.ts` 的 `PINNED_IMAGE_ASSETS_REVISION` 与图片资源概况断言，跑全量检查后提交。

上游头像补齐或数据结构变化后同一流程处理；不改写 `fairy` 上游、不发 issue、不另选数据来源。

## 未验证项

- 图片资源的事实记录（来源 URL、哈希、尺寸、解码）以 2026-10-09 的导入核验为准，`tests/rules/agent-image-assets.test.ts` 校验已提交文件与清单一致；上游 URL 的长期可达性不构成运行时依赖（页面只访问本站同源静态资源）。
- 上游 npm 包 0.2.1 之后版本（含 fairy main 已合入但未发布的 3.2 数据，60 名代理人）的破坏性结构变化未验证，发布后按「版本更新办法」重新核对；不接入未发布的两人、不修改 fairy。
- 比赛专用白名单未核定（当前为主表全量，不构成功能阻塞）。
