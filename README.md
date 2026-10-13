# zzzbp

面向电脑浏览器的《绝区零》（Zenless Zone Zero）危局强袭战单局 BP 工具。
房主建房并安排双方选手，选手按顺序禁用、选用代理人，观众实时查看过程与结果。

## 使用

房主从站点首页创建房间，选手和观众通过分享的房间链接进入。建房与开局、预选与确认、
展示页、结果导出、断线重进和记录保留见[使用指南](docs/usage.md)。

部署情况见[预发布部署与操作交接](docs/deployment.md#当前部署证据边界)，
发布与验收情况见[首版发布与验收说明](docs/release.md#当前状态)。

## 开发

```sh
pnpm install
pnpm dev        # cf dev：前端与本地 Workers 环境
```

常用脚本（`lint`、`format:check`、`typecheck`、`test`、`test:e2e`、`measure:rooms`、
`build`）见[开发指南](docs/development.md)，产品范围与规格见[文档索引](docs/index.md)。
