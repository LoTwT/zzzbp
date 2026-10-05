# zzzbp

绝区零（Zenless Zone Zero）BP 房间网站：建房、入房、安排选手与单局 BP 的实时对局工具。

首版功能已在本地完成并验收：建房与身份恢复、房间协作与权限、完整 26 步 BP、断线/换人/
重连核对、独立展示页、12 小时归档与 90 天只读记录。尚未部署到 Cloudflare；验收结论、
覆盖映射与部署前检查见[首版发布与验收说明](docs/release.md)。

## 开发

```sh
pnpm install
pnpm dev        # cf dev：前端与本地 Workers 环境
```

常用脚本（`lint`、`format:check`、`typecheck`、`test`、`test:e2e`、`measure:rooms`、
`build`）见[开发指南](docs/development.md)，产品范围与规格见[文档索引](docs/index.md)。
