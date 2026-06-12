// space.yaml 读写（每个 space 一份元数据）。schema 见 REDESIGN.md §3.4：
//   github: type/ref/registered + 缓存(default_branch/visibility)
//   local : type/person
// 权威字段来自 registry/ingest；缓存字段由 code-state 轮询刷新（可重建）。
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fm } from "../core/card.mjs";

function readRegistered(txt) {
  const via = (txt.match(/^\s+via:\s*(.*)$/m) || [, ""])[1].trim();
  const org = (txt.match(/^\s+org:\s*(.*)$/m) || [, ""])[1].trim();
  return via ? { via, ...(org ? { org } : {}) } : {};
}

export function readSpaceMeta(truthDir, spaceKey) {
  const p = join(truthDir, "spaces", spaceKey, "space.yaml");
  if (!existsSync(p)) return { type: "", ref: "", person: "", default_branch: "", visibility: "", registered: {} };
  const txt = readFileSync(p, "utf8");
  return {
    type: fm(txt, "type"),
    ref: fm(txt, "ref"),
    person: fm(txt, "person"),
    default_branch: fm(txt, "default_branch"),
    visibility: fm(txt, "visibility"),
    registered: readRegistered(txt),
  };
}

function render(meta) {
  if (meta.type === "local") return `type: local\nperson: ${meta.person || "-"}\n`;
  let s = `type: ${meta.type || "github"}\nref: ${meta.ref || "-"}\n`;
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
    person: meta.person || cur.person || "",
    registered: meta.registered?.via ? meta.registered : cur.registered,
    default_branch: meta.default_branch || cur.default_branch || "",
    visibility: meta.visibility || cur.visibility || "",
  };
  const p = join(dir, "space.yaml");
  writeFileSync(p, render(merged));
  return { path: p };
}

