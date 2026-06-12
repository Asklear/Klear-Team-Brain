// registry：团队登记的 GitHub org/repo 名单 —— 决定"有哪些 github space"。
// 服务器 ingest 用它判 github-vs-local；启动加载、改完 restart 生效（仿 tokens）。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

const empty = () => ({ github: { orgs: [], repos: [] }, moved: [] });

export function loadRegistry(path) {
  if (!existsSync(path)) return empty();
  try {
    const r = parse(readFileSync(path, "utf8")) || {};
    // moved：仓转移重定向（owner/repo 旧→新）。一次性迁移 + live ingest 都用它，让没改本地 remote 的客户端也落对。
    return { github: { orgs: r.github?.orgs || [], repos: r.github?.repos || [] }, moved: r.moved || [] };
  } catch { return empty(); }
}

// 本期只认 GitHub host（决策 4）；其他 host 一律暂入 local。
export const isGitHubHost = (host) => /(^|\.)github\.com$/i.test(host || "");

// 名单条目兼容两种写法：字符串 或 {org, pat}/{owner, repo, pat}
const orgName = (o) => (typeof o === "string" ? o : o?.org);
const repoKey = (r) => (typeof r === "string" ? r : (r?.owner && r?.repo ? `${r.owner}/${r.repo}` : null));

// 取访问某仓该用哪把 PAT：单独登记的 repo 用它自己的 pat；否则用其所属 org 的 pat；都没有 → fallback（全局 GITHUB_TOKEN）。
// 粒度对齐登记：org 一把覆盖全部 repo，单独登记的 repo 每仓一把。
export function patFor(registry, owner, repo, fallback = "") {
  const reg = registry?.github || {};
  const repoE = (reg.repos || []).find((r) => typeof r === "object" && r.owner === owner && r.repo === repo);
  if (repoE?.pat) return repoE.pat;
  const orgE = (reg.orgs || []).find((o) => orgName(o) === owner);
  if (typeof orgE === "object" && orgE?.pat) return orgE.pat;
  return fallback;
}

// 登记里有没有任何 GitHub 条目（决定要不要启用 code-state / org 枚举）
export function hasGithub(registry) {
  const reg = registry?.github || {};
  return (reg.orgs || []).length > 0 || (reg.repos || []).length > 0;
}

// 核心决策（纯函数，好测）。
// remote: {host,owner,repo} | null ; producerId: 提交者 id。
// 返回 { space_key, type, ref?, registered?, person? } —— 直接喂给 writeSpaceMeta / buildCard。
export function decideSpaceKey(registry, remote, producerId) {
  const local = () => ({ space_key: `local__${producerId}`, type: "local", person: producerId });
  if (!remote || !isGitHubHost(remote.host)) return local();

  const reg = registry?.github || {};
  // 仓转移重定向：客户端可能还指着旧 owner/repo（GitHub 转移后本地 remote 没改）→ 先映射到现位置
  let { owner, repo } = remote;
  const mv = (registry?.moved || []).find((m) => m.from === `${owner}/${repo}`);
  if (mv) [owner, repo] = mv.to.split("/");
  const viaOrg = (reg.orgs || []).map(orgName).filter(Boolean).includes(owner);
  const viaRepo = (reg.repos || []).map(repoKey).filter(Boolean).includes(`${owner}/${repo}`);
  if (!viaOrg && !viaRepo) return local();

  return {
    space_key: `github__${owner}__${repo}`,
    type: "github",
    ref: `github/${owner}/${repo}`,
    registered: viaOrg ? { via: "org", org: owner } : { via: "repo" },
  };
}
