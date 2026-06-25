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
