// 客户端坐标：从 cwd 只算两样原始信息 —— remote(host/owner/repo) 和 folder 标签。
// github-vs-local 的决策不在这里，由服务器 ingest 按 registry 定（见 core/registry.mjs）。
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

// git@github.com:owner/repo.git | https://github.com/owner/repo.git → {host,owner,repo}
export function parseRemote(url) {
  let s = (url || "").trim()
    .replace(/^git@/, "").replace(/^ssh:\/\/git@/, "").replace(/^https?:\/\//, "")
    .replace(":", "/").replace(/\.git$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  // owner = host 与 repo 之间的全部（含 gitlab 子组 group/sub）；github 永远只有一段，行为不变
  return { host: parts[0], owner: parts.slice(1, -1).join("/"), repo: parts[parts.length - 1] };
}

// cwd 当前所在 git 分支（Codex 的 rollout 不记分支 → 上传时按 cwd 现取，尽力而为）。
export function gitBranch(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  try { return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || null; } catch { return null; }
}

export function expandHome(p) {
  if (p === "~") return homedir();
  if (typeof p === "string" && p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

const within = (p, f) => {
  const root = expandHome(f);
  return !!root && (p === root || p.startsWith(root.endsWith("/") ? root : root + "/"));
};
// 路径段规范化：与旧 localKey 的 sani 一致 —— 保证迁移脚本从旧 space_key 反推的 folder
// 与这里现算的 folder 对得上（同一规则，clean 名字完全一致；含特殊字符的两边都被归一）。
export const saniSeg = (s) => (s || "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "x";

// folder 标签：cwd 相对所属 upload_folder 的规范化路径 = [basename(根), ...相对段].join('/')。
// 仅作 local session 的标签/facet（过滤、浏览），不进 space_key。迁移脚本反推必须用同一逻辑。
export function normalizeFolder(cwd, uploadFolders = []) {
  if (!cwd) return "";
  const root = (uploadFolders || []).map(expandHome).filter((f) => within(cwd, f)).sort((a, b) => b.length - a.length)[0]; // 最长匹配
  const segs = root
    ? [basename(root), ...(cwd === root ? [] : cwd.slice(root.length).replace(/^\//, "").split("/"))]
    : [basename(cwd)];                          // 兜底：不在任何 upload_folder 下
  return segs.map(saniSeg).join("/");
}

// 只返回 { remote, folder, root }。space_key/home/ref 由服务器决定。
export function coordOf(cwd, uploadFolders = []) {
  let root = cwd, remote = null;
  if (cwd && existsSync(cwd)) {
    try { root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd; } catch {}
    try { remote = parseRemote(git(cwd, ["remote", "get-url", "origin"])); } catch {}
  }
  return { remote, folder: normalizeFolder(cwd, uploadFolders), root };
}
