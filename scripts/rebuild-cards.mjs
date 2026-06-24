#!/usr/bin/env node
// 一次性存量迁移：把旧「摘要卡片」.md（意图+结论）重建成「脱敏全文 transcript」.md。
// 保留旧 .md 的 frontmatter（元数据/space 决策结果不变），只换正文 + 回填 token 用量（tokens_*）+ 按天明细（days）。
// token 回填：从 .jsonl 重算用量 upsert 进 frontmatter——CC 历史能补回；Codex 老 raw 早被 slim 丢了 token_count → 无（保持未知）。
// days 回填：跨天 session 按天拆统计的依据——CC 的 turns/token 都能精确分天；Codex 的 turns 能分天、token 仍只记开始日。
// 幂等、可重复跑。
// 用法：node scripts/rebuild-cards.mjs [--dir <truthDir>]          # dry-run（只报告）
//       node scripts/rebuild-cards.mjs [--dir <truthDir>] --apply  # 实写
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSession } from "../core/project.mjs";
import { parseSessionText } from "../core/parse.mjs";
import { usageFields, daysFields } from "../core/card.mjs";

// 把若干字段 upsert 进 frontmatter 文本：只动 fieldsObj 里【确有新值】的键（删旧同名行 + 追加新值）。
// 关键：fieldsObj 为空（这趟从 raw 算不出用量/按天，如老 Codex raw 早被 slim 丢了 token_count）→ 原样返回、
// 不删任何旧行。否则「重跑 = 把上次能算、这次算不出的字段清空」，幂等就成了破坏性降级。
function upsertFields(fm, fieldsObj) {
  const keys = Object.keys(fieldsObj);
  if (!keys.length) return fm;
  const kept = fm.split("\n").filter((l) => !keys.some((k) => l.startsWith(`${k}:`)));
  const add = keys.map((k) => `${k}: ${fieldsObj[k]}`);
  return [...kept, ...add].join("\n");
}

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
  const raw = readFileSync(jsonl, "utf8");
  const s = parseSessionText(raw);
  const body = projectSession(raw);
  let fm = upsertFields(parts.fm, usageFields(s.usage));        // 回填 token 用量（CC 可补、Codex 老 raw 无则不动旧值）
  fm = upsertFields(fm, daysFields(s.days, s.tokensDaily));     // 回填按天明细（跨天 session 按天拆的依据）
  const next = `---\n${fm}\n---\n${body || "（无可读对话）"}\n`;
  if (next === `---\n${parts.fm}\n---\n${parts.rest}`.replace(/\n*$/, "\n")) { same++; continue; }
  changed++;
  console.log((apply ? "重建 " : "将重建 ") + rel);
  if (apply) writeFileSync(mdPath, next);
}
console.log(`\n共 改 ${changed} · 不变 ${same} · 跳过 ${skipped}  —  ${apply ? "已写入" : "dry-run（加 --apply 实写）"}`);
if (apply && changed) console.log(`提示：进 ${TRUTH} 自行 git add -A && git commit，把重建结果落进真相库历史`);
