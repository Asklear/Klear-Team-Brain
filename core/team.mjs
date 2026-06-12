// 团队花名册：身份归一（本地 git 名 → canonical 成员）。M2 再用它做 token 鉴权。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

export function loadRoster(path) {
  if (!existsSync(path)) return { members: [] };
  try { return parse(readFileSync(path, "utf8")) || { members: [] }; }
  catch { return { members: [] }; }
}

// 机密：id -> token，单独一份（gitignore），不进花名册
export function loadTokens(path) {
  if (!existsSync(path)) return {};
  try { return parse(readFileSync(path, "utf8")) || {}; }
  catch { return {}; }
}

// 建 token -> 成员 的索引（鉴权用）
export function tokenIndex(roster, tokens) {
  const byId = new Map((roster.members || []).map((m) => [m.id, m]));
  const idx = new Map();
  for (const [id, tok] of Object.entries(tokens || {})) {
    const m = byId.get(id);
    if (m && tok) idx.set(tok, m);
  }
  return idx;
}

// git 名 → {id, name}；找不到回退原名（id=null 表示不在花名册）
export function resolveAuthor(roster, gitName) {
  for (const m of roster.members || []) {
    if (m.git_names?.includes(gitName) || m.id === gitName || m.name === gitName) {
      return { id: m.id, name: m.name };
    }
  }
  return { id: null, name: gitName || "unknown" };
}
