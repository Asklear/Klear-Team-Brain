// Notion 文档单向镜像：把 integration 可见的页面拉进真相库 notion/<workspace>/<标题>--<id>.md。
// Notion 没有"知识库"层级（页面平铺、靠把页面 share 给 integration 来授权）→ 用单个合成 collection（workspace）
// 装可见的全部页面。增量靠 page.last_edited_time（本就是 ISO，直接当 edited 指纹）。
// provider 无关的对账/增量/prune/commit 都在 ./docsync.mjs；这里只描述"Notion 长什么样"。
import { buildCard } from "../core/card.mjs";
import { redactAgent } from "../core/redact.mjs";
import { safeSegment, saniName } from "../core/safe.mjs";
import { searchPages, pageTitle, pageBlocksText } from "../core/notion.mjs";
import { syncDocs } from "./docsync.mjs";

const fileNameOf = (node) => `${saniName(node.title, "notion-name")}--${safeSegment(node.id, "page_id")}.md`;

// 一篇文档卡：frontmatter（身份/时间/链接）+ 脱敏正文。edited 同时是增量对账的指纹（last_edited_time 已是 ISO）。
export function renderDoc({ collection, node, body, now = "" }) {
  return buildCard({
    type: "notion-doc",
    title: node.title || "untitled",
    workspace: collection?.name || "",
    page_id: node.id,
    edited: node.last_edited_time || "",
    synced: now,
    url: node.url || "",   // Notion API 直接给可点 url
  }, redactAgent(body));
}

// Notion provider adapter：把"Notion 长什么样"喂给通用引擎。
function notionProvider({ workspace = "notion" } = {}) {
  return {
    subtree: "notion",
    label: "notion-docs",
    // 单合成库：一次 search 把可见页面全捞回来、挂在 collection 上（walkDocs 直接用，不重复请求）。
    // 可见页面为空 → 返回 []，触发引擎的零库保护（跳过、不删，护住已有镜像）。
    listCollections: async (req) => {
      const pages = await searchPages(req);
      return pages.length ? [{ id: "workspace", name: workspace, pages }] : [];
    },
    collectionDirOf: (c) => saniName(c.name, "notion-name"),
    walkDocs: (_req, c) => c.pages.map((p) => ({
      node: { id: p.id, title: pageTitle(p), last_edited_time: p.last_edited_time, url: p.url },
    })),
    fileNameOf,
    editTimeOf: (node) => node.last_edited_time || "",
    fetchBody: async (req, node, { sleepFn, pace }) => {
      if (pace) await sleepFn(pace);   // 进每页正文前歇一下，避开 Notion ~3 req/s 限流
      return pageBlocksText(req, node.id, { sleepFn, pace });
    },
    renderDoc,
    commitMessage: (written, pruned) => `notion-docs: 同步 ${written} 篇` + (pruned ? `，清理 ${pruned}` : ""),
  };
}

// 全量对账一轮（Notion）。安全边界（零库保护 / 抓取失败不清理 / 路径红线）都在通用引擎里。
export async function syncNotionDocs(TRUTH, req, opts = {}) {
  return syncDocs(TRUTH, req, notionProvider({ workspace: opts.workspace }), opts);
}
