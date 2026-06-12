// 飞书文档单向镜像（M4 文档层）：遍历应用可见的 wiki 知识库 → docx 正文拉进真相库
// feishu/<知识库>__<space_id>/<标题>--<node_token>.md（frontmatter + 脱敏正文）。
// 飞书是文档的【权威库】（人在飞书读写），这棵子树只是可重建的检索镜像——
// agent 用现有 grep/find/read 就能搜到文档（tenant token 原生搜索恒 0，自建索引是必须，见 FEISHU_RESEARCH §10）。
// 增量靠节点的 obj_edit_time：没变就不拉正文（raw_content 限流 5/s，全量重拉既慢又撞限流）。
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { buildCard, fm } from "../core/card.mjs";
import { redactAgent } from "../core/redact.mjs";
import { safeSegment } from "../core/safe.mjs";
import { log } from "../core/log.mjs";
import { commit } from "./gitstore.mjs";
import { listWikiSpaces, walkWikiNodes, docxRawContent, sleep } from "../core/feishu.mjs";

// 飞书标题/库名要进文件名：去掉路径分隔与控制符、压空白、截短；空标题兜底。
// 之后仍过 safeSegment（穿越红线，别绕开）。
const saniName = (s) =>
  safeSegment((String(s || "").replace(/[/\\\0]/g, "-").replace(/\s+/g, " ").trim() || "untitled").slice(0, 80), "feishu-name");

const fileNameOf = (node) => `${saniName(node.title)}--${safeSegment(node.node_token, "node_token")}.md`;
const spaceDirOf = (sp) => `${saniName(sp.name)}__${safeSegment(sp.space_id, "space_id")}`;

// obj_edit_time 是 unix 秒（字符串）→ ISO；取不到给空（frontmatter 空值自动略过）。
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

// 全量对账一轮：写有变化的、清理已消失的、其余跳过。一轮一个 commit。
// 安全边界：① 只有【该库遍历成功】才清它的孤儿（API 抖一下不能误删整库镜像）；
// ② 知识库列表为空直接整轮跳过（多半是授权/凭证坏了，不是文档真没了）。
export async function syncFeishuDocs(TRUTH, req, opts = {}) {
  const { wikiBase = "", commitFn = commit, pace = 250, sleepFn = sleep, now = () => new Date().toISOString() } = opts;
  const root = join(TRUTH, "feishu");
  const spaces = await listWikiSpaces(req);
  if (!spaces.length) {
    log.warn("[feishu-docs] 一个知识库都看不到（应用没被加进任何知识库，或凭证/scope 坏了）→ 本轮跳过，不清理");
    return { spaces: 0, written: 0, pruned: 0, skipped: 0, errors: 1 };
  }

  let written = 0, pruned = 0, skipped = 0, errors = 0;
  const liveDirs = new Set();
  for (const sp of spaces) {
    let dirName;
    try { dirName = spaceDirOf(sp); } catch (e) { errors++; log.warn("[feishu-docs] 知识库名/ID 不合法，跳过", { space: sp?.space_id, err: e.message }); continue; }
    liveDirs.add(dirName);
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });

    let nodes;
    try { nodes = await walkWikiNodes(req, sp.space_id); }
    catch (e) { errors++; log.warn("[feishu-docs] 遍历知识库失败，跳过（不清理）", { space: sp.name, err: e.message }); continue; }

    const expect = new Set();
    for (const { node, titlePath } of nodes) {
      let fname;
      try { fname = fileNameOf(node); } catch (e) { errors++; log.warn("[feishu-docs] 节点名不合法，跳过", { title: node?.title, err: e.message }); continue; }
      expect.add(fname);
      const fpath = join(dir, fname);
      const editedISO = isoOf(node.obj_edit_time);
      if (existsSync(fpath) && fm(readFileSync(fpath, "utf8").slice(0, 2048), "edited") === editedISO) { skipped++; continue; }

      let body;
      if (node.obj_type === "docx") {
        try { await sleepFn(pace); body = await docxRawContent(req, node.obj_token); }
        catch (e) { errors++; log.warn("[feishu-docs] 读正文失败（保留旧镜像）", { title: node.title, err: e.message }); continue; }
      } else {
        const url = wikiBase ? `${wikiBase}/wiki/${node.node_token}` : `node_token=${node.node_token}`;
        body = `（${node.obj_type} 类型，正文不入索引——去飞书看：${url}）`;
      }
      writeFileSync(fpath, renderDoc({ space: sp, node, titlePath, body, wikiBase, now: now() }));
      written++;
    }
    // 该库遍历成功 → 树里已不存在的节点，删掉镜像（文档在飞书被删/移走）
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md") && !expect.has(f)) { rmSync(join(dir, f)); pruned++; }
    }
  }
  // 整个知识库从可见列表消失（被删/取消授权）→ 镜像目录一并清（列表非空才走到这，有零库保护）
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && !liveDirs.has(d.name)) { rmSync(join(root, d.name), { recursive: true }); pruned++; }
    }
  }

  let sha = null;
  if (written || pruned) {
    sha = await commitFn(TRUTH, {
      name: "team-brain-bot", email: "bot@team-brain",
      message: `feishu-docs: 同步 ${written} 篇` + (pruned ? `，清理 ${pruned}` : ""),
      paths: ["feishu"],
    });
  }
  return { spaces: spaces.length, written, pruned, skipped, errors, commit: sha };
}
