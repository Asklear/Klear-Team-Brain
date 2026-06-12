// GitHub 只读 API（REST，fetch）。供 4h 轮询(元数据) + 按需现拉(内容) 用。
// token 由调用方传入；没有 token 时调用方负责跳过。
const API = "https://api.github.com";

const headers = (token) => ({
  accept: "application/vnd.github+json",
  "user-agent": "team-brain",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function gh(path, token) {
  const r = await fetch(API + path, { headers: headers(token) });
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// space.yaml 的 ref = "github.com/owner/repo" → {owner, repo}
export function ownerRepoFromRef(ref) {
  const p = (ref || "").split("/").filter(Boolean);
  if (p.length < 3) return null;
  return { owner: p[p.length - 2], repo: p[p.length - 1] };
}

// 枚举某 org 下全部 repo（分页）。返回 [{owner, repo, default_branch, private}]。
export async function listReposInOrg(org, token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {                 // 上限 2000 repo，足够；防失控
    const arr = await gh(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) out.push({ owner: r.owner?.login || org, repo: r.name, default_branch: r.default_branch, private: r.private });
    if (arr.length < 100) break;
  }
  return out;
}

export const listBranches = (owner, repo, token) =>
  gh(`/repos/${owner}/${repo}/branches?per_page=100`, token);

export const latestCommit = (owner, repo, branch, token) =>
  gh(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, token).then((a) => a[0] || null);

export const openPulls = (owner, repo, token) =>
  gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`, token);

export async function fileContent(owner, repo, path, ref, token) {
  const encPath = String(path).split("/").map(encodeURIComponent).join("/");  // 路径含空格/特殊字符也安全
  const d = await gh(`/repos/${owner}/${repo}/contents/${encPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, token);
  return d?.content ? Buffer.from(d.content, "base64").toString("utf8") : null;
}
