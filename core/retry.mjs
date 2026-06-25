// 共享重试退避：429（限流）与 5xx（网关偶发）值得等一等再试；4xx 业务错误（权限/不存在）重试无意义直接抛。
// status 取不到（网络层断连）也按可重试算。错误形状两种都认：原生 fetch 抛的 e.status / SDK 抛的 e.response.status。
// 文档源各 provider（feishu/notion/google）共用——退避策略只此一处，改一处全改。
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function withRetry(fn, { delays = [1000, 3000, 10000], sleepFn = sleep } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const status = e?.status ?? e?.response?.status ?? 0;
      if (i >= delays.length || (status !== 0 && !RETRYABLE.has(status))) throw e;
      await sleepFn(delays[i]);
    }
  }
}
