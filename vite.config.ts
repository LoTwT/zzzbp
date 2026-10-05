import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// cf dev / cf build / cf deploy 都通过该配置接入 cloudflare.config.ts：
// Worker 入口、SQLite Durable Object 与静态资源路由规则集中在那里维护。
//
// 环境变量仅服务于自动化验证（tests/e2e 的 globalSetup 注入），不改变
// 日常默认行为：
// - ZZZBP_DEV_PORT：Vite 开发服务器端口（默认 5173 不变）；
// - ZZZBP_DEV_PERSIST_STATE：workerd 本地持久化目录（默认 ~/.config/cloudflare
//   不变）。E2E 用独立临时目录隔离测试房间数据，避免污染开发状态。
const devPort = process.env.ZZZBP_DEV_PORT;
const persistStatePath = process.env.ZZZBP_DEV_PERSIST_STATE;

export default defineConfig({
  plugins: [
    tailwindcss(),
    vue(),
    cloudflare(persistStatePath === undefined ? {} : { persistState: { path: persistStatePath } }),
  ],
  server: devPort === undefined ? undefined : { port: Number(devPort) },
});
