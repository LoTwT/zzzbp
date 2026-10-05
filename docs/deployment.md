# 预发布部署与操作交接

本文是首版预发布（真实账户部署与公网验收）的操作正文：目标、前置核查、用户操作步骤、
成功标志、回退方案与未验证边界。发布条件与本地验收事实由[首版发布与验收说明](release.md)
维护；费用与容量边界见 [Cloudflare 部署与预算评估](specs/cloudflare-budget.md)；日常开发
与本地验证命令见[开发指南](development.md)。

状态（2026-10-05，任务分支 `chore/preview-release`）：本地准备与本地验证已完成，**未执行
任何部署、版本上传或远端写入**。下方「已核实」「本轮本地验证」为已确认事实；「用户操作」
与「部署后验收」需要在真实账户执行，属独立动作。

## 预发布目标

- 在真实账户部署一个**独立测试 Worker `zzzbp-preview`**，首轮直接使用 workers.dev 地址；
  不配置自定义域与路由、不启用 Access、不改 Cookie 与任何产品行为。
- **独立房间存储**：Durable Object 命名空间按 Worker 隔离（`Room` 类由该 Worker 的
  `exports` 声明），预览环境的房间与归档数据不与正式名 `zzzbp`（账户内尚不存在）及账户内
  其他项目混用。
- 目标是有界的公网冒烟与多设备验收（见「部署后公网验收」），**不是容量承诺**；额度、
  休眠与计费行为需在该账户实际确认。
- 名称来源唯一：`cloudflare.config.ts` 按 `cf` 官方配置上下文以 `mode` 派生 Worker 名——
  `cf deploy -m preview` → `zzzbp-preview`，不带 `-m`（或其它 mode）→ `zzzbp`；没有第二套
  部署配置。参考 [cf 程序化配置](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
  （`mode` 上下文与按 mode 派生 `name` 的官方示例）。该命令同时以 Vite `preview` mode 构建；
  本仓库未使用 `import.meta.env` 或 mode 相关环境文件，构建行为与默认一致（已本地复核）。

## 已核实的现状（2026-10-05，只读检查，未写入远端）

- CLI：`cf` 1.0.0-beta.12（`package.json` 锁定），`pnpm exec cf --version` 复核一致。
- 登录：本机默认 OAuth 档案有效，且只有一个账户（`pnpm exec cf auth whoami`，只输出状态，
  不输出 token）；本次核实无需选择账户。多账户时 `cf deploy` 会要求选择。
- 同名检查：`pnpm exec cf workers list` 共 10 个既有 Worker，其中没有 `zzzbp`，也没有
  `zzzbp-preview`；不与账户内其他项目重名或覆盖。
- workers.dev：账户级子域已注册（既有 Worker 已有 `<子域>.workers.dev` 形态的地址）；预览
  Worker 无路由时会默认分配 workers.dev 路由，实际地址由部署输出给出。
- 未核实：账户套餐（Free/Paid）与额度占用、公网可达性、真实账户的休眠/CPU/日志计费行为。
  注意额度按账户汇总，该账户已有其他项目共同占用（见预算文档）。

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

## 用户操作步骤

按顺序执行；每步给出命令、预期结果与暂停条件。除明确要求外不要跳过预检。

1. **确认部署对象。** 在项目目录（`/Users/caoyujie/codes/zzzbp`）确认工作区处于父 review
   通过、准备部署的提交上：

   ```sh
   git status && git log -1 --oneline
   ```

   记录该 SHA（回退依据）；工作区应干净，不要带着未提交改动部署。

2. **登录状态检查（只读）。**

   ```sh
   pnpm exec cf auth whoami
   ```

   预期：`"authenticated": true`、`"tokenValid": true`，账户列表只有一个账户。
   若显示未登录：运行 `pnpm exec cf auth login`，在浏览器完成授权后回到终端，再重跑本步；
   不要在未确认账户的情况下继续。若出现多个账户：先反馈给父 session 确认目标账户再继续
   （额度按账户汇总，选错账户会把预览资源建到别处）。

3. **本地预检（不写远端）。**

   ```sh
   pnpm exec cf deploy -m preview --dry-run
   ```

   预期：构建成功（`Build complete`），然后出现 `--dry-run: exiting now.` 与
   `Dry run complete`；构建输出中的 Worker 名为 `zzzbp-preview`。此步不产生远端变更，
   失败时先把错误反馈给父 session，不要直接尝试真实部署。

4. **部署。**

   ```sh
   pnpm exec cf deploy -m preview
   ```

   预期：构建 → 上传 → `Deploy complete`；成功输出会包含该 Worker 的 workers.dev 地址
   （形如 `https://zzzbp-preview.<账户子域>.workers.dev`）。账户子域已注册，预期不会出现
   注册提示；
   若出现 "Would you like to register a workers.dev subdomain now?"，说明子域状态与记录
   不一致，停止操作并反馈。若命令要求登录、选择账户或开通付费项：**停止**，不要自行开通。
   成功后可复核（只读）：

   ```sh
   pnpm exec cf workers get zzzbp-preview
   pnpm exec cf workers versions list --worker-id zzzbp-preview
   ```

   记录首个版本 ID（回退用）与 `subdomain.url`。

5. **部署后抽查。**

   ```sh
   curl -sS https://<部署输出的地址>/api/health
   ```

   预期：HTTP 200，JSON 为 `{"ok":true,"room":{"createdAt":"..."}}`（存储链路自检，合同见
   `shared/api.ts`）。再用浏览器打开发布地址确认首页可创建房间；随后进入「部署后公网验收」。

6. **反馈清单（回父 session）。** 部署是否成功、打印的 workers.dev 地址、步骤 4 记录的
   版本 ID、真实套餐（在 Cloudflare 控制台确认 Free/Paid）、以及任何异常原文（不要粘贴
   token 或凭据）。至此用户操作暂停；公网验收按下一节执行，结果同样回传。

## 部署后公网验收

目标：真实多设备、不同网络下走一遍完整流程；沿用现有产品规则，不为验收修改产品常量或
增加测试入口。建议至少 2 台设备、2 种网络（如宽带 + 手机蜂窝），其中一台电脑用于操作，
一个独立窗口/设备用于展示页。

1. **建房与入房**：设备 1 打开发布地址建房（房名 + 昵称），复制房间链接；设备 2、3 以
   选手身份加入，由房主安排 A/B 席位；设备 4（另一网络）以观众加入；另开一个展示页
   （房间内「打开展示页」链接或直接访问展示地址）。
2. **完整 26 步**：按正式流程走完 26 步（含公开预选更换、确认、AP9 完成）；检查各设备
   公开状态与结果一致，展示页实时同步，无本地与服务端显示不一致。
3. **身份 Cookie 恢复**：关闭并重开成员浏览器，页面应直接恢复原角色（房主/选手/观众），
   无需重新入房；在另一台设备上以新观众加入，确认身份凭据不跨设备共享。
4. **掉线暂停与恢复**：关闭某位在席选手的全部页面，比赛应暂停；重新打开页面应恢复连接，
   房主可手动继续；房主执行换人后，原选手立即失去操作权并降级为观众，被换下者可重连
   观赛。
5. **结果未知核对**（可选，接近真实网络抖动）：选手提交瞬间断网或开飞行模式，页面应显示
   「结果未知/核对中」；恢复网络后客户端按同一操作重发一次，整场只推进一次、结果一致。
6. **独立展示页**：匿名可直接打开；URL 布局参数生效；代理人全量同屏无滚动/裁切（按该
   设备窗口）；展示页只有公开信息，无操作入口，不计成员在线。
7. **自然归档与记录回访**：全员离开房间后原链接保留 12 小时，再自动转为只读记录——这是
   自然生命周期，**不要**为验收修改时间常量或提前清理。到期后打开原链接：已完成/撤回后
   重开的有效结果应读到只读记录（快照、双方禁用区、到期时间）；未提交就离开的空记录
   房间到期后原链接为 404。此步需在离开房间 12 小时后回访。

每步失败时保留截图、时间、设备与网络环境并回传父 session；不要通过修改产品常量、删除
房间或省略步骤让验收「通过」。

容量观察（有界，不冒称容量承诺）：冒烟期间可在控制台查看该 Worker 与 Durable Objects 的
请求、时长与存储用量，与[预算文档](specs/cloudflare-budget.md#容量估算方法与本地基准)的
本地基准分开记录。1 房、房主 + 2 选手 + 1 观众 + 1 展示页只是冒烟规模；正式规模输入
（同时开房数、每房成员/展示页数、每日场次、预选频率、账户套餐与既有占用）确定后再复核。

## 回退方案

回退以「代码/配置可回退、房间数据保留」为原则；**不得用删除 Worker、删除 Room 类或丢弃
用户已确认结果的方式回退**。

- **代码/配置回退（首选）**：在修复提交上重新执行 `pnpm exec cf deploy -m preview`；部署
  复用同名 Worker 与同一 Durable Object 命名空间，房间与归档数据保留。
- **回滚到上一版本**（部署后发现问题、需要立即恢复旧行为）：
  - 控制台：Workers & Pages → `zzzbp-preview` → Deployments → 选择目标版本 → Rollback
    （见 [Workers Rollbacks 官方说明](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)）。
  - CLI：`pnpm exec cf workers versions list --worker-id zzzbp-preview` 取得目标版本 ID，再
    `pnpm exec cf workers deployments create --worker zzzbp-preview --versions '[{"version_id":"<版本 ID>","percentage":100}]'`。
  - 平台限制：只能回滚最近 100 个版本；若两版本之间发生 Durable Object 类生命周期变更
    （重命名/删除/转移），回滚会被拒绝。本项目预览期间 `Room` 类保持 live 声明、不做此类
    变更，满足回滚条件。以上回滚命令未在本轮实际执行（远端写操作），语义以官方文档与
    `cf workers deployments create --help` 为准。
- **停止公开访问**：在控制台关闭该 Worker 的 workers.dev 路由（Settings → Domains & Routes
  → workers.dev → Disable，见 [workers.dev 官方说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)）；
  不要删除 Worker 或命名空间。
- **数据保留与 schema**：房间与归档快照保存在该 Worker 的 Durable Object 命名空间中，代码
  回退不迁移、不删除数据。删除 `exports` 中的 `Room` 类（deleted tombstone）或删除整个
  Worker 会**永久删除该命名空间及全部房间数据**（[DO 类生命周期](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)），
  不属于回退手段。业务表 schema 版本当前为 3（见架构文档）；`ensureRoomSchema` 拒绝更高
  版本以防降级误读——若未来升级到 schema v4 后需要回到旧代码，旧代码无法服务 v4 房间，
  应先回滚到兼容版本，而不是清库或删除房间。
- **额度耗尽**：免费额度耗尽时相关动态操作会失败（界面须显示失败，不显示虚假成功）；
  处理方式是等待额度恢复或评审是否升级套餐，不得删除房间数据「恢复」。

## 未验证边界与最小必要输入

- 未验证：实际部署与公网访问、workers.dev 可达性、回滚命令真实执行、账户套餐与额度占用、
  休眠是否生效（计费运行时长）、免费版 10 ms CPU 限制、真实公网延迟下的掉线检测、额度
  耗尽行为、日志/trace 实际采集与计费（2026-12-01 起按届时的
  [Observability 定价](https://developers.cloudflare.com/observability/pricing/)复核）。
- 线上资源与本地基准分开：本地 `pnpm measure:rooms` 数字是本地 workerd 观测，不是
  Cloudflare 计费实测；线上数据以真实账户的用量面板为准。
- 最小必要输入（用户提供后按预算公式复核）：同时开房数、每房成员与展示页数、每日场次、
  预选更换频率、账户套餐与账户内既有项目占用。
