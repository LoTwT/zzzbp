import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// cf dev / cf build / cf deploy 都通过该配置接入 cloudflare.config.ts：
// Worker 入口、SQLite Durable Object 与静态资源路由规则集中在那里维护。
export default defineConfig({
  plugins: [tailwindcss(), vue(), cloudflare()],
});
