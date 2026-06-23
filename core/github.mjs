// GitHub 只读 API（REST, fetch）。供 4h 轮询(元数据) + 按需现拉(内容) 用。
// 统一 provider 客户端接口（见 core/repohost.mjs）：返回【归一化形状】，错误带 .status。
// token 由调用方传入（ctx.token）；没 token 时调用方负责跳过。ctx.baseUrl 对 github.com 忽略。
const API = "https://api.github.com";

const headers = (token) => ({
  accept: "application/vnd.github+json",
  "user-agent": "team-brain",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function gh(path, token) {
  const r = await fetch(API + path, { headers: headers(token) });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
  return r.json();
}

// space.yaml 老 github 空间的 ref = "github/owner/repo" → {owner, repo}（向后兼容兜底）。
export function ownerRepoFromRef(ref) {
  const p = (ref || "").split("/").filter(Boolean);
  if (p.length < 3) return null;
  return { owner: p[p.length - 2], repo: p[p.length - 1] };
}

// 枚举某 org 下全部 repo（分页）。归一：[{owner, repo, default_branch, private}]。
export async function listRepos(org, { token } = {}) {
  const out = [];
  for (let page = 1; page <= 20; page++) {                 // 上限 2000 repo，足够；防失控
    const arr = await gh(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) out.push({ owner: r.owner?.login || org, repo: r.name, default_branch: r.default_branch, private: r.private });
    if (arr.length < 100) break;
  }
  return out;
}

export const listBranches = (owner, repo, { token } = {}) =>
  gh(`/repos/${owner}/${repo}/branches?per_page=100`, token).then((a) => (a || []).map((b) => ({ name: b.name })));

export const latestCommit = (owner, repo, branch, { token } = {}) =>
  gh(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, token).then((a) => {
    const c = a?.[0];
    return c ? { sha: c.sha, message: c.commit?.message || "", date: c.commit?.committer?.date || c.commit?.author?.date || "" } : null;
  });

export const openPulls = (owner, repo, { token } = {}) =>
  gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`, token)
    .then((a) => (a || []).map((p) => ({ number: p.number, title: p.title, headRef: p.head?.ref, baseRef: p.base?.ref })));

export async function fileContent(owner, repo, path, ref, { token } = {}) {
  const encPath = String(path).split("/").map(encodeURIComponent).join("/");  // 路径含空格/特殊字符也安全
  const d = await gh(`/repos/${owner}/${repo}/contents/${encPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, token);
  return d?.content != null ? Buffer.from(d.content, "base64").toString("utf8") : null;   // 空文件 content="" 也有效（目录返回数组 → undefined → null）
}
