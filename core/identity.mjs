// 归一化：把"同一身份/同一仓的多种叫法"收敛成 canonical，给按人/按时间检索消除别名漏检。
// 两类别名：
//   1) space/org 别名：仓转移后旧坐标（github__haurhi__finance_qa）→ 现位置（github__Asklear__finance_qa）。
//      log 的 commit subject 是入库那刻冻结的文本，owner 搬家后不会改 → 直接拿去 read/ls 会 404。
//      canonicalSpaceKey 用 registry.moved 把任意（含历史）space_key 映射到现位置，让坐标跨工具可直接复用。
//   2) 身份别名：producer-id（tqt，文件名前缀/frontmatter）与 git author（taoqitian，commit 作者）是两套标识。
//      resolveAuthorQuery 用 team.yaml 花名册把 tqt/taoqitian/git_names 收敛成同一 accept 集，查任一别名结果一致。

// 解析 space_key：github__<owner>__<repo>。owner 是单个 GitHub 段（无 `__`），repo 可含 `_`/`__` →
// 按"去掉 github__ 前缀后第一个 __"切分，repo 取其后全部（不会把含下划线的 repo 切坏）。
export function parseSpaceKey(key) {
  const s = String(key || "");
  if (!s.startsWith("github__")) return null;           // local__<人> 等：无 owner/repo 概念
  const rest = s.slice("github__".length);
  const i = rest.indexOf("__");
  if (i < 0) return null;
  return { owner: rest.slice(0, i), repo: rest.slice(i + 2) };
}

// 任意（含历史/别名）space_key → 现位置 canonical space_key。
// 非 github（local__…）或解析不出 owner/repo → 原样返回（无可归一项，不瞎改）。
export function canonicalSpaceKey(registry, key) {
  const or = parseSpaceKey(key);
  if (!or) return String(key || "");
  let { owner, repo } = or;
  const mv = (registry?.moved || []).find((m) => m.from === `${owner}/${repo}`);
  if (mv) [owner, repo] = mv.to.split("/");
  return `github__${owner}__${repo}`;
}

// 把一条真相库相对 path 里的 space 段归一（spaces/<key>/… 的 <key> → canonical），其余原样。
// read/ls/find/grep 入口用：agent 抄了 log 给的旧坐标也能落到现位置，消除 404 类不一致。
export function canonicalizePath(registry, path) {
  const m = String(path || "").match(/^(spaces\/)([^/]+)(\/.*|)$/);
  if (!m) return String(path || "");
  return m[1] + canonicalSpaceKey(registry, m[2]) + m[3];
}

// 把一行 commit subject 里出现的 space_key（github__owner__repo，到第一个 / 为止）就地归一。
// log 输出坐标用：让"复制 log 坐标 → read/ls"这条链不再 404。
export function canonicalizeSubject(registry, subject) {
  return String(subject || "").replace(/github__[^/\s]+/g, (k) => canonicalSpaceKey(registry, k));
}

const lc = (s) => String(s || "").trim().toLowerCase();

// author 查询归一：把用户输入的一个名字（tqt / taoqitian / git_names 任一）解析成一个 accept 集。
// 命中花名册 → accept = 该成员的全部别名（id + name + git_names）：查 tqt 与查 taoqitian 落到同一集合 → 结果一致。
// 不在花名册 → fallback：accept = {q}，匹配时退化成子串包含（仿 git --author 的宽松行为，尽力而为）。
export function resolveAuthorQuery(roster, q) {
  const query = lc(q);
  if (!query) return { accept: new Set(), fallback: false, q: query };
  for (const m of roster?.members || []) {
    const aliases = [m.id, m.name, ...(m.git_names || [])].map(lc).filter(Boolean);
    if (aliases.includes(query)) return { accept: new Set(aliases), fallback: false, q: query };
  }
  return { accept: new Set([query]), fallback: true, q: query };
}

// 一条 session 的身份 token（producer-id + git author/submitter）是否命中 author 查询。
export function authorMatches(resolved, { producerId, author } = {}) {
  if (!resolved || !resolved.accept.size) return true;     // 没给 author 过滤 → 全过
  const tokens = [lc(producerId), lc(author)].filter(Boolean);
  if (tokens.some((t) => resolved.accept.has(t))) return true;
  // fallback（不在花名册）：宽松子串匹配，别因大小写/前后缀漏掉
  if (resolved.fallback) return tokens.some((t) => t.includes(resolved.q) || resolved.q.includes(t));
  return false;
}
