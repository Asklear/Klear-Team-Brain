// registry：团队登记的代码托管 org/repo 名单 —— 决定"有哪些团队 space"。
// 服务器 ingest 用它判 团队仓-vs-local；启动加载、改完 restart 生效（仿 tokens）。
// 支持三家 provider：github（内建 github.com，单实例）/ gitlab / gitea（自建可多实例）。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { saniSeg } from "./coord.mjs";

const empty = () => ({
  github: { orgs: [], repos: [] },
  gitlab: { instances: [] },
  gitea: { instances: [] },
  moved: [],
});

export function loadRegistry(path) {
  if (!existsSync(path)) return empty();
  try {
    const r = parse(readFileSync(path, "utf8")) || {};
    // moved：仓转移重定向（owner/repo 旧→新）。一次性迁移 + live ingest 都用它，让没改本地 remote 的客户端也落对。
    return {
      github: { orgs: r.github?.orgs || [], repos: r.github?.repos || [] },
      gitlab: { instances: r.gitlab?.instances || [] },
      gitea: { instances: r.gitea?.instances || [] },
      moved: r.moved || [],
    };
  } catch { return empty(); }
}

// github 内建只认 github.com（含子域，如 api.github.com 不会出现在 remote，但稳妥）。
// gitlab/gitea 是自建、host 各异 → 按 registry 登记的实例 host 匹配。
export const isGitHubHost = (host) => /(^|\.)github\.com$/i.test(host || "");

// 名单条目兼容字符串 或对象两种写法。
const scopeName = (o) => (typeof o === "string" ? o : (o?.group || o?.org));   // group(gitlab) / org(github,gitea)
const repoKey = (r) => (typeof r === "string" ? r : (r?.owner && r?.repo ? `${r.owner}/${r.repo}` : null));
const tokenOf = (e) => (typeof e === "object" ? (e?.token || e?.pat || "") : "");  // token / pat 都认
const hostOf = (inst) => (inst?.host || "").toLowerCase();
export const baseUrlOf = (inst) => inst?.base_url || (inst?.host ? `https://${inst.host}` : "");

// 自建实例的仓/scope 名单按 provider 取字段名（gitlab=groups/projects，gitea=orgs/repos）。
const scopeListOf = (provider, inst) => (provider === "gitlab" ? inst?.groups : inst?.orgs) || [];
const repoListOf = (provider, inst) => (provider === "gitlab" ? inst?.projects : inst?.repos) || [];

// 给定 host → 它属于哪个 provider/实例。github 内建（github.com）；gitlab/gitea 按登记实例匹配。
// 返回 { provider, host, base_url, instance? } 或 null（无人认领 → 该 remote 入 local）。
export function providerOf(registry, host) {
  const h = (host || "").toLowerCase();
  if (!h) return null;
  if (isGitHubHost(h)) return { provider: "github", host: "github.com", base_url: "" };
  for (const inst of registry?.gitlab?.instances || [])
    if (hostOf(inst) === h) return { provider: "gitlab", host: h, base_url: baseUrlOf(inst), instance: inst };
  for (const inst of registry?.gitea?.instances || [])
    if (hostOf(inst) === h) return { provider: "gitea", host: h, base_url: baseUrlOf(inst), instance: inst };
  return null;
}

// 取某 provider+host 的实例配置（codestate / 路由要 base_url、token、名单）。
export function instanceFor(registry, provider, host) {
  if (provider === "github") return null;     // github 单实例、无 base_url
  const h = (host || "").toLowerCase();
  return (registry?.[provider]?.instances || []).find((i) => hostOf(i) === h) || null;
}

// space_key：github 保持历史格式（不带 host，跨人合并不变）；gitlab/gitea 带 host 区分多实例 +
// owner 子组用 saniSeg 拍平（lossy，真值落 space.yaml）。
export function spaceKeyFor(provider, host, owner, repo) {
  if (provider === "github") return `github__${owner}__${repo}`;
  return `${provider}__${saniSeg(host)}__${saniSeg(owner)}__${saniSeg(repo)}`;
}

// ref（人读 / url 还原用）：github 历史格式 github/owner/repo；其余 host/owner/repo。
export function refFor(provider, host, owner, repo) {
  return provider === "github" ? `github/${owner}/${repo}` : `${host}/${owner}/${repo}`;
}

// 命中登记？scope（org/group）命中：github/gitea 精确等于 owner；gitlab 还认子组（登记 group 是 owner 路径祖先）。
// 否则看单仓登记。返回 { via, org? } 或 null。
function registrationFor(provider, scopeList, repoList, owner, repo) {
  const scopeHit = (scopeList || []).map(scopeName).filter(Boolean)
    .find((g) => owner === g || (provider === "gitlab" && owner.startsWith(g + "/")));
  if (scopeHit) return { via: provider === "gitlab" ? "group" : "org", org: scopeHit };
  if ((repoList || []).map(repoKey).filter(Boolean).includes(`${owner}/${repo}`))
    return { via: provider === "gitlab" ? "project" : "repo" };
  return null;
}

// 取访问某仓该用哪把 PAT（github 专用，保留旧名/旧签名给现有调用方与测试）：
// 单独登记的 repo 用它自己的；否则用其所属 org 的；都没有 → fallback（全局 GITHUB_TOKEN）。
export function patFor(registry, owner, repo, fallback = "") {
  const reg = registry?.github || {};
  const repoE = (reg.repos || []).find((r) => typeof r === "object" && r.owner === owner && r.repo === repo);
  if (repoE?.pat) return repoE.pat;
  const orgE = (reg.orgs || []).find((o) => scopeName(o) === owner);
  if (typeof orgE === "object" && orgE?.pat) return orgE.pat;
  return fallback;
}

// 通用取 token：github 走 patFor；gitlab/gitea 按实例 project/repo → group/org → 实例级 token → fallback。
// 粒度对齐登记：单仓一把 / scope 一把覆盖其下全部 / 实例一把兜底。
export function tokenFor(registry, { provider, host, owner, repo }, fallback = "") {
  if (provider === "github" || !provider) return patFor(registry, owner, repo, fallback);
  // gitlab/gitea：fallback 是 github 全局 token，对它们无意义 → 绝不外溢（否则会把 GitHub PAT 发给 GitLab/Gitea host）。
  // 没配实例/项目/scope token 就返回 ""（公开仓匿名读；私有仓上层据此回 503 提示补 token）。
  const inst = instanceFor(registry, provider, host);
  if (!inst) return "";
  const repoE = repoListOf(provider, inst).find((r) => typeof r === "object" && repoKey(r) === `${owner}/${repo}`);
  if (tokenOf(repoE)) return tokenOf(repoE);
  const scopeE = scopeListOf(provider, inst).find((s) => typeof s === "object" && scopeName(s) &&
    (owner === scopeName(s) || (provider === "gitlab" && owner.startsWith(scopeName(s) + "/"))));
  if (tokenOf(scopeE)) return tokenOf(scopeE);
  return inst.token || inst.pat || "";
}

// 登记里有没有任何 github 条目（决定要不要启用 github 的 code-state / org 枚举）。
export function hasGithub(registry) {
  const reg = registry?.github || {};
  return (reg.orgs || []).length > 0 || (reg.repos || []).length > 0;
}

// 有没有配置任何 provider（决定要不要起 code-state 轮询）。
export function hasAnyRemote(registry) {
  return hasGithub(registry)
    || (registry?.gitlab?.instances || []).length > 0
    || (registry?.gitea?.instances || []).length > 0;
}

// 核心决策（纯函数，好测）。
// remote: {host,owner,repo} | null ; producerId: 提交者 id。
// 返回 local：{ space_key, type:'local', person }；
//      或团队仓：{ space_key, type:provider, provider, host, base_url?, owner, repo, ref, registered }。
export function decideSpaceKey(registry, remote, producerId) {
  const local = () => ({ space_key: `local__${producerId}`, type: "local", person: producerId });
  if (!remote || !remote.host) return local();

  const p = providerOf(registry, remote.host);
  if (!p) return local();

  // 仓转移重定向（registry.moved 是 github-only 语义）：客户端可能还指着旧 owner/repo（转移后本地 remote 没改）
  // → 映射到现位置。仅 github 应用，避免误改同名的 gitlab/gitea 仓。
  let { owner, repo } = remote;
  if (p.provider === "github") {
    const mv = (registry?.moved || []).find((m) => m.from === `${owner}/${repo}`);
    if (mv) [owner, repo] = mv.to.split("/");
  }

  // github 名单在顶层；gitlab/gitea 名单在各自实例里。
  const registered = p.provider === "github"
    ? registrationFor("github", registry?.github?.orgs, registry?.github?.repos, owner, repo)
    : registrationFor(p.provider, scopeListOf(p.provider, p.instance), repoListOf(p.provider, p.instance), owner, repo);
  if (!registered) return local();

  return {
    space_key: spaceKeyFor(p.provider, p.host, owner, repo),
    type: p.provider,
    provider: p.provider,
    host: p.host,
    base_url: p.base_url || undefined,
    owner, repo,
    ref: refFor(p.provider, p.host, owner, repo),
    registered,
  };
}
