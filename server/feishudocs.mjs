// 飞书文档单向镜像（M4 文档层）：遍历应用可见的 wiki 知识库 → docx 正文拉进真相库
// feishu/<知识库>__<space_id>/<标题>--<node_token>.md（frontmatter + 脱敏正文）。
// 飞书是文档的【权威库】（人在飞书读写），这棵子树只是可重建的检索镜像——
// agent 用现有 grep/find/read 就能搜到文档（tenant token 原生搜索恒 0，自建索引是必须，见 FEISHU_RESEARCH §10）。
// 增量靠节点的 obj_edit_time：没变就不拉正文（raw_content 限流 5/s，全量重拉既慢又撞限流）。
// provider 无关的对账/增量/prune/commit/安全边界都在 ./docsync.mjs；这里只描述"飞书长什么样"。
import { buildCard } from "../core/card.mjs";
import { redactAgent } from "../core/redact.mjs";
import { safeSegment, saniName } from "../core/safe.mjs";
import { listWikiSpaces, walkWikiNodes, docxRawContent } from "../core/feishu.mjs";
import { syncDocs } from "./docsync.mjs";

const fileNameOf = (node) => `${saniName(node.title, "feishu-name")}--${safeSegment(node.node_token, "node_token")}.md`;
const spaceDirOf = (sp) => `${saniName(sp.name, "feishu-name")}__${safeSegment(sp.space_id, "space_id")}`;

// obj_edit_time 是 unix 秒（字符串）→ ISO；取不到给空（frontmatter 空值自动略过；空 edited → 每轮都重拉）。
const isoOf = (t) => { const n = Number(t); return n ? new Date(n * 1000).toISOString() : ""; };

// 一篇文档卡：frontmatter（身份/位置/时间）+ 脱敏正文。edited 同时是增量对账的指纹。
export function renderDoc({ space, node, titlePath, body, wikiBase = "", now = "" }) {
  const url = wikiBase ? `${wikiBase}/wiki/${node.node_token}` : "";
  return buildCard({
    type: "feishu-doc",
    title: node.title || "untitled",
    wiki_space: space.name || "",
    space_id: space.space_id,
    node_token: node.node_token,
    obj_token: node.obj_token,
    obj_type: node.obj_type,
    parent: titlePath.join(" / "),
    edited: isoOf(node.obj_edit_time),
    synced: now,
    url,
  }, redactAgent(body));
}

// 飞书 provider adapter：把"飞书长什么样"喂给通用引擎。
function feishuProvider({ wikiBase = "" } = {}) {
  return {
    subtree: "feishu",
    label: "feishu-docs",
    listCollections: (req) => listWikiSpaces(req),
    collectionDirOf: (sp) => spaceDirOf(sp),
    walkDocs: (req, sp) => walkWikiNodes(req, sp.space_id),   // → [{ node, titlePath }]，titlePath 透传给 renderDoc
    fileNameOf,
    editTimeOf: (node) => isoOf(node.obj_edit_time),
    fetchBody: async (req, node, { sleepFn, pace }) => {
      if (node.obj_type === "docx") { await sleepFn(pace); return docxRawContent(req, node.obj_token); }
      // 非 docx（表格/多维表…）正文不入索引，落一张指针卡指回飞书。
      const url = wikiBase ? `${wikiBase}/wiki/${node.node_token}` : `node_token=${node.node_token}`;
      return `（${node.obj_type} 类型，正文不入索引——去飞书看：${url}）`;
    },
    renderDoc: ({ collection, node, titlePath, body, now }) => renderDoc({ space: collection, node, titlePath, body, wikiBase, now }),
    commitMessage: (written, pruned) => `feishu-docs: 同步 ${written} 篇` + (pruned ? `，清理 ${pruned}` : ""),
  };
}

// 全量对账一轮（飞书）。返回 { collections, written, pruned, skipped, errors, commit }。
export async function syncFeishuDocs(TRUTH, req, opts = {}) {
  return syncDocs(TRUTH, req, feishuProvider({ wikiBase: opts.wikiBase }), opts);
}
