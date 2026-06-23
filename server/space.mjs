// space.yaml 读写（每个 space 一份元数据）。schema 见 REDESIGN.md §3.4：
//   团队仓: type(=provider)/ref/provider/host/[base_url]/owner/repo/registered + 缓存(default_branch/visibility)
//   local : type/person
// 权威字段来自 registry/ingest；缓存字段由 code-state 轮询刷新（可重建）。
// provider/host/owner/repo 显式存盘 —— 因为 space_key 对 gitlab 子组是 lossy（/→-），不能反推真值。
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fm } from "../core/card.mjs";
import { ownerRepoFromRef } from "../core/github.mjs";

function readRegistered(txt) {
  const via = (txt.match(/^\s+via:\s*(.*)$/m) || [, ""])[1].trim();
  const org = (txt.match(/^\s+org:\s*(.*)$/m) || [, ""])[1].trim();
  return via ? { via, ...(org ? { org } : {}) } : {};
}

export function readSpaceMeta(truthDir, spaceKey) {
  const p = join(truthDir, "spaces", spaceKey, "space.yaml");
  if (!existsSync(p)) return { type: "", ref: "", person: "", provider: "", host: "", base_url: "", owner: "", repo: "", default_branch: "", visibility: "", registered: {} };
  const txt = readFileSync(p, "utf8");
  const type = fm(txt, "type");
  const ref = fm(txt, "ref");
  // 向后兼容：老 github 空间没存 provider/host/owner/repo，从 type+ref 兜底归一。
  let provider = fm(txt, "provider"), host = fm(txt, "host"), owner = fm(txt, "owner"), repo = fm(txt, "repo");
  if (!provider && type && type !== "local") {
    provider = type;                                   // 老空间 type 即 provider（github）
    if (provider === "github") { host = host || "github.com"; const or = ownerRepoFromRef(ref); if (or) { owner = owner || or.owner; repo = repo || or.repo; } }
  }
  return {
    type, ref, provider, host,
    base_url: fm(txt, "base_url"),
    owner, repo,
    person: fm(txt, "person"),
    default_branch: fm(txt, "default_branch"),
    visibility: fm(txt, "visibility"),
    registered: readRegistered(txt),
  };
}

function render(meta) {
  if (meta.type === "local") return `type: local\nperson: ${meta.person || "-"}\n`;
  let s = `type: ${meta.type || "github"}\nref: ${meta.ref || "-"}\n`;
  if (meta.provider) s += `provider: ${meta.provider}\n`;
  if (meta.host) s += `host: ${meta.host}\n`;
  if (meta.base_url) s += `base_url: ${meta.base_url}\n`;
  if (meta.owner) s += `owner: ${meta.owner}\n`;
  if (meta.repo) s += `repo: ${meta.repo}\n`;
  if (meta.registered?.via) {
    s += `registered:\n  via: ${meta.registered.via}\n`;
    if (meta.registered.org) s += `  org: ${meta.registered.org}\n`;
  }
  if (meta.default_branch) s += `default_branch: ${meta.default_branch}\n`;
  if (meta.visibility) s += `visibility: ${meta.visibility}\n`;
  return s;
}

// 写/刷新 space.yaml：权威字段用传入的覆盖，缓存字段未传则保留已有（code-state 写的）。
export function writeSpaceMeta(truthDir, spaceKey, meta = {}) {
  const dir = join(truthDir, "spaces", spaceKey);
  mkdirSync(dir, { recursive: true });
  const cur = readSpaceMeta(truthDir, spaceKey);
  const merged = {
    type: meta.type || cur.type || "github",
    ref: meta.ref || cur.ref || "-",
    provider: meta.provider || cur.provider || "",
    host: meta.host || cur.host || "",
    base_url: meta.base_url || cur.base_url || "",
    owner: meta.owner || cur.owner || "",
    repo: meta.repo || cur.repo || "",
    person: meta.person || cur.person || "",
    registered: meta.registered?.via ? meta.registered : cur.registered,
    default_branch: meta.default_branch || cur.default_branch || "",
    visibility: meta.visibility || cur.visibility || "",
  };
  const p = join(dir, "space.yaml");
  writeFileSync(p, render(merged));
  return { path: p };
}
