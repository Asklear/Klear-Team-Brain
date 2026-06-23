// GitLab 只读 API（REST v4, fetch）。与 GitHub/Gitea 的差异大，单独实现后归一化成统一形状：
//   · 资源用「项目」= URL-encode 的完整路径 owner/repo（owner 可含子组 group/sub）作 :id
//   · 鉴权头 PRIVATE-TOKEN
//   · 「合并请求(MR)」不是 PR；字段名不同（iid / source_branch / target_branch / committed_date / visibility）
// ctx = { token, baseUrl }（baseUrl 必给，自建实例）。错误带 .status，与其它 provider 一致。
const api = (baseUrl) => `${String(baseUrl || "").replace(/\/+$/, "")}/api/v4`;
const pid = (owner, repo) => encodeURIComponent(`${owner}/${repo}`);   // 项目 id = URL-encode 完整路径

const headers = (token) => ({
  accept: "application/json",
  "user-agent": "team-brain",
  ...(token ? { "private-token": token } : {}),
});

async function gl(baseUrl, path, token) {
  const r = await fetch(api(baseUrl) + path, { headers: headers(token) });
  if (!r.ok) throw Object.assign(new Error(`GitLab ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
  return r.json();
}

// 枚举某 group（含子组）下全部 project。归一：[{owner, repo, default_branch, private}]。
// owner = path_with_namespace 去掉末段；repo = 末段。
export async function listRepos(group, { token, baseUrl } = {}) {
  const out = [];
  const gid = encodeURIComponent(group);
  for (let page = 1; page <= 20; page++) {                 // 上限 2000 project
    const arr = await gl(baseUrl, `/groups/${gid}/projects?include_subgroups=true&archived=false&per_page=100&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      const full = p.path_with_namespace || "";
      const i = full.lastIndexOf("/");
      if (i < 0) continue;
      out.push({ owner: full.slice(0, i), repo: full.slice(i + 1), default_branch: p.default_branch, private: p.visibility !== "public" });
    }
    if (arr.length < 100) break;
  }
  return out;
}

export const listBranches = (owner, repo, { token, baseUrl } = {}) =>
  gl(baseUrl, `/projects/${pid(owner, repo)}/repository/branches?per_page=100`, token).then((a) => (a || []).map((b) => ({ name: b.name })));

export const latestCommit = (owner, repo, branch, { token, baseUrl } = {}) =>
  gl(baseUrl, `/projects/${pid(owner, repo)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`, token).then((a) => {
    const c = a?.[0];
    return c ? { sha: c.id, message: c.message || c.title || "", date: c.committed_date || c.created_at || "" } : null;
  });

// GitLab 是「合并请求」：iid→number，source/target_branch→head/baseRef。
export const openPulls = (owner, repo, { token, baseUrl } = {}) =>
  gl(baseUrl, `/projects/${pid(owner, repo)}/merge_requests?state=opened&per_page=50`, token)
    .then((a) => (a || []).map((m) => ({ number: m.iid, title: m.title, headRef: m.source_branch, baseRef: m.target_branch })));

export async function fileContent(owner, repo, path, ref, { token, baseUrl } = {}) {
  // GitLab files API 必须带【真实】ref（不认 git 的 HEAD）；没给则取项目默认分支，取不到就明确报错（别发注定 404 的 HEAD）。
  let r = ref;
  if (!r) r = (await gl(baseUrl, `/projects/${pid(owner, repo)}`, token))?.default_branch;
  if (!r) throw Object.assign(new Error(`gitlab: 无法确定 ${owner}/${repo} 的默认分支`), { status: 404 });
  const encPath = encodeURIComponent(path);     // 整条路径作单一 component（斜杠 → %2F）
  const d = await gl(baseUrl, `/projects/${pid(owner, repo)}/repository/files/${encPath}?ref=${encodeURIComponent(r)}`, token);
  return d?.content != null ? Buffer.from(d.content, "base64").toString("utf8") : null;   // 空文件 content="" 也算有效（→ ""）
}
