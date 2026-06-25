// HTTP 传输的 MCP 端点：起一个最小 http server 包住 makeMcpHttpHandler，用真 MCP 客户端
// （StreamableHTTPClientTransport）跑通 initialize → tools/list → 调 grep/read/ls。
// 验证「与 stdio 共用的工具集 + localExec 直连 query.mjs」整条链路在 HTTP 下成立。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeMcpHttpHandler } from "../server/mcphttp.mjs";

// 临时 git 真相库：铺两条带 frontmatter 的 session 卡片（grep/read 要能命中正文）。
function gitTruth() {
  const dir = mkdtempSync(join(tmpdir(), "tb-mcphttp-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  const card = (body) => `---\nproducer_id: user2\nsubmitter: username2\nspace_key: github__o__r\nbranch: main\ndate: 2026-06-20T10:00:00+08:00\nupdated: 2026-06-20T11:00:00+08:00\ntool: claude-code\n---\n\n${body}\n`;
  const files = {
    "spaces/github__o__r/sessions/main/user2-s1.md": card("讨论了 ontology 重构方案，决定先做 schema 迁移。"),
    "spaces/github__o__r/sessions/main/user2-s2.md": card("另一条 session：修了登录 bug。"),
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"]);
  return dir;
}

// 起服务：最小包装，模仿 server.mjs 里 /mcp 路由对 body 的预解析（POST → JSON.parse）。
async function startServer(TRUTH) {
  const handler = makeMcpHttpHandler({
    TRUTH, registry: {}, roster: { members: [] }, githubToken: "",
    resolvePath: (p) => p || "", resolveSpace: (k) => k,
  });
  const server = http.createServer(async (req, res) => {
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
    }
    handler(req, res, body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

// 每个用例的脚手架完全一致（起仓+起服务+连客户端+收尾）→ 收进一个 withClient 包装。
async function withClient(fn) {
  const { server, url } = await startServer(gitTruth());
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  try { return await fn(client); } finally { await client.close(); server.close(); }
}
const textOf = (r) => (r.content || []).map((c) => c.text).join("\n");

test("HTTP MCP: tools/list 暴露全部 8 个只读原语", () => withClient(async (client) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["find", "grep", "log", "ls", "read", "read_github", "sessions", "stats"]);
}));

test("HTTP MCP: grep 命中正文并返回 path", () => withClient(async (client) => {
  const text = textOf(await client.callTool({ name: "grep", arguments: { q: "ontology" } }));
  assert.match(text, /ontology/);
  assert.match(text, /spaces\/github__o__r\/sessions\/main\/user2-s1\.md/);
}));

test("HTTP MCP: read 按 path 读全文", () => withClient(async (client) => {
  const r = await client.callTool({ name: "read", arguments: { path: "spaces/github__o__r/sessions/main/user2-s2.md" } });
  assert.match(textOf(r), /修了登录 bug/);
}));

test("HTTP MCP: ls 顶层列出 space", () => withClient(async (client) => {
  const r = await client.callTool({ name: "ls", arguments: { path: "spaces" } });
  assert.match(textOf(r), /github__o__r/);
}));

test("HTTP MCP: sessions 按人查命中工作时间", () => withClient(async (client) => {
  const text = textOf(await client.callTool({ name: "sessions", arguments: { author: "user2" } }));
  assert.match(text, /user2/);
  assert.match(text, /2026-06-20/);
}));
