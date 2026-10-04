import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { apiErrorResponseBodySchema } from "../../shared/contracts/http";
import worker from "../../server/index";

// Workers 集成测试：统一错误边界的脱敏诊断。
// 请求体流读取到一半即以给定原因失败，异常内容全部为合成哨兵；断言应用
// 日志只含静态分类与请求关联字段，不落异常自带内容。全部为合成数据，
// 不涉及真实凭据。经 worker.fetch 直接驱动：合成请求体在到达统一错误
// 边界前由 Worker 读取，不能经由测试 fetcher 包装提前缓冲或失败。

const BASE_URL = "http://localhost";
const SYNTHETIC_SENTINEL = "SYNTHETIC_CREDENTIAL_SENTINEL_FOR_REVIEW";

/** 统一错误边界的日志字段白名单（排序后）。 */
const EXPECTED_LOG_FIELDS = ["errorKind", "event", "method", "path", "requestId"];

/** 直接驱动 Worker 入口时 fetch 的请求参数类型（入站 cf 属性比构造参数更完整）。 */
type WorkerFetchRequest = Parameters<typeof worker.fetch>[0];

/** 请求体流读取中段以给定原因失败的请求（模拟携带敏感文本的上游异常）。 */
function requestWithFailingBody(reason: unknown): WorkerFetchRequest {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"roomName":"r","nickname":"n"'));
      controller.error(reason);
    },
  });
  return new Request(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }) as WorkerFetchRequest;
}

/** 驱动一次必然进入统一错误边界的请求，返回响应与捕获到的诊断日志行。 */
async function fetchWithCapturedLog(
  reason: unknown,
): Promise<{ response: Response; rawLog: string }> {
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await worker.fetch(
      requestWithFailingBody(reason),
      env,
      createExecutionContext(),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    return { response, rawLog: String(logSpy.mock.calls[0]?.[0]) };
  } finally {
    logSpy.mockRestore();
  }
}

describe("统一错误边界的脱敏诊断", () => {
  it("异常消息与自定义 name 含合成秘密时不写入日志，只记录白名单字段", async () => {
    const { response, rawLog } = await fetchWithCapturedLog(
      Object.assign(new Error(`upstream rejected token=${SYNTHETIC_SENTINEL}`), {
        name: `CustomName-${SYNTHETIC_SENTINEL}`,
      }),
    );

    // 客户端仍只得到通用 500：no-store、无失败身份 Cookie。
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(apiErrorResponseBodySchema.parse(await response.json()).error.code).toBe("INTERNAL");

    // 定位字段与请求关联仍成立；异常自带内容不出现。
    expect(rawLog).not.toContain(SYNTHETIC_SENTINEL);
    const diagnostic = JSON.parse(rawLog) as Record<string, unknown>;
    expect(Object.keys(diagnostic).sort()).toEqual(EXPECTED_LOG_FIELDS);
    expect(diagnostic).toMatchObject({
      event: "api.internal_error",
      method: "POST",
      path: "/api/rooms",
      errorKind: "internal",
    });
    expect(String(diagnostic.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("X-Request-Id")).toBe(diagnostic.requestId);
  });

  it("非 Error 抛出值与自定义字段不能绕过字段白名单", async () => {
    const { response, rawLog } = await fetchWithCapturedLog({
      name: SYNTHETIC_SENTINEL,
      message: SYNTHETIC_SENTINEL,
      cause: SYNTHETIC_SENTINEL,
    });

    expect(response.status).toBe(500);
    expect(rawLog).not.toContain(SYNTHETIC_SENTINEL);
    const diagnostic = JSON.parse(rawLog) as Record<string, unknown>;
    expect(Object.keys(diagnostic).sort()).toEqual(EXPECTED_LOG_FIELDS);
    expect(diagnostic.errorKind).toBe("internal");
    expect(response.headers.get("X-Request-Id")).toBe(diagnostic.requestId);
  });
});
