#!/usr/bin/env node
// 问 Agent 内核（stdio 传输）：跑在【用户机器】上，后端指向团队大脑服务器。
// 理念：把线上真相库当一个【只读文件夹】暴露给本地 Agent，用 Unix 式原语自由探索——
// grep(搜内容) / find(找文件) / read(读全文) / ls(看结构) / log(看历史) + read_github(出网看代码)。
// 工具的 schema/描述/格式化/INSTRUCTIONS 全在 mcp/tools.mjs（唯一真相源，与服务器内的 HTTP MCP 共用）；
// 这里只提供 remoteExec —— 把每个原语映射成一次 api() fetch（含跨境重试）。零服务器 LLM。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { CLIENT_VERSION } from "../core/version.mjs";
import { registerTools, INSTRUCTIONS, SERVER_INFO } from "./tools.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = parse(readFileSync(join(ROOT, "client.config.yaml"), "utf8"));
const HDRS = { authorization: `Bearer ${cfg.token}`, "x-client-version": CLIENT_VERSION };

// 跨境链路（电信国际出口→日本→阿里云海外）约 13% 的请求 TLS 握手丢包卡死。
// 对策：每次尝试设超时（卡住的握手快速失败，别拖死整个 MCP 调用），网络错误自动重试带退避。
// HTTP 状态错误（4xx/5xx 已到服务器）不重试——那是真错，重发也一样。
// 健康握手<1s、最慢实测 3.1s → 6s 超时足够，又能让卡死的尝试尽快败掉进重试。
// 3 次重试能救瞬时卡顿（绝大多数 fetch failed）；几十秒级的持续黑窗救不了——
// 那时快速败掉（最坏 ~27s）远好过干等一分钟，根治要靠服务器侧加跨境加速（见下）。
const ATTEMPT_TIMEOUT_MS = 6_000;
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, params) {
  const u = new URL(cfg.server_url + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt) await sleep(Math.min(400 * 2 ** (attempt - 1), 2_000)); // 退避 400/800/1600ms
    try {
      const r = await fetch(u, { headers: HDRS, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!r.ok) throw new HttpError(`${path} → ${r.status} ${await r.text()}`);
      return await r.json();
    } catch (e) {
      if (e instanceof HttpError) throw e; // 服务器已响应的真错：不重试
      lastErr = e; // 网络层（TLS 握手卡死 / 超时 / 连接重置）：可重试
    }
  }
  throw new Error(`${path} → 网络不稳，重试 ${MAX_RETRIES} 次仍失败（跨境链路丢包）：${lastErr?.message || lastErr}`);
}
class HttpError extends Error {}

// remoteExec：每个只读原语 = 一次 REST 调用，返回值与对应端点同形（tools.mjs 负责格式化）。
const remoteExec = {
  grep: ({ q, space, context, raw }) => api("/grep", { q, space, context, raw: raw ? 1 : undefined }),
  find: ({ name, path, limit }) => api("/find", { name, path, limit }),
  read: ({ path, offset, limit }) => api("/read", { path, offset, limit }),
  ls: ({ path }) => api("/ls", { path }),   // 默认值在 tools.mjs 的 ls handler 统一兜（这里只透传）
  log: ({ space, author, since, grep, limit }) => api("/log", { space, author, since, grep, limit }),
  sessions: ({ author, space, since, until, limit }) => api("/sessions", { author, space, since, until, limit }),
  stats: ({ by, split, metric, since, until, space, author, tool, limit, offset }) =>
    api("/stats", { by, split, metric, since, until, space, author, tool, limit, offset }),
  github: ({ space_key, path, ref }) => api("/github", { space_key, path, ref }),
};

const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
registerTools(server, remoteExec);

await server.connect(new StdioServerTransport());
console.error("team-brain MCP (stdio) 已启动：grep + find + read + ls + sessions + stats + log + read_github（含 feishu/·notion/·google/ 文档镜像）→", cfg.server_url);
