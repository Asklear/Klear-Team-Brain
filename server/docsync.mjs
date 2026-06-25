// 通用文档单向镜像引擎：把任一文档源（飞书 / Notion / …）的 collection→doc 树对账进真相库
// <provider.subtree>/<collectionDir>/<fileName>（frontmatter + 脱敏正文），agent 用现有 grep/find/read 即可搜。
// 【provider 无关】的部分全在这里：增量（按 edited 指纹跳过未变）、孤儿/死库 prune、零库保护、一轮一个 commit。
// 每个源只实现一个 provider adapter（见 feishudocs.mjs / notiondocs.mjs），把"这个源长什么样"喂进来。
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { fm } from "../core/card.mjs";
import { log } from "../core/log.mjs";
import { commit } from "./gitstore.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// provider 接口（全部 provider 无关逻辑都靠这几个钩子参数化）：
//   subtree                       真相库下子树名（"feishu" / "notion"）
//   label                         日志前缀（"feishu-docs" / "notion-docs"）
//   listCollections(req)          → [collection]，源里的"库"（飞书=wiki 知识库，Notion=合成单库）；空/抛错都触发零库保护
//   collectionDirOf(collection)   → dirName，子树下目录名（可 throw → 跳过该库，不影响其它）
//   walkDocs(req, collection)     → [item]，库里全部文档；item.node 是文档对象，item 其余字段透传给 renderDoc（如 titlePath）
//   fileNameOf(node)              → fileName（.md；可 throw → 跳过该文档，路径红线在这兜）
//   editTimeOf(node)              → isoString，增量指纹（与已落盘 frontmatter 的 edited 比；空串 → 每轮都重拉）
//   fetchBody(req, node, { sleepFn, pace }) → body 正文（可 throw → 保留旧镜像、计一次 error）
//   renderDoc({ collection, node, body, now, ...item }) → cardText（buildCard + redactAgent，调用方负责脱敏）
//   commitMessage(written, pruned) → string
export async function syncDocs(TRUTH, req, provider, opts = {}) {
  const { commitFn = commit, pace = 250, sleepFn = sleep, now = () => new Date().toISOString() } = opts;
  const root = join(TRUTH, provider.subtree);

  let collections;
  try { collections = await provider.listCollections(req); }
  catch (e) { log.warn(`[${provider.label}] 列库失败 → 本轮跳过，不清理`, { err: e.message }); return { collections: 0, written: 0, pruned: 0, skipped: 0, errors: 1 }; }
  // 一个库都看不到（多半凭证/授权坏了，不是文档真没了）→ 整轮跳过且不删，护住已有镜像。
  if (!collections.length) {
    log.warn(`[${provider.label}] 一个库都看不到（授权/凭证/scope 坏了？）→ 本轮跳过，不清理`);
    return { collections: 0, written: 0, pruned: 0, skipped: 0, errors: 1 };
  }

  let written = 0, pruned = 0, skipped = 0, errors = 0;
  const liveDirs = new Set();
  for (const collection of collections) {
    let dirName;
    try { dirName = provider.collectionDirOf(collection); }
    catch (e) { errors++; log.warn(`[${provider.label}] 库名/ID 不合法，跳过`, { err: e.message }); continue; }
    liveDirs.add(dirName);
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });

    let docs;
    try { docs = await provider.walkDocs(req, collection); }
    catch (e) { errors++; log.warn(`[${provider.label}] 遍历库失败，跳过（不清理）`, { err: e.message }); continue; }

    // 零文档保护（零库保护的文档级版本）：本轮一篇都没遍历到、但镜像里已有 .md → 多半是遍历异常
    // 返回了空（而非源真清空），跳过该库的写入与 prune，护住已有镜像。代价：源里整库被真删空时，
    // 末次镜像会留存到该库从 listCollections 消失（由上面的库级 prune 兜底清掉）—— 宁可旧、不可误删。
    const existingMd = (() => { try { return readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; } })();
    if (!docs.length && existingMd.length) {
      errors++;
      log.warn(`[${provider.label}] 库「${dirName}」本轮遍历到 0 篇，但镜像已有 ${existingMd.length} 篇 → 跳过，不清理`);
      continue;
    }

    const expect = new Set();
    for (const item of docs) {
      const { node } = item;
      let fname;
      try { fname = provider.fileNameOf(node); }
      catch (e) { errors++; log.warn(`[${provider.label}] 文档名不合法，跳过`, { err: e.message }); continue; }
      expect.add(fname);
      const fpath = join(dir, fname);
      const editedISO = provider.editTimeOf(node);
      // 增量：指纹未变就不拉正文、不重写（飞书 raw_content 限流，Notion 也按 request 计费）。
      if (editedISO && existsSync(fpath) && fm(readFileSync(fpath, "utf8").slice(0, 2048), "edited") === editedISO) { skipped++; continue; }

      let body;
      try { body = await provider.fetchBody(req, node, { sleepFn, pace }); }
      catch (e) { errors++; log.warn(`[${provider.label}] 读正文失败（保留旧镜像）`, { err: e.message }); continue; }
      writeFileSync(fpath, provider.renderDoc({ ...item, collection, body, now: now() }));
      written++;
    }
    // 该库遍历成功 → 树里已不存在的文档，删掉镜像（在源被删/移走）。
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md") && !expect.has(f)) { rmSync(join(dir, f)); pruned++; }
    }
  }
  // 整个库从可见列表消失（被删/取消授权）→ 镜像目录一并清（列表非空才走到这，有零库保护兜底）。
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && !liveDirs.has(d.name)) { rmSync(join(root, d.name), { recursive: true }); pruned++; }
    }
  }

  let sha = null;
  if (written || pruned) {
    sha = await commitFn(TRUTH, {
      name: "team-brain-bot", email: "bot@team-brain",
      message: provider.commitMessage(written, pruned),
      paths: [provider.subtree],
    });
  }
  return { collections: collections.length, written, pruned, skipped, errors, commit: sha };
}
