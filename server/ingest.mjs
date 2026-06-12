// 收一条上传 → 解析 raw → 按 registry 判 github-vs-local 定 space_key → 落盘 → 写 space.yaml → 串行 commit。
// 客户端只给 remote(host/owner/repo) + folder + branch；身份决策在服务器（core/registry.mjs）。
import { join, relative, dirname } from "node:path";
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { parseSessionText } from "../core/parse.mjs";
import { projectSession } from "../core/project.mjs";
import { buildCard } from "../core/card.mjs";
import { safeSegment } from "../core/safe.mjs";
import { decideSpaceKey } from "../core/registry.mjs";
import { log } from "../core/log.mjs";
import { commit } from "./gitstore.mjs";
import { writeSpaceMeta } from "./space.mjs";

export async function ingest(truthDir, payload, submitter, registry) {
  const { id, raw, remote, folder, branch, tool } = payload;
  if (!id || !raw) throw new Error("missing id/raw");

  const s = parseSessionText(raw, tool);
  const producer = payload.producer || { id: submitter.id, name: submitter.name };
  const pid = producer.id || "unknown";

  // 身份决策：remote 命中 registry → github__owner__repo；否则 local__<producer>（带 folder 标签）。
  const decided = decideSpaceKey(registry, remote, pid);
  const space_key = decided.space_key;
  const folderTag = decided.type === "local" ? (folder || "") : "";

  const branchSafe = (branch || "no-branch").replace(/\//g, "-");
  // 防路径穿越：这几段都来自客户端/远端、直接拼进路径
  safeSegment(space_key, "space_key");
  safeSegment(branchSafe, "branch");
  safeSegment(pid, "producer");
  safeSegment(id, "id");
  const spaceDir = join(truthDir, "spaces", space_key);
  const sessDir = join(spaceDir, "sessions", branchSafe);
  mkdirSync(sessDir, { recursive: true });

  const base = `${pid}-${id}`;                 // producer 前缀 + session-id，唯一/幂等
  const rawAbs = join(sessDir, `${base}.jsonl`);
  const mdAbs = join(sessDir, `${base}.md`);
  const yamlAbs = join(spaceDir, "space.yaml");
  writeFileSync(rawAbs, raw);

  // 正文 = 派生视图（projectSession：脱敏全文 transcript）。与离线重建脚本共用同一投影点。
  const card = buildCard({
    id, tool: tool || "claude-code",
    producer: producer.name, producer_id: pid,
    submitter: submitter.name, submitter_id: submitter.id,
    space_key, ref: decided.ref || "-", branch: branch || "-",
    folder: folderTag || undefined,            // 仅 local session 带 folder 标签
    date: s.ts, updated: s.updated || s.ts, turns: s.turns, raw: `${base}.jsonl`,
  }, projectSession(raw, tool));
  writeFileSync(mdAbs, card);

  // 写/刷新 space.yaml（新 schema §3.4）：type/ref/registered（github）或 type/person（local）。
  writeSpaceMeta(truthDir, space_key, decided);

  // 孤儿清理：同一 session（同 base）若曾落在别的坐标（换分支续写 / local→github 升级），删旧副本，
  // 避免双份（grep 命中两次、元数据新旧并存）。当前 sessDir 里的刚写的那对不动。
  const orphans = pruneOrphans(truthDir, base, sessDir);

  const sha = await commit(truthDir, {
    name: submitter.name, email: submitter.email || `${submitter.id}@team-brain`,
    message: `ingest ${space_key}/${branchSafe}/${base}`,
    // 只提交本次的文件（并发不串台）+ 被删的旧副本（git add 会 stage 删除）
    paths: [...[rawAbs, mdAbs, yamlAbs].map((p) => relative(truthDir, p)), ...orphans],
  });
  log.info("ingest", {
    who: submitter.id, producer: pid, space: space_key, branch: branchSafe,
    tool: tool || "claude-code", turns: s.turns, bytes: Buffer.byteLength(raw),
    commit: sha, pruned: orphans.length,
  });
  return { space_key, branch: branchSafe, file: `${base}.md`, commit: sha, pruned: orphans.length };
}

// 扫 spaces/ 找同 base 的 .jsonl/.md 副本，删掉不在 keepDir 的。返回被删的相对路径（并入 commit）。
// 纯 fs 递归：捕获已提交与未提交副本；session 量级 readdir 很快，真相库大了再上 id→坐标索引。
function pruneOrphans(truthDir, base, keepDir) {
  const removed = [];
  const stack = [join(truthDir, "spaces")];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if ((e.name === `${base}.jsonl` || e.name === `${base}.md`) && dirname(p) !== keepDir) {
        try { unlinkSync(p); removed.push(relative(truthDir, p)); } catch {}
      }
    }
  }
  return removed;
}
