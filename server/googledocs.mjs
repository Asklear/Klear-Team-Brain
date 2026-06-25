// Google Docs 文档单向镜像：把 service account 可见的文档拉进真相库 google/<workspace>/<标题>--<id>.md。
// Google Drive 没有"知识库"层级（文档平铺、靠把文档/文件夹 share 给 service account 邮箱授权）→ 用单个
// 合成 collection（workspace）装可见的全部文档。增量靠 Drive 的 modifiedTime（本就是 ISO，直接当 edited 指纹）。
// provider 无关的对账/增量/prune/commit 都在 ./docsync.mjs；这里只描述"Google Docs 长什么样"。
import { buildCard } from "../core/card.mjs";
import { redactAgent } from "../core/redact.mjs";
import { safeSegment, saniName } from "../core/safe.mjs";
import { listDocs, exportDocText } from "../core/google.mjs";
import { syncDocs } from "./docsync.mjs";

const fileNameOf = (node) => `${saniName(node.title, "google-name")}--${safeSegment(node.id, "doc_id")}.md`;

// 一篇文档卡：frontmatter（身份/时间/链接）+ 脱敏正文。edited 同时是增量对账的指纹（modifiedTime 已是 ISO）。
export function renderDoc({ collection, node, body, now = "" }) {
  return buildCard({
    type: "google-doc",
    title: node.title || "untitled",
    workspace: collection?.name || "",
    doc_id: node.id,
    edited: node.modifiedTime || "",
    synced: now,
    url: node.url || "",
  }, redactAgent(body));
}

// Google provider adapter：把"Google Docs 长什么样"喂给通用引擎。
function googleProvider({ workspace = "google" } = {}) {
  return {
    subtree: "google",
    label: "google-docs",
    // 单合成库：一次 list 把可见文档全捞回来挂在 collection 上（walkDocs 直接用，不重复请求）。
    // 可见文档为空 → 返回 []，触发引擎的零库保护（跳过、不删，护住已有镜像）。
    listCollections: async (req) => {
      const docs = await listDocs(req);
      return docs.length ? [{ id: "workspace", name: workspace, docs }] : [];
    },
    collectionDirOf: (c) => saniName(c.name, "google-name"),
    walkDocs: (_req, c) => c.docs.map((d) => ({
      node: { id: d.id, title: d.name, modifiedTime: d.modifiedTime, url: d.webViewLink || `https://docs.google.com/document/d/${d.id}` },
    })),
    fileNameOf,
    editTimeOf: (node) => node.modifiedTime || "",
    fetchBody: async (req, node, { sleepFn, pace }) => {
      if (pace) await sleepFn(pace);   // 进每篇正文前歇一下，避开 Drive 限流
      return exportDocText(req, node.id);
    },
    renderDoc,
    commitMessage: (written, pruned) => `google-docs: 同步 ${written} 篇` + (pruned ? `，清理 ${pruned}` : ""),
  };
}

// 全量对账一轮（Google Docs）。安全边界（零库保护 / 抓取失败不清理 / 路径红线）都在通用引擎里。
export async function syncGoogleDocs(TRUTH, req, opts = {}) {
  return syncDocs(TRUTH, req, googleProvider({ workspace: opts.workspace }), opts);
}
