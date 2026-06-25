// 飞书 API 薄层（服务器侧）：tenant token 由官方 SDK 自动管理，这里只补三件事——
// ① 配置加载（feishu.yaml，缺/坏 → 功能关）② 429/5xx 重试退避（open.feishu.cn 网关实测偶发 502/503）
// ③ wiki 遍历/读正文的分页与递归。API 路径与字段均经真实 PoC 验证（FEISHU_RESEARCH.md §10）。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import * as lark from "@larksuiteoapi/node-sdk";
import { sleep, withRetry } from "./retry.mjs";

export { sleep, withRetry };

// feishu.yaml（服务器级、gitignore、启动加载 restart 生效，同 registry/tokens 一族）。
// 缺文件 / 解析失败 / 没配齐 app 凭证 → 返回 null = 文档层不启用（与 GITHUB_TOKEN 缺省同款行为）。
export function loadFeishu(path) {
  if (!existsSync(path)) return null;
  let cfg;
  try { cfg = parse(readFileSync(path, "utf8")) || {}; } catch { return null; }
  if (!cfg.app_id || !cfg.app_secret) return null;
  return {
    app_id: String(cfg.app_id),
    app_secret: String(cfg.app_secret),
    poll_hours: Number(cfg.poll_hours) || 4,
    wiki_base: String(cfg.wiki_base || "").replace(/\/+$/, ""),   // 租户域名，可选，只用来拼可点的 url
  };
}

// 统一请求口：client.request 自动注入 tenant_access_token；外面包一层重试。
export function makeReq({ app_id, app_secret }, retryOpts = {}) {
  const client = new lark.Client({
    appId: app_id, appSecret: app_secret,
    appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,   // 国内飞书 open.feishu.cn（已定，REDESIGN §3.2）
  });
  return (method, url, o = {}) => withRetry(() => client.request({ method, url, ...o }), retryOpts);
}

// 翻完一个分页端点（items + has_more/page_token 是飞书列表接口的统一形态）。
async function pageAll(req, url, baseParams = {}) {
  const out = [];
  let pageToken = "";
  do {
    const r = await req("GET", url, { params: { page_size: 50, ...baseParams, ...(pageToken ? { page_token: pageToken } : {}) } });
    out.push(...(r?.data?.items || []));
    pageToken = r?.data?.has_more ? (r?.data?.page_token || "") : "";
  } while (pageToken);
  return out;
}

// 应用可见的全部知识库（= 被加为成员/管理员的；tenant token 只能看到授权给应用的，见 FEISHU_RESEARCH §3.4）。
export const listWikiSpaces = (req) => pageAll(req, "/open-apis/wiki/v2/spaces");

// 深度遍历一个知识库的节点树 → [{ node, titlePath }]。
// titlePath = 祖先标题链（不含自己），落盘进 frontmatter 当"在 wiki 里的位置"。
// wiki 里任何节点都可能既有正文又有子树（has_child），所以不论类型都下钻。
export async function walkWikiNodes(req, spaceId, parentToken = "", titlePath = [], out = []) {
  const params = parentToken ? { parent_node_token: parentToken } : {};
  const items = await pageAll(req, `/open-apis/wiki/v2/spaces/${spaceId}/nodes`, params);
  for (const n of items) {
    out.push({ node: n, titlePath });
    if (n.has_child) await walkWikiNodes(req, spaceId, n.node_token, [...titlePath, n.title || ""], out);
  }
  return out;
}

// docx 纯文本正文（喂索引/LLM 最省事的形态；限流 5 次/秒 → 调用方负责 pace）。
export async function docxRawContent(req, objToken) {
  const r = await req("GET", `/open-apis/docx/v1/documents/${objToken}/raw_content`);
  return r?.data?.content || "";
}
