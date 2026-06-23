// Gitea 只读 API（REST, fetch）。Gitea 的 API 有意对齐 GitHub（端点/字段几乎同构）→ 这里基本是
// github.mjs 的参数化版：base = ${baseUrl}/api/v1、鉴权头 `Authorization: token`、字段直接照搬。
// ctx = { token, baseUrl }（baseUrl 必给，自建实例）。归一化形状 + 错误带 .status，与其它 provider 一致。
const api = (baseUrl) => `${String(baseUrl || "").replace(/\/+$/, "")}/api/v1`;

const headers = (token) => ({
  accept: "application/json",
  "user-agent": "team-brain",
  ...(token ? { authorization: `token ${token}` } : {}),
});

async function gt(baseUrl, path, token) {
  const r = await fetch(api(baseUrl) + path, { headers: headers(token) });
  if (!r.ok) throw Object.assign(new Error(`Gitea ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
  return r.json();
}

// 枚举某 org 下全部 repo（分页，Gitea limit 上限 50）。归一：[{owner, repo, default_branch, private}]。
export async function listRepos(org, { token, baseUrl } = {}) {
  const out = [];
  for (let page = 1; page <= 40; page++) {                 // 上限 2000 repo
    const arr = await gt(baseUrl, `/orgs/${encodeURIComponent(org)}/repos?limit=50&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) out.push({ owner: r.owner?.login || org, repo: r.name, default_branch: r.default_branch, private: r.private });
    if (arr.length < 50) break;
  }
  return out;
}

export const listBranches = (owner, repo, { token, baseUrl } = {}) =>
  gt(baseUrl, `/repos/${owner}/${repo}/branches?limit=50`, token).then((a) => (a || []).map((b) => ({ name: b.name })));

export const latestCommit = (owner, repo, branch, { token, baseUrl } = {}) =>
  gt(baseUrl, `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&limit=1`, token).then((a) => {
    const c = a?.[0];
    return c ? { sha: c.sha, message: c.commit?.message || "", date: c.commit?.committer?.date || c.commit?.author?.date || "" } : null;
  });

export const openPulls = (owner, repo, { token, baseUrl } = {}) =>
  gt(baseUrl, `/repos/${owner}/${repo}/pulls?state=open&limit=50`, token)
    .then((a) => (a || []).map((p) => ({ number: p.number, title: p.title, headRef: p.head?.ref, baseRef: p.base?.ref })));

export async function fileContent(owner, repo, path, ref, { token, baseUrl } = {}) {
  const encPath = String(path).split("/").map(encodeURIComponent).join("/");
  const d = await gt(baseUrl, `/repos/${owner}/${repo}/contents/${encPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, token);
  return d?.content != null ? Buffer.from(d.content, "base64").toString("utf8") : null;   // 空文件 content="" 也有效
}
