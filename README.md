# zzzbp

绝区零（Zenless Zone Zero）BP 房间网站：建房、入房、安排选手与单局 BP 的实时对局工具。

当前已建立工程基础（Vue 3 前端、Cloudflare Worker 与 SQLite Durable Object）、BP 规则与房间协议合同，并接入固定版本的代理人目录；业务界面随后续版本提供。

## 开发

```sh
pnpm install
pnpm dev        # cf dev：前端与本地 Workers 环境
```

常用脚本（`lint`、`format:check`、`typecheck`、`test`、`build`）见 [开发指南](docs/development.md)，产品范围与规格见[文档索引](docs/index.md)。
