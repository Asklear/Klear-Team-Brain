// Notion 只读 API（REST, 原生 fetch）——单向镜像团队 Notion 页面进真相库，供 grep/read。
// 与 github.mjs 同款：原生 fetch、无 SDK（不给客户端/服务端添依赖）；错误带 .status；429/5xx 退避重试。
// 凭证 = 一个 internal integration token；只有被 share 给该 integration 的页面才可见（见 notion.example.yaml）。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { sleep, withRetry } from "./retry.mjs";

export { sleep, withRetry };

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";   // Notion-Version 请求头，固定一个验证过的版本，别跟着平台默认漂

// notion.yaml（服务器级、gitignore、启动加载 restart 生效，同 feishu/registry/tokens 一族）。
// 缺文件 / 解析失败 / 没配 api_token → 返回 null = Notion 文档层不启用（与 loadFeishu 同款行为）。
export function loadNotion(path) {
  if (!existsSync(path)) return null;
  let cfg;
  try { cfg = parse(readFileSync(path, "utf8")) || {}; } catch { return null; }
  if (!cfg.api_token) return null;
  return {
    api_token: String(cfg.api_token),
    poll_hours: Number(cfg.poll_hours) || 4,
    workspace: String(cfg.workspace || "notion"),   // 真相库 notion/ 下的目录名（Notion API 不给工作区名，自己起）
  };
}

// 统一请求口：注入 token + Notion-Version；非 2xx 抛带 .status 的错误（供 withRetry 判重试，同 github.mjs）。
// GET 不带 body（分页 cursor 走 query）；POST/search 带 JSON body。
export function makeReq({ api_token }, retryOpts = {}) {
  const headers = {
    authorization: `Bearer ${api_token}`,
    "notion-version": VERSION,
    "content-type": "application/json",
    "user-agent": "team-brain",
  };
  return (method, path, body) => withRetry(async () => {
    const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw Object.assign(new Error(`Notion ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
    return r.json();
  }, retryOpts);
}

// POST /search 分页（cursor 在 body）：列出 integration 可见的全部 page。
async function searchAll(req, body) {
  const out = [];
  let cursor;
  do {
    const r = await req("POST", "/search", { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(r?.results || []));
    cursor = r?.has_more ? (r?.next_cursor || null) : null;
  } while (cursor);
  return out;
}
export const searchPages = (req) => searchAll(req, { filter: { value: "page", property: "object" } });

// GET /blocks/{id}/children 分页（cursor 在 query）。
async function childrenAll(req, blockId) {
  const out = [];
  let cursor;
  do {
    const qs = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await req("GET", `/blocks/${blockId}/children${qs}`);
    out.push(...(r?.results || []));
    cursor = r?.has_more ? (r?.next_cursor || null) : null;
  } while (cursor);
  return out;
}

// 从 page 对象取标题：properties 里 type==="title" 的那个，拼 plain_text；取不到兜底 untitled。
export function pageTitle(page) {
  const props = page?.properties || {};
  for (const k of Object.keys(props)) {
    if (props[k]?.type === "title") return (props[k].title || []).map((t) => t.plain_text || "").join("").trim() || "untitled";
  }
  return "untitled";
}

// 一个块的纯文本：任何块类型下的 rich_text 拼接（标题/段落/列表/引用… 字段名都叫 rich_text）。
const blockText = (b) => {
  const rich = b?.[b.type]?.rich_text;
  return Array.isArray(rich) ? rich.map((x) => x.plain_text || "").join("") : "";
};

// 递归取 page/block 的纯文本正文：children 翻页 → 各块拼文本 → 有子块下钻（限深防御）。pace 由调用方按限流给。
export async function pageBlocksText(req, blockId, { sleepFn = sleep, pace = 0, depth = 0 } = {}) {
  if (depth > 8) return "";
  const blocks = await childrenAll(req, blockId);
  const parts = [];
  for (const b of blocks) {
    const line = blockText(b);
    if (line) parts.push(line);
    if (b.has_children) {
      if (pace) await sleepFn(pace);
      const sub = await pageBlocksText(req, b.id, { sleepFn, pace, depth: depth + 1 });
      if (sub) parts.push(sub);
    }
  }
  return parts.join("\n");
}
