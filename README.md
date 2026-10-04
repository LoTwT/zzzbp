# zzzbp

绝区零（Zenless Zone Zero）BP 房间网站：建房、入房、安排选手与单局 BP 的实时对局工具。

当前已交付房间主界面（首页建房、首次入房与身份恢复、角色权限展示、禁选槽位与代理人池、两个选用布局、统一控制面板）与常规 WebSocket 实时连接；独立展示页、归档记录与端到端收尾验证随后续版本提供。

## 开发

```sh
pnpm install
pnpm dev        # cf dev：前端与本地 Workers 环境
```

常用脚本（`lint`、`format:check`、`typecheck`、`test`、`build`）见 [开发指南](docs/development.md)，产品范围与规格见[文档索引](docs/index.md)。
