#!/usr/bin/env node
// 一次性存量蒸馏：把真相库里 slim 上线前入库的「肥」session jsonl 就地瘦身。
// 背景：slim（core/slim.mjs）是后加的上传前蒸馏；在它之前入库的 session 仍是原始 jsonl，
//   含内联图片 base64 / 巨型 tool 输出（实测真相库 577MB jsonl，大头是这些）。语料噪声大、grep 被污染、占盘。
// 做什么：
//   · 只动**真有 bloat 的文件**（含 data:image / 长 base64 / 有行 >48KB）——其余文件**字节不动**，
//     避免 slimRaw 内部 JSON re-stringify 把干净文件也改一遍（无意义 churn）。瘦身后不再触发检测 → 幂等。
//   · **不碰 .md**：slim 只剥图/截超长字段，intent/结论是短字段、原样保留 → 现有卡片仍正确。
//   · 永不让文件变大（slim ≥ 原始就跳过，安全网）。
// 注意：① 跑前**停服**（避免和在线 ingest 抢 git index）；② 只缩工作区，旧大 blob 仍在 .git 历史，
//   要真正回收磁盘得另做 git 历史重写（本脚本不做）。
// 用法: node scripts/slim-existing.mjs --dir <truth> [--apply]
//       不带 --apply = dry-run。--apply 前自动整库备份。建议 --max-old-space-size=1024 起跑（大文件）。
import { readdirSync, readFileSync, writeFileSync, statSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { slimRaw } from "../core/slim.mjs";

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

export function slimExisting(truthDir, { apply = false } = {}) {
  const spacesDir = join(truthDir, "spaces");
  if (!isDir(spacesDir)) throw new Error(`no spaces/ under ${truthDir}`);
  const actions = [];
  const changed = [];
  let beforeBytes = 0, afterBytes = 0;

  for (const f of jsonlFiles(spacesDir)) {
    const raw = readFileSync(f, "utf8");
    const slim = slimRaw(raw);                     // 对每个文件都跑（v2 的丢/截藏在 <48KB 行里，没法靠廉价预筛判定）
    if (slim.length >= raw.length) continue;       // 没变小 → 不写（干净文件 slimRaw 后字节不变 → 保持原样、幂等）
    beforeBytes += raw.length; afterBytes += slim.length;
    const rel = f.slice(truthDir.length + 1);
    actions.push(`slim ${(raw.length / 1048576).toFixed(1)}MB → ${(slim.length / 1024).toFixed(0)}KB  ${rel}`);
    changed.push(rel);
    if (apply) writeFileSync(f, slim);
  }

  if (apply && changed.length) {
    execFileSync("git", ["-C", truthDir, "add", ...changed], { stdio: "ignore" });
    execFileSync("git", ["-C", truthDir, "-c", "user.name=team-brain-bot", "-c", "user.email=bot@team-brain",
      "commit", "-m", "slim: 蒸馏存量 session（剥图片/截巨型输出，卡片不变）"], { stdio: "ignore" });
  }
  return { actions, changed, beforeBytes, afterBytes };
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const dir = a[a.indexOf("--dir") + 1];
  const apply = a.includes("--apply");
  if (!dir || a.indexOf("--dir") < 0) { console.error("用法: node scripts/slim-existing.mjs --dir <truth> [--apply]"); process.exit(1); }

  if (apply) {
    const backup = `${dir.replace(/\/$/, "")}-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
    console.error(`[备份] ${dir} → ${backup}`);
    cpSync(dir, backup, { recursive: true });
  }
  const r = slimExisting(dir, { apply });
  console.log(r.actions.join("\n") || "（无需蒸馏的文件）");
  const mb = (n) => (n / 1048576).toFixed(0) + "MB";
  console.log(`\n${apply ? "✓ 已执行" : "（dry-run，加 --apply 实跑）"}：蒸馏 ${r.changed.length} 个文件，${mb(r.beforeBytes)} → ${mb(r.afterBytes)}`);
}
