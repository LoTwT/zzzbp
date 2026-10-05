# 预发布部署与操作交接

本文是首版预发布（真实账户部署与公网验收）的操作正文：目标、前置核查、当前需要用户
确认的停止点、后续执行 runbook、公网验收流程、回退方案与未验证边界。发布条件与本地
验收事实由[首版发布与验收说明](release.md)维护；费用与容量边界见
[Cloudflare 部署与预算评估](specs/cloudflare-budget.md)；日常开发与本地验证命令见
[开发指南](development.md)。

状态（2026-10-05，任务分支 `chore/preview-release`，本地未 push）：本地准备与本地
验证已完成，**未执行任何部署、版本上传或远端写入**。预发布的人工前置（账户套餐确认，
见「当前需要用户的操作」）尚未完成；前置确认与父 review 齐备前不进入部署。下方「已核实」
「本轮本地验证」为已确认事实；执行类命令集中在「后续执行 runbook」，由父 review 与前置
条件齐备后编排，**不是用户当前的必做步骤**。

## 预发布目标

- 在真实账户部署一个**独立测试 Worker `zzzbp-preview`**，首轮直接使用 workers.dev 地址；
  不配置自定义域与路由、不启用 Access、不改 Cookie 与任何产品行为。
- **独立房间存储**：Durable Object 命名空间按 Worker 隔离（`Room` 类由该 Worker 的
  `exports` 声明），预览环境的房间与归档数据不与正式名 `zzzbp`（此次核查的目标账户内
  尚不存在）及账户内其他项目混用。
- 目标是一次有界的公网冒烟与多设备验收（见「部署后公网验收」），**不是容量承诺**；额度、
  休眠与计费行为需在该账户实际确认。
- 名称来源唯一：`cloudflare.config.ts` 按 `cf` 官方配置上下文以 `mode` 派生 Worker 名——
  `cf deploy -m preview` → `zzzbp-preview`，不带 `-m`（或其它 mode）→ `zzzbp`；没有第二套
  部署配置。参考 [cf 程序化配置](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
  （`mode` 上下文与按 mode 派生 `name` 的官方示例）。该命令同时以 Vite `preview` mode 构建；
  本仓库未使用 `import.meta.env` 或 mode 相关环境文件，构建行为与默认一致（已本地复核）。

## 已核实的现状（2026-10-05，只读检查，未写入远端）

- CLI：`cf` 1.0.0-beta.12（`package.json` 锁定），`pnpm exec cf --version` 复核一致。
- 登录：本机默认 OAuth 档案有效，且只有一个账户（`pnpm exec cf auth whoami`，只输出状态，
  不输出 token）；当前无需重新登录。仅当后续命令报告登录过期时，才需要浏览器授权（步骤
  见下）。多账户时 `cf deploy` 会要求选择账户。
- 同名检查：此次核查的目标账户内共 10 个既有 Worker，其中没有 `zzzbp`，也没有
  `zzzbp-preview`；此次任务未创建任何线上资源（不推断其他账户、其他名称或未来状态）。
- workers.dev：目标账户级子域已注册（既有 Worker 已有 `<子域>.workers.dev` 形态的地址）；
  预览 Worker 无路由时会默认分配 workers.dev 路由，实际地址由部署输出给出。
- **Workers 套餐尚未确认**：Workers 计划（Free/Paid）与账户下其它产品的订阅相互独立；
  父会话只读执行 `cf accounts subscriptions get` 仅返回另一产品的付费订阅，**该查询不能
  用于判断 Workers 计划**（去敏结果未入库、不作为部署依赖）。需用户在控制台确认，见下节。
- 未核实：公网可达性、真实账户的休眠/CPU/日志计费行为与额度占用（额度按账户汇总，账户
  内其他项目会共同占用）。

## 本轮本地验证（已完成，无需用户操作）

基于 `main` 8289bf2 + 预览名配置改动（`cloudflare.config.ts` 以 mode 派生名称）：

| 检查 | 结果 |
|---|---|
| `oxlint` / `oxfmt --check`（cloudflare.config.ts） | 通过 |
| `pnpm typecheck`（含 `cf workers types`） | 通过 |
| `pnpm build` | 通过；构建输出 Worker 名为 `zzzbp` |
| `pnpm exec cf build -m preview` | 通过；构建输出 Worker 名为 `zzzbp-preview` |
| `pnpm exec cf deploy -m preview --dry-run` | 通过；输出 `--dry-run: exiting now.` 与 `Dry run complete` |
| `pnpm test` | 32 个文件、362 条通过（含真实 workerd） |
| `pnpm test:e2e` | 4/4 通过（真实 `cf dev` 路径） |

`--dry-run` 的无远端写入结论来自已安装代码核实：dry-run 不获取凭据、不解析账户，`Deploy`
上传路径在 dry-run 时于上传前退出；执行后 `cf workers list` 的 Worker 数量与名称均未变化。
`pnpm measure:rooms` 本轮未重跑：改动不涉及测量与服务端路径，沿用冻结基线 `17b3d3b` 的
结果（数字见[预算文档](specs/cloudflare-budget.md#容量估算方法与本地基准)）。

## 当前需要用户的操作（唯一人工步骤；完成后暂停）

用户当前只需要做一件事：**在控制台确认目标账户的 Workers 套餐与可用额度，并给出可接受
的预发布范围**。这是本次交接的停止点——确认反馈并等父 review 编排之前，不进入部署。

1. **控制台确认套餐与额度。**
   - 入口：Cloudflare 控制台 → **Workers & Pages**（账户级页面）：
     <https://dash.cloudflare.com/?to=/:account/workers-and-pages>；在该页右侧菜单查看
     Plan/套餐 与 Usage/用量（不同界面版本可能显示为 Plans 或 Subscription）。也可从账户
     Billing → Subscriptions 交叉查看；免费计划不会出现 Workers 订阅行，属正常，该列表
     不能单独证明 Workers 计划。
   - 需要读到的字段：当前 Workers 计划（Free 或 Paid，Paid 起价 $5/月）；该计划包含的额度
     （请求、CPU 时间、Durable Objects 用量与存储等维度）；如界面提供，记录本月已用量/
     剩余额度。界面与上述描述不符时，以实际界面为准并原样反馈字段，不要猜测。
   - 需要反馈（不含 secret）：计划名称（Free/Paid）；能否接受按该计划做一次有界冒烟；
     若存在付费可能，可接受的开销界限；以及界面中与本文描述不一致之处。
2. **确认可接受的预发布范围。** 建议一次受控冒烟：1 房、房主 + 2 选手 + 1 观众 + 1 展示页，
   在真实多设备/不同网络下走完「部署后公网验收」。正式的规模输入（同时开房数、每日场次
   等）用于后续容量复核，不是本次冒烟的阻塞项。
3. **暂停点与分支处理。** 反馈以上信息后停止，不要自行执行 `deploy`（也不要求交付任何
   token）。后续按套餐结论继续：
   - **Free**：可在免费额度内做有界冒烟；额度耗尽时相关操作会失败（不会转为扣费），且
     额度按账户汇总、会被其他项目占用。
   - **Paid**：在包含额度内使用；超出后继续按量计费，预算提醒只发通知、不封顶账单——只有
     用户给出可接受开销界限后再继续。
   - **无法确认或不接受费用风险**：暂不部署，改为仅在本地复核；把结论反馈父会话。
4. **登录说明（仅过期时需要）。** 本机 CLI 当前已登录（2026-10-05 只读核实），无需重新
   登录；仅当后续命令报告登录过期时，执行 `pnpm exec cf auth login`，在浏览器完成授权后
   回到终端重跑该检查。

## 后续执行 runbook（前置满足后由父编排；本轮不执行）

以下命令包含远端写与线上操作，**必须**在「当前需要用户的操作」完成、父 review 齐备后
执行；执行结果（不含 token）反馈父会话。

1. **确认部署对象。** 在项目目录 `/Users/caoyujie/codes/zzzbp`：

   ```sh
   git status && git log -1 --oneline
   ```

   预期工作区干净；记录该 SHA（回退依据）。

2. **登录状态检查（只读）。**

   ```sh
   pnpm exec cf auth whoami
   ```

   预期 `"authenticated": true`、`"tokenValid": true` 且只有一个账户；过期时按上一节
   第 4 条完成授权后重跑。出现多账户时先由父确认目标账户，不要直接继续。

3. **本地预检（不写远端）。**

   ```sh
   pnpm exec cf deploy -m preview --dry-run
   ```

   预期：构建成功（`Build complete`），出现 `--dry-run: exiting now.` 与 `Dry run complete`；
   构建输出中的 Worker 名为 `zzzbp-preview`。此步不产生远端变更。

4. **部署。**

   ```sh
   pnpm exec cf deploy -m preview
   ```

   预期：构建 → 上传 → `Deploy complete`；成功输出会包含该 Worker 的 workers.dev 地址。
   账户子域已注册，预期不会出现注册提示；若出现 "Would you like to register a workers.dev
   subdomain now?"，停止并反馈。若命令要求登录、选择账户或开通付费项：**停止**，不要自行
   开通。

5. **记录与复核（只读）。**

   ```sh
   pnpm exec cf workers versions list --worker-id zzzbp-preview
   pnpm exec cf workers get zzzbp-preview
   ```

   记录首个版本 ID（回退用）与 `subdomain.url`。

6. **线上抽查。** 把变量设为部署输出中的完整地址（含 `https://`，不要重复拼接协议）：

   ```sh
   export ZZZBP_PREVIEW_URL='https://zzzbp-preview.<账户 workers.dev 子域>.workers.dev'
   curl -fsS "$ZZZBP_PREVIEW_URL/api/health"
   open "$ZZZBP_PREVIEW_URL"   # macOS；或手动在浏览器打开
   ```

   预期：健康检查返回 `{"ok":true,"room":{"createdAt":"..."}}`（存储自检，合同见
   `shared/api.ts`）；浏览器能打开首页并创建房间。

7. **反馈父会话**：部署是否成功、实际 URL、版本 ID、套餐确认结论、任何异常原文（不含
   token 或凭据）。之后按「部署后公网验收」执行并回传结果。

## 部署后公网验收

目标：真实多设备、不同网络下走一遍完整流程；沿用现有产品规则，不为验收修改产品常量或
增加测试入口。视口使用首版已验证的桌面范围（1280×640 及以上，见[分层证据边界](release.md#分层证据边界)）；
手机可用于提供第二网络（热点）或作为展示页观察设备，但移动端布局不是本次验收要求。

**角色与独立上下文**：不同成员角色必须使用**独立的 Cookie 上下文**——不同浏览器、不同
profile/隐私窗口或不同设备；**同一浏览器的普通多标签共享同一身份**，不能当两个成员。
按角色准备上下文：房主 1 个、两名选手各 1 个、观众 1 个（共 4 个成员上下文；房主兼任
选手时可合并并相应减少）；另加 1 个展示页上下文（展示页匿名，普通独立标签即可，建议与
成员窗口分开便于观察）。不强制 4 台设备——同一台机器可用不同浏览器或 profile 提供多个
独立上下文。

1. **建房与入房**：上下文 A 建房（房名 + 昵称）；上下文 B、C 以选手身份加入，由房主安排
   A/B 席位；上下文 D 以观众加入；另开一个展示页（房间内「打开展示页」链接或直接访问
   展示地址）。
2. **对局中的掉线 / 恢复 / 换人（必须在完成之前做）**：开局进入 running 后：
   - 关闭某位在席选手的**全部**页面 → 比赛应自动暂停（只有进行中的对局才会因掉线暂停）。
   - 重新打开其中一页 → 恢复连接与原角色；**重连不会自动恢复进行**，对局保持暂停，等待
     房主操作。
   - 房主**在暂停（paused）状态下**执行换人（换人仅在 waiting/paused 可用，running 中
     会被拒绝）→ 原选手立即失去操作权并降级为观众，被换下者可重连观赛；确认此前已提交
     的预选与序列仍在。
   - 房主手动继续（回到 running）→ 继续正常推进若干步。
   - （可选）若还要单独验证一次「手动继续」：先在 paused 下手动继续，再次让在席选手掉线
     暂停，然后再换人；更短的默认路径是暂停中直接换人。
   - 若已完成 26 步（completed），此时断开选手**不会**暂停；需先重开一局并重新进入
     running，再验证暂停与恢复。
3. **完整 26 步**：按正式流程走完 26 步（含公开预选更换、确认、AP9 完成）；检查各上下文
   的公开状态与结果一致，展示页实时同步、无本地与服务端显示不一致。
4. **身份 Cookie 恢复**：关闭并重开某成员上下文（同一 Cookie 上下文）→ 直接恢复原角色，
   无需重新入房；再用一个**全新独立上下文**以新观众加入 → 不继承任何既有身份（凭据不跨
   上下文共享）。
5. **结果未知与网络抖动（可选观察；穿插在步骤 2/3 的进行中对局里做）**：在一次「进行中」
   的提交/确认瞬间断网或切飞行模式（房间已完成（completed）后没有可提交的操作，不在该
   状态尝试本项）。结果取决于成功回执是否已到达浏览器——已到达则按成功结算，未到达才
   进入「核对中」；出现哪种都按实际记录，不以必须出现核对为标准，也不假设只发生一次
   重发。核对时客户端按同一 operationId 重发，服务端持久回执按同载荷幂等处理，保证整场
   只推进一次；回执丢失的确定性时序已由 `tests/e2e`（resilience）覆盖，无需在公网复现
   全部时序。
6. **独立展示页**：匿名可直接打开；URL 布局参数生效；代理人全量同屏无滚动/裁切（按该
   窗口尺寸）；展示页只有公开信息、无操作入口，不计成员在线、不影响房间保留计时。
7. **归档与记录回访（自然期限，两个房间分别验证）**：全员离开后原链接保留 12 小时（保持
   产品常量，不为验收提前或修改）。
   - **有结果房间**：让最后一局保留至少一条有效提交（例如正常完成 26 步）。12 小时后原
     链接进入只读记录，回访应看到**最后一局**的最终有效序列、双方禁用区与记录到期时间。
   - **空结果房间**：重开后**没有任何新提交**（或全部撤回、仅预选）。即使重开前曾完成过
     一局，该局也不单独归档；12 小时后原链接按 404 处理（房间被清理，不生成快照）。
   - 归档只保留最后一局的有效序列；重开或撤回会改变当前有效序列，说明与预期以
     [房间保留与只读记录](specs/room-roles.md#房间保留与只读记录)为准。

每步失败时保留截图、时间、设备/网络环境并回传父会话；不要通过修改产品常量、删除房间或
省略步骤让验收「通过」。

容量观察（有界，不冒称容量承诺）：冒烟期间可在控制台查看该 Worker 与 Durable Objects 的
请求、时长与存储用量，与[预算文档](specs/cloudflare-budget.md#容量估算方法与本地基准)的
本地基准分开记录；1 房、房主 + 2 选手 + 1 观众 + 1 展示页只是冒烟规模。

## 回退方案

先区分两个动作：**向前修复**＝修代码后重新部署同一 Worker；**回滚**＝把流量切回上一已
发布版本。两者都以「房间数据保留」为原则；**不得用删除 Worker、删除 Room 类或丢弃用户
已确认结果的方式回退**。

- **向前修复（首选，任何阶段适用）**：在修复提交上重新执行 `pnpm exec cf deploy -m preview`；
  同名 Worker 复用同一 Durable Object 命名空间，房间与归档数据保留。若问题影响对外
  可用性，先执行下面的「停止公开访问」。
- **首次部署尚无上一已发布版本时的路径**：没有可回滚目标。出现问题先利用保留数据的停止
  入口（关闭 workers.dev 路由）停止对外访问，保留 Worker、命名空间与数据，修复后以同名
  重新部署；不要删除 Worker 或 `Room` 类。
- **回滚到上一版本（仅当已有上一已发布版本）**：
  - 控制台：Workers & Pages → `zzzbp-preview` → Deployments → 选择目标版本 → Rollback
    （[官方说明](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)）。
  - CLI：`pnpm exec cf workers versions list --worker-id zzzbp-preview` 取得目标版本 ID，再
    `pnpm exec cf workers deployments create --worker zzzbp-preview --strategy percentage --versions '[{"version_id":"<版本 ID>","percentage":100}]'`。
  - 平台限制（以官方说明为准）：只能回滚到最近 100 个版本；若所选版本与当前活动部署之间
    发生过 Durable Object 类生命周期变更（经 `exports` 或旧版 `migrations`），或绑定资源
    （R2/KV/queue 等）被删除或修改，平台会拒绝回滚。本项目尚未部署、也无多个已发布版本；
    未来回滚是否可用取决于当时两版本间是否发生上述变更，且**本次未实际执行回滚**，以
    平台实际检查为准。
- **停止公开访问（保留数据）**：在控制台关闭该 Worker 的 workers.dev 路由（Settings →
  Domains & Routes → workers.dev → Disable，见
  [workers.dev 官方说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)）；
  不要删除 Worker 或命名空间。
- **数据保留与 schema**：房间与归档快照保存在该 Worker 的 Durable Object 命名空间中，代码
  回退不迁移、不删除数据。删除 `exports` 中的 `Room` 类（deleted tombstone）或删除整个
  Worker 会**永久删除该命名空间及全部房间数据**（[DO 类生命周期](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)），
  不属于回退手段。业务表 schema 版本当前为 3（见架构文档）；`ensureRoomSchema` 拒绝更高
  版本以防降级误读——若未来升级到 schema v4 后需要回到旧代码，旧代码无法服务 v4 房间，
  应先回滚到兼容版本，而不是清库或删除房间。
- **额度耗尽**：额度耗尽时相关动态操作会失败（界面须显示失败，不显示虚假成功）；处理方式
  是等待额度恢复或评审是否升级套餐，不得删除房间数据「恢复」。

## 未验证边界与最小必要输入

- 未验证：实际部署与公网访问、workers.dev 可达性、回滚命令真实执行、账户套餐与额度占用
  （只读订阅查询未能给出 Workers 计划）、休眠是否生效（计费运行时长）、免费版 10 ms CPU
  限制、真实公网延迟下的掉线检测、额度耗尽行为、日志/trace 实际采集与计费（2026-12-01
  起按届时的 [Observability 定价](https://developers.cloudflare.com/observability/pricing/)
  复核）。
- 线上资源与本地基准分开：本地 `pnpm measure:rooms` 数字是本地 workerd 观测，不是
  Cloudflare 计费实测；线上数据以真实账户的用量面板为准。
- 本次有界冒烟的最小输入：目标账户 Workers 计划与可接受的开销范围（见「当前需要用户的
  操作」）；冒烟范围本身。正式规模输入（同时开房数、每房成员与展示页数、每日场次、预选
  更换频率、账户内既有项目占用）用于后续容量复核，不是本次冒烟的阻塞项。
