#!/usr/bin/env node
// 一次性存量脱敏：把真相库里已入库 session 的 .jsonl 原文里的密钥/token 就地抹成占位符。
// 背景：上传前脱敏（slimRaw 末段的 redactJsonl）是后加的；在它之前入库的 .jsonl 仍含明文密钥
//   （派生 .md 一直经 redactAgent 脱敏，但 .jsonl 原文没有 → git clone 真相库即见明文）。
// 为什么不复用 slim-existing：它的体积闸「slim ≥ 原始就跳过」会漏掉「redact 后没变小」的文件
//   （slimRaw 的 JSON re-stringify 抵消了 redact 的字节节省）→ 残留密钥。本脚本直接对 .jsonl 跑 redactJsonl
//   （纯文本替换、只缩不涨），**只要内容变了就写**、不看体积，确保无残留；幂等（已脱敏的再跑 = 不变）。
// 做什么：只动 .jsonl 原文；派生 .md 跑完接着用 `rebuild-cards --apply` 从洗净的 .jsonl 重建。
// 注意：跑前停服（避免和在线 ingest 抢 git index）。只缩工作区，旧明文仍在 .git 历史 → 要清得另做历史重写。
// 用法: node scripts/redact-existing.mjs --dir <truth> [--apply]
//       不带 --apply = dry-run。
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { redactJsonl } from "../core/redact.mjs";

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// 递归收集 spaces 下所有 .jsonl
function jsonlFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function redactExisting(truthDir, { apply = false } = {}) {
  const spacesDir = join(truthDir, "spaces");
  if (!isDir(spacesDir)) throw new Error(`no spaces/ under ${truthDir}`);
  const changed = [];
  for (const f of jsonlFiles(spacesDir)) {
    const raw = readFileSync(f, "utf8");
    const red = redactJsonl(raw);
    if (red === raw) continue;                       // 没密钥 / 已脱敏 → 不动（幂等）
    changed.push(f.slice(truthDir.length + 1));
    if (apply) writeFileSync(f, red);
  }
  if (apply && changed.length) {
    execFileSync("git", ["-C", truthDir, "add", ...changed], { stdio: "ignore" });
    execFileSync("git", ["-C", truthDir, "-c", "user.name=team-brain-bot", "-c", "user.email=bot@team-brain",
      "commit", "-m", "redact: 存量 session .jsonl 脱敏（抹密钥/token）"], { stdio: "ignore" });
  }
  return { changed };
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const di = a.indexOf("--dir");
  const dir = di >= 0 ? a[di + 1] : null;
  const apply = a.includes("--apply");
  if (!dir) { console.error("用法: node scripts/redact-existing.mjs --dir <truth> [--apply]"); process.exit(1); }
  const r = redactExisting(dir, { apply });
  console.log(r.changed.map((c) => `redact ${c}`).join("\n") || "（无需脱敏的文件）");
  console.log(`\n${apply ? "✓ 已执行" : "（dry-run，加 --apply 实跑）"}：脱敏 ${r.changed.length} 个 .jsonl`);
}
