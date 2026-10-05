/**
 * E2E 服务地址的单一来源：globalSetup 与测试进程分别加载本模块，
 * 通过相同的环境变量约定（ZZZBP_E2E_PORT）得到一致的地址。
 * 端口选择与进程纪律见 tests/e2e/global-setup.ts。
 *
 * 使用 localhost 而非 127.0.0.1：本地 Vite 开发服务器在 IPv6
 * [::1] 上监听，浏览器与 fetch 都经 localhost 解析可达。
 */
export const E2E_PORT = Number(process.env.ZZZBP_E2E_PORT ?? 4517);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
