#!/usr/bin/env node
// 一次性迁移：把旧真相库结构迁到 M3 新模型（REDESIGN §6）。
//   · 已登记 github 空间 → 保留，重写 space.yaml 新 schema、删 aliases、删 files/agentdocs
//   · 未登记 github 空间 → 降级：session 并入 local__<producer>（folder=owner/repo），删原空间
//   · 本地碎 space local__人__a__b → 归并到 local__人（folder=a/b，反推与 normalizeFolder 一致），删碎片
//   · team__vault → session 并入 local__<producer>（folder=vault），删
//   · 各处 files/ agentdocs/ → 删
// 用法: node scripts/migrate-m3.mjs --dir <truth> [--registry <registry.yaml>] [--apply]
//       不带 --apply = dry-run（只打印将做什么，不动盘）。--apply 前自动整库备份。
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, cpSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// owner ∈ orgs 或 owner/repo ∈ repos → 该 github 空间已登记
function isRegistered(registry, owner, repo) {
  const reg = registry?.github || {};
  const orgs = (reg.orgs || []).map((o) => (typeof o === "string" ? o : o?.org));
  const repos = (reg.repos || []).map((r) => (typeof r === "string" ? r : (r?.owner && r?.repo ? `${r.owner}/${r.repo}` : null)));
  return orgs.includes(owner) || repos.includes(`${owner}/${repo}`);
}

// 重写卡片 frontmatter 的 space_key（+可选 folder/ref）。其余字段不动。
function rewriteCard(txt, { space_key, folder, ref }) {
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return txt;
  let head = m[1].replace(/^space_key:.*$/m, `space_key: ${space_key}`);
  if (ref) head = head.replace(/^ref:.*$/m, `ref: ${ref}`);   // 仓转移后改 ref（github remap 用）
  if (folder) {
    head = /^folder:/m.test(head) ? head.replace(/^folder:.*$/m, `folder: ${folder}`) : `${head}\nfolder: ${folder}`;
  }
  return txt.replace(/^---\n[\s\S]*?\n---/, `---\n${head}\n---`);
}

const jsonlSize = (p) => { try { return statSync(p).size; } catch { return 0; } };

// 把一对 (base.md / base.jsonl) 落到 destBr。base = <pid>-<session_id> 全局唯一，所以目标已存在同名
// = 同一条 session（仓转移期在新旧两个空间都记过）→ 去重：留 .jsonl 更大的那份（CC/Codex 只增长，大的更全）。
// 返回 "moved" | "deduped"。cardFields = {space_key, folder?, ref?}（.md 重写用）。
function placeSession(bp, base, destBr, cardFields, apply) {
  const dstJsonl = join(destBr, `${base}.jsonl`);
  const collision = existsSync(dstJsonl);
  const keepSrc = !collision || jsonlSize(join(bp, `${base}.jsonl`)) > jsonlSize(dstJsonl);
  if (apply && keepSrc) {
    mkdirSync(destBr, { recursive: true });
    const md = join(bp, `${base}.md`);
    if (existsSync(md)) writeFileSync(join(destBr, `${base}.md`), rewriteCard(readFileSync(md, "utf8"), cardFields));
    const jl = join(bp, `${base}.jsonl`);
    if (existsSync(jl)) { const d = join(destBr, `${base}.jsonl`); if (existsSync(d)) rmSync(d); renameSync(jl, d); }
  }
  return collision ? "deduped" : "moved";
}

const basesIn = (bp) => [...new Set(readdirSync(bp).filter((f) => /\.(md|jsonl)$/.test(f)).map((f) => f.replace(/\.(md|jsonl)$/, "")))];

// 把 oldSpace 的 session 移到 spaces/<destKey>/（merge，去重）。返回去重条数。
function moveSessions(spacesDir, oldName, destKey, { folder = "", ref = "" } = {}, apply, actions) {
  const sd = join(spacesDir, oldName, "sessions");
  if (!isDir(sd)) return 0;
  let deduped = 0;
  for (const br of readdirSync(sd)) {
    const bp = join(sd, br);
    if (!isDir(bp)) continue;
    const destBr = join(spacesDir, destKey, "sessions", br);
    for (const base of basesIn(bp)) {
      const r = placeSession(bp, base, destBr, { space_key: destKey, folder, ref }, apply);
      if (r === "deduped") { deduped++; actions.push(`dedup ${oldName}/sessions/${br}/${base} ↔ ${destKey}（同一 session，留更全的）`); }
      else actions.push(`move ${oldName}/sessions/${br}/${base} → ${destKey}${folder ? ` (folder=${folder})` : ""}`);
    }
  }
  return deduped;
}

// folder 反推：local__person__a__b → person=person, folder=a/b（段已 sani 过，与 normalizeFolder 同形）
function splitLocalKey(name) {
  const parts = name.split("__");           // ["local","person","a","b",...]
  return { person: parts[1], folder: parts.slice(2).join("/") };
}

export function migrate(truthDir, registry, { apply = false } = {}) {
  const spacesDir = join(truthDir, "spaces");
  if (!isDir(spacesDir)) throw new Error(`no spaces/ under ${truthDir}`);
  const actions = [];
  const suspect = [];      // 反推存疑（段含特殊字符，sani 有损 → 可能与新数据对不上）
  const toRemove = [];     // 迁完要删的旧空间目录
  let deduped = 0;         // 仓转移期同一 session 在新旧两空间都记过 → merge 时去重的条数

  // 仓转移映射：registry.moved = [{from:"old/repo", to:"Asklear/repo"}] → 旧空间按现位置改名/并入
  const movedMap = new Map((registry?.moved || []).map((m) => [m.from, m.to]));
  const orgNames = (registry?.github?.orgs || []).map((o) => (typeof o === "string" ? o : o?.org));
  const ghYaml = (owner, repo, viaOrg) =>
    `type: github\nref: github/${owner}/${repo}\nregistered:\n  via: ${viaOrg ? "org" : "repo"}\n${viaOrg ? `  org: ${owner}\n` : ""}`;

  for (const name of readdirSync(spacesDir)) {
    if (name === ".git") continue;
    const dir = join(spacesDir, name);
    if (!isDir(dir)) continue;

    // 各空间都删 files/ 与 agentdocs/
    for (const sub of ["files", "agentdocs"]) {
      const p = join(dir, sub);
      if (existsSync(p)) { actions.push(`delete ${name}/${sub}/`); if (apply) rmSync(p, { recursive: true, force: true }); }
    }

    if (name.startsWith("github__")) {
      let [, owner, repo] = name.split("__");
      const mv = movedMap.get(`${owner}/${repo}`);
      if (mv) [owner, repo] = mv.split("/");          // 仓已转移 → 按现位置（owner/repo）判定+落位
      const registered = isRegistered(registry, owner, repo);
      const viaOrg = orgNames.includes(owner);
      const target = `github__${owner}__${repo}`;
      if (registered && target === name) {
        // 已在正确位置 + 已登记：保留，重写 space.yaml 新 schema（删 aliases）
        actions.push(`keep github ${name} → 重写 space.yaml`);
        if (apply) writeFileSync(join(dir, "space.yaml"), ghYaml(owner, repo, viaOrg));
      } else if (registered) {
        // 仓已转移到已登记位置：session 并入 target（github，重写 space_key+ref），删源
        actions.push(`remap ${name} → ${target}（仓已转移）`);
        deduped += moveSessions(spacesDir, name, target, { ref: `github/${owner}/${repo}` }, apply, actions);
        if (apply) {
          mkdirSync(join(spacesDir, target), { recursive: true });
          writeFileSync(join(spacesDir, target, "space.yaml"), ghYaml(owner, repo, viaOrg));
        }
        toRemove.push(name);
      } else {
        // 未登记（含转移到未登记位置）→ 降级：session 并入 local__<producer>（folder=owner/repo）
        actions.push(`demote github ${name} → local（folder=${owner}/${repo}）`);
        deduped += demoteByProducer(spacesDir, name, `${owner}/${repo}`, apply, actions);
        toRemove.push(name);
      }
    } else if (name === "team__vault") {
      actions.push(`vault ${name} → local（folder=vault）`);
      deduped += demoteByProducer(spacesDir, name, "vault", apply, actions);
      toRemove.push(name);
    } else if (name.startsWith("local__")) {
      const { person, folder } = splitLocalKey(name);
      if (!folder) {
        // 已是 local__person 规范桶：只补 space.yaml
        actions.push(`keep local ${name}`);
        if (apply) writeFileSync(join(dir, "space.yaml"), `type: local\nperson: ${person}\n`);
      } else {
        if (/[^\p{L}\p{N}._/-]/u.test(folder)) suspect.push(`${name} → folder=${folder}`);
        const dest = `local__${person}`;
        actions.push(`merge fragment ${name} → ${dest}（folder=${folder}）`);
        deduped += moveSessions(spacesDir, name, dest, { folder }, apply, actions);
        if (apply) {
          mkdirSync(join(spacesDir, dest), { recursive: true });
          writeFileSync(join(spacesDir, dest, "space.yaml"), `type: local\nperson: ${person}\n`);
        }
        toRemove.push(name);
      }
    }
  }

  // 删空的旧空间
  for (const name of toRemove) {
    actions.push(`remove ${name}/`);
    if (apply) rmSync(join(spacesDir, name), { recursive: true, force: true });
  }

  // 清掉 0 session 的空 local 桶（某人只有文档碎片、没 session 时 merge 会留个空壳）。只看规范桶 local__<person>。
  if (apply) {
    for (const name of readdirSync(spacesDir)) {
      if (!name.startsWith("local__") || name.split("__").length !== 2) continue;
      const sd = join(spacesDir, name, "sessions");
      const hasS = isDir(sd) && readdirSync(sd).some((br) => { try { return readdirSync(join(sd, br)).some((f) => f.endsWith(".md")); } catch { return false; } });
      if (!hasS) { actions.push(`remove empty ${name}/`); rmSync(join(spacesDir, name), { recursive: true, force: true }); }
    }
  }

  if (apply) {
    try {
      execFileSync("git", ["-C", truthDir, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", truthDir, "-c", "user.name=team-brain-bot", "-c", "user.email=bot@team-brain",
        "commit", "-m", "migrate: M3 space 身份重构"], { stdio: "ignore" });
    } catch { /* 没变化或非 git，忽略 */ }
  }
  return { actions, suspect, removed: toRemove, deduped };
}

// 把一个空间的 session 按各自 producer 分别并入 local__<producer>（去重）。返回去重条数。
// producer 一律以该 session 的 .md frontmatter 为准（id 可能含连字符，文件名切不准）；.md/.jsonl 配对同走。
function demoteByProducer(spacesDir, oldName, folder, apply, actions) {
  const sd = join(spacesDir, oldName, "sessions");
  if (!isDir(sd)) return 0;
  let deduped = 0;
  for (const br of readdirSync(sd)) {
    const bp = join(sd, br);
    if (!isDir(bp)) continue;
    for (const base of basesIn(bp)) {
      const mdPath = join(bp, `${base}.md`);
      let producer = base.split("-")[0];                 // 兜底（无 .md 时）
      if (existsSync(mdPath)) {
        const pid = (readFileSync(mdPath, "utf8").match(/^producer_id:\s*(.*)$/m) || [, ""])[1].trim();
        if (pid) producer = pid;
      }
      const dest = `local__${producer}`;
      const r = placeSession(bp, base, join(spacesDir, dest, "sessions", br), { space_key: dest, folder }, apply);
      if (r === "deduped") { deduped++; actions.push(`dedup ${oldName}/sessions/${br}/${base} ↔ ${dest}（同一 session，留更全的）`); }
      else actions.push(`  ${oldName}/sessions/${br}/${base} → ${dest}（folder=${folder}）`);
      if (apply) writeFileSync(join(spacesDir, dest, "space.yaml"), `type: local\nperson: ${producer}\n`);
    }
  }
  return deduped;
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const dir = a[a.indexOf("--dir") + 1];
  const apply = a.includes("--apply");
  if (!dir || a.indexOf("--dir") < 0) { console.error("用法: node scripts/migrate-m3.mjs --dir <truth> [--registry <file>] [--apply]"); process.exit(1); }
  const regPath = a.indexOf("--registry") >= 0 ? a[a.indexOf("--registry") + 1]
    : join(dirname(dirname(fileURLToPath(import.meta.url))), "registry.yaml");
  const registry = existsSync(regPath) ? (parse(readFileSync(regPath, "utf8")) || {}) : { github: { orgs: [], repos: [] } };

  if (apply) {
    const backup = `${dir.replace(/\/$/, "")}-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
    console.error(`[备份] ${dir} → ${backup}`);
    cpSync(dir, backup, { recursive: true });
  }
  const r = migrate(dir, registry, { apply });
  console.log(r.actions.join("\n") || "（无动作）");
  if (r.suspect.length) console.log(`\n⚠️ 反推存疑（含特殊字符，sani 有损，可能与新数据对不上）:\n  ${r.suspect.join("\n  ")}`);
  console.log(`\n${apply ? "✓ 已执行" : "（dry-run，加 --apply 实跑）"}：${r.actions.length} 个动作，删 ${r.removed.length} 个旧空间，去重 ${r.deduped} 条（仓转移期同一 session 在新旧两空间都记过）`);
}
