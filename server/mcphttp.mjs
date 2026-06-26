// 服务器进程内的【HTTP 传输 MCP】端点（POST /mcp）：让任意远程 Agent（别人的 IM bot / 队友的 Cursor /
// 云端 agent）用「URL + Bearer token」即可挂载团队大脑真相库，无需安装我们的客户端。
// 工具定义与 stdio 版【完全共用】mcp/tools.mjs；这里注入 localExec（直接调 query.mjs）。
// 设计：无状态（sessionIdGenerator: undefined）+ JSON 响应（enableJsonResponse）——
//   不在服务器攒会话状态（省那台低内存机器），最贴「bot 一问一答」；多轮上下文是挂载方 agent 自己的事。
//   每个请求新建一对 server+transport、用完即弃，避免并发请求 id 串台。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, INSTRUCTIONS, SERVER_INFO } from "../mcp/tools.mjs";
import { makeLocalExec } from "./mcpexec.mjs";

// 覆写/追加一个请求头——同时改 req.headers 与 req.rawHeaders。必须改 rawHeaders：
// StreamableHTTP transport 经 Hono getRequestListener 从 rawHeaders（而非 headers）重建 Web Request。
function setRaw(req, name, value) {
  req.headers[name] = value;
  const rh = req.rawHeaders;
  for (let i = 0; i < rh.length; i += 2) if (rh[i].toLowerCase() === name) { rh[i + 1] = value; return; }
  rh.push(name, value);
}

// /mcp 入口预处理：让裸 curl / 手写 bot 也能开箱即用。
// SDK 严格要求 Accept 同含 application/json + text/event-stream、Content-Type 为 json，否则 406/415；
// 默认 */*、漏填、或 fetch 自动塞的 text/plain 都会被挡。这里统一钉成规范头（服务器本就是无状态 JSON 响应，
// 且 body 由路由自己 JSON.parse 校验 → 强制 json 无副作用）。返回 false = 非 POST，调用方回 405（GET 的 SSE
// 长流在无状态下永不出数据、白占连接，对低内存机器纯负担）。
export function normalizeMcpRequest(req) {
  if (req.method !== "POST") return false;
  setRaw(req, "accept", "application/json, text/event-stream");
  setRaw(req, "content-type", "application/json");
  return true;
}

export function makeMcpHttpHandler(ctx) {
  const exec = makeLocalExec(ctx);
  // body：POST 时由 server.mjs 预解析好的 JSON-RPC 体；GET/DELETE 传 undefined（无状态下传输自行处理）。
  return async function handleMcp(req, res, body) {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    registerTools(server, exec);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { try { transport.close(); server.close(); } catch {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
