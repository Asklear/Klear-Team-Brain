#!/usr/bin/env node
// 一次性存量迁移：把旧「摘要卡片」.md（意图+结论）重建成「脱敏全文 transcript」.md。
// 保留旧 .md 的 frontmatter（元数据/space 决策结果不变），只换正文。幂等、可重复跑。
// 用法：node scripts/rebuild-cards.mjs [--dir <truthDir>]          # dry-run（只报告）
//       node scripts/rebuild-cards.mjs [--dir <truthDir>] --apply  # 实写
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSession } from "../core/project.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const di = args.indexOf("--dir");
const TRUTH = (di >= 0 && args[di + 1]) || process.env.TRUTH_DIR || join(ROOT, "truth-server");

function* walkJsonl(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const splitFm = (txt) => {
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: m[1], rest: txt.slice(m[0].length) } : null;
};

let changed = 0, same = 0, skipped = 0;
for (const jsonl of walkJsonl(join(TRUTH, "spaces"))) {
  const mdPath = jsonl.replace(/\.jsonl$/, ".md");
  const rel = relative(TRUTH, mdPath);
  if (!existsSync(mdPath)) { console.warn("跳过（无配对 .md）:", rel); skipped++; continue; }
  const parts = splitFm(readFileSync(mdPath, "utf8"));
  if (!parts) { console.warn("跳过（.md 无 frontmatter）:", rel); skipped++; continue; }
  const body = projectSession(readFileSync(jsonl, "utf8"));
  const next = `---\n${parts.fm}\n---\n${body || "（无可读对话）"}\n`;
  if (next === `---\n${parts.fm}\n---\n${parts.rest}`.replace(/\n*$/, "\n")) { same++; continue; }
  changed++;
  console.log((apply ? "重建 " : "将重建 ") + rel);
  if (apply) writeFileSync(mdPath, next);
}
console.log(`\n共 改 ${changed} · 不变 ${same} · 跳过 ${skipped}  —  ${apply ? "已写入" : "dry-run（加 --apply 实写）"}`);
if (apply && changed) console.log(`提示：进 ${TRUTH} 自行 git add -A && git commit，把重建结果落进真相库历史`);
