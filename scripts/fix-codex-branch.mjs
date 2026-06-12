#!/usr/bin/env node
// 一次性修复：codex session 历史分支归属错误。
// 背景：codex rollout 不像 CC 那样每行记分支，旧版采集回退到「上传时现取 gitBranch(cwd)」，
//   于是同一仓所有 codex session 被错标成上传那刻的当前分支（实测全被打成 main）。
//   但原文 session_meta.payload.git.branch 其实记了 session 时刻的真实分支 —— 据此回填重分桶。
// 做什么（只在同一 space 内重排，不动 space 归属）：
//   · 重读每个 codex .jsonl → 取真实 branch
//   · 文件在错误分支目录 → 把 (.md/.jsonl) 移到正确分支目录、并重写卡片 frontmatter 的 branch 字段
//   · 同名碰撞（极少：同 session 已在目标分支）→ 留 .jsonl 更大的那份
//   · 移完留空的旧分支目录删掉
// 用法: node scripts/fix-codex-branch.mjs --dir <truth> [--apply]
//       不带 --apply = dry-run（只打印，不动盘）。--apply 前自动整库备份。
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, cpSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseSessionText, detectTool } from "../core/parse.mjs";
import { safeSegment } from "../core/safe.mjs";

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const size = (p) => { try { return statSync(p).size; } catch { return 0; } };
const basesIn = (bp) => [...new Set(readdirSync(bp).filter((f) => /\.(md|jsonl)$/.test(f)).map((f) => f.replace(/\.(md|jsonl)$/, "")))];

// 与 ingest 落盘一致：分支安全段 = 斜杠转连字符，空则 no-branch。
const branchDir = (branch) => safeSegment((branch || "no-branch").replace(/\//g, "-"), "branch");

// 重写卡片 frontmatter 的 branch 字段（其余不动）。无该字段则补上。
function rewriteCardBranch(txt, branch) {
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return txt;
  const head = /^branch:/m.test(m[1])
    ? m[1].replace(/^branch:.*$/m, `branch: ${branch}`)
    : `${m[1]}\nbranch: ${branch}`;
  return txt.replace(/^---\n[\s\S]*?\n---/, `---\n${head}\n---`);
}

export function fixCodexBranch(truthDir, { apply = false } = {}) {
  const spacesDir = join(truthDir, "spaces");
  if (!isDir(spacesDir)) throw new Error(`no spaces/ under ${truthDir}`);
  const actions = [];
  const skipped = [];          // 无 git 块、分支不可恢复的旧 rollout（保持原样）
  let moved = 0, deduped = 0;

  for (const space of readdirSync(spacesDir)) {
    const sd = join(spacesDir, space, "sessions");
    if (!isDir(sd)) continue;
    for (const br of readdirSync(sd)) {
      const bp = join(sd, br);
      if (!isDir(bp)) continue;
      for (const base of basesIn(bp)) {
        const jl = join(bp, `${base}.jsonl`);
        if (!existsSync(jl)) continue;
        const raw = readFileSync(jl, "utf8");
        if (detectTool(raw) !== "codex") continue;            // CC session 每行记分支，已正确 → 跳过
        const { branch } = parseSessionText(raw, "codex");
        if (!branch) { skipped.push(`${space}/${br}/${base}（原文无 git 块，分支不可恢复）`); continue; }
        const destName = branchDir(branch);
        if (destName === br) continue;                        // 已在正确分支目录

        const destBr = join(sd, destName);
        const dstJsonl = join(destBr, `${base}.jsonl`);
        const collision = existsSync(dstJsonl);
        // 碰撞 = 同一 session 已在目标分支（base 全局唯一）→ 留 .jsonl 更大（更全）的那份
        const keepSrc = !collision || size(jl) > size(dstJsonl);
        if (collision) { deduped++; actions.push(`dedup ${space}/${br}/${base} ↔ ${destName}（同一 session，留更全的）`); }
        else { moved++; actions.push(`move ${space}/${br}/${base} → ${destName}（真实分支 ${branch}）`); }

        if (apply && keepSrc) {
          mkdirSync(destBr, { recursive: true });
          const md = join(bp, `${base}.md`);
          if (existsSync(md)) {
            writeFileSync(join(destBr, `${base}.md`), rewriteCardBranch(readFileSync(md, "utf8"), branch));
            rmSync(md);
          }
          if (existsSync(dstJsonl)) rmSync(dstJsonl);
          renameSync(jl, dstJsonl);
        } else if (apply && collision) {
          // 目标更全 → 丢弃源这份（去重）
          const md = join(bp, `${base}.md`);
          if (existsSync(md)) rmSync(md);
          rmSync(jl);
        }
      }
    }
    // 清掉移空了的分支目录
    if (apply) for (const br of readdirSync(sd)) {
      const bp = join(sd, br);
      if (isDir(bp) && readdirSync(bp).length === 0) { actions.push(`remove empty ${space}/${br}/`); rmSync(bp, { recursive: true, force: true }); }
    }
  }

  if (apply) {
    try {
      execFileSync("git", ["-C", truthDir, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", truthDir, "-c", "user.name=team-brain-bot", "-c", "user.email=bot@team-brain",
        "commit", "-m", "fix: codex session 按原文真实分支回填重分桶"], { stdio: "ignore" });
    } catch { /* 没变化或非 git，忽略 */ }
  }
  return { actions, skipped, moved, deduped };
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const dir = a[a.indexOf("--dir") + 1];
  const apply = a.includes("--apply");
  if (!dir || a.indexOf("--dir") < 0) { console.error("用法: node scripts/fix-codex-branch.mjs --dir <truth> [--apply]"); process.exit(1); }

  if (apply) {
    const backup = `${dir.replace(/\/$/, "")}-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
    console.error(`[备份] ${dir} → ${backup}`);
    cpSync(dir, backup, { recursive: true });
  }
  const r = fixCodexBranch(dir, { apply });
  console.log(r.actions.join("\n") || "（无动作）");
  if (r.skipped.length) console.log(`\n⚠️ 分支不可恢复（原文无 git 块，保持原样）:\n  ${r.skipped.join("\n  ")}`);
  console.log(`\n${apply ? "✓ 已执行" : "（dry-run，加 --apply 实跑）"}：移动 ${r.moved} 条、去重 ${r.deduped} 条`);
}
