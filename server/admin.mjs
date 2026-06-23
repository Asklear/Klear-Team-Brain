#!/usr/bin/env node
// 服务器侧加人/列人/撤人。只在服务器上跑（由本机 `brain admin` 经 SSH 调用）。
// 改 team.yaml（花名册）+ tokens.yaml（密钥）+ 重启服务。控制面，靠"能 SSH 进来"鉴权。
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEAM = join(ROOT, "team.yaml");
const TOKENS = process.env.TOKENS_FILE || join(ROOT, "tokens.yaml");
const REGISTRY = process.env.REGISTRY_FILE || join(ROOT, "registry.yaml");
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const n = argv[i + 1]; o[a.slice(2)] = (n && !n.startsWith("--")) ? argv[++i] : true; }
    else o._.push(a);
  }
  return o;
}

const loadTeam = () => existsSync(TEAM) ? (parse(readFileSync(TEAM, "utf8")) || { members: [] }) : { members: [] };
const saveTeam = (t) => writeFileSync(TEAM,
  `# 团队花名册 —— 谁能接入「项目大脑」+ 身份归一。由 brain admin 维护（token 在 tokens.yaml）。\n` + stringify(t));
const restart = () => spawnSync("systemctl", ["restart", "team-brain"], { encoding: "utf8" }).status === 0;
const b64url = (s) => Buffer.from(s).toString("base64url");

function add(o) {
  const id = o.id || o._[0];
  if (!id || /[^a-z0-9_-]/i.test(id)) fail(`需要 ascii id（字母数字-_）：admin add <id> --name "显示名"`);
  const name = o.name || id, email = o.email || "", srv = o["server-url"];
  if (!srv) fail("缺 --server-url");
  const team = loadTeam();
  team.members = team.members || [];
  if (team.members.some((m) => m.id === id)) fail(`id "${id}" 已存在`);

  const token = randomBytes(24).toString("hex");
  team.members.push({ id, name, email, git_names: o["git-name"] ? [o["git-name"]] : [] });
  saveTeam(team);
  appendFileSync(TOKENS, `${id}: "${token}"\n`);
  const ok = restart();

  const invite = "BRAIN-" + b64url(JSON.stringify({ srv, token, id, name, consumer: !!o.consumer }));
  console.log(`✓ ${name}（${id}）已加入${ok ? "，服务器已重启" : "（⚠️ 重启失败，手动 systemctl restart team-brain）"}`);
  console.log(`✓ 把下面整段私聊发给 ${name}（别发群）：`);
  console.log("────────────────────────────────────────────");
  console.log(`你被加入了「项目大脑」。装好 Node 22+ 后，终端跑两行：`);
  console.log(`  curl -fsSL ${srv}/get | bash`);
  console.log(`  brain join ${invite}`);
  console.log(`完事，之后照常用 Claude Code/Codex 干活就行。`);
  console.log("────────────────────────────────────────────");
}

function list() {
  const tokens = existsSync(TOKENS) ? (parse(readFileSync(TOKENS, "utf8")) || {}) : {};
  console.log("id\tname\t接入\temail");
  for (const m of loadTeam().members || [])
    console.log(`${m.id}\t${m.name}\t${tokens[m.id] ? "✓" : "✗(无token)"}\t${m.email || ""}`);
}

function remove(o) {
  const id = o.id || o._[0];
  if (!id) fail("admin remove <id>");
  if (existsSync(TOKENS)) {                          // 撤 token；花名册保留 = provenance 还在
    const kept = readFileSync(TOKENS, "utf8").split("\n").filter((l) => !l.trim().startsWith(`${id}:`));
    writeFileSync(TOKENS, kept.join("\n"));
  }
  const ok = restart();
  console.log(`✓ 已撤销 ${id} 的访问（历史数据保留）${ok ? "，服务器已重启" : ""}`);
}

// ---- registry：登记的代码托管 org/repo（决定有哪些团队 space）。github 顶层；gitlab/gitea 按实例 ----
const loadReg = () => (existsSync(REGISTRY) ? (parse(readFileSync(REGISTRY, "utf8")) || {}) : {});
const saveReg = (r) => writeFileSync(REGISTRY,
  `# registry —— 登记的 github org/repo + gitlab/gitea 实例（决定有哪些团队 space）。由 brain admin 维护。\n` + stringify(r));
const normReg = (r) => { r.github = r.github || {}; r.github.orgs = r.github.orgs || []; r.github.repos = r.github.repos || []; return r; };
const orgNames = (r) => r.github.orgs.map((o) => (typeof o === "string" ? o : o?.org));
const repoKeys = (r) => r.github.repos.map((x) => (typeof x === "string" ? x : `${x.owner}/${x.repo}`));

function regOrg(o) {
  const sub = o._.shift(), name = o._[0];
  const r = normReg(loadReg());
  if (sub === "list") return void console.log(orgNames(r).join("\n") || "（无登记 org）");
  if (!name || /[^a-z0-9_.-]/i.test(name)) fail("用法：admin org add|rm <org>");
  if (sub === "add") {
    if (orgNames(r).includes(name)) fail(`org "${name}" 已登记`);
    r.github.orgs.push({ org: name, ...(o.pat ? { pat: o.pat } : {}) }); saveReg(r);
    console.log(`✓ 已登记 org ${name}${o.pat ? "（带 PAT）" : "（无 PAT，用全局 GITHUB_TOKEN）"}${restart() ? "，服务器已重启（下次轮询会枚举它的 repo）" : ""}`);
  } else if (sub === "rm" || sub === "remove") {
    r.github.orgs = r.github.orgs.filter((x) => (typeof x === "string" ? x : x?.org) !== name); saveReg(r);
    console.log(`✓ 已移除 org ${name}${restart() ? "，服务器已重启" : ""}（已建的 space 不会自动删，需要时手动清）`);
  } else fail("用法：admin org add|rm|list <org>");
}

function regRepo(o) {
  const sub = o._.shift(), key = o._[0];
  const r = normReg(loadReg());
  if (sub === "list") return void console.log(repoKeys(r).join("\n") || "（无登记 repo）");
  if (!key || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(key)) fail("用法：admin repo add|rm <owner/repo>");
  const [owner, repo] = key.split("/");
  if (sub === "add") {
    if (repoKeys(r).includes(key)) fail(`repo "${key}" 已登记`);
    r.github.repos.push({ owner, repo, ...(o.pat ? { pat: o.pat } : {}) }); saveReg(r);
    console.log(`✓ 已登记 repo ${key}${o.pat ? "（带 PAT）" : "（无 PAT，用全局 GITHUB_TOKEN）"}${restart() ? "，服务器已重启" : ""}`);
  } else if (sub === "rm" || sub === "remove") {
    r.github.repos = r.github.repos.filter((x) => (typeof x === "string" ? x : `${x.owner}/${x.repo}`) !== key); saveReg(r);
    console.log(`✓ 已移除 repo ${key}${restart() ? "，服务器已重启" : ""}`);
  } else fail("用法：admin repo add|rm|list <owner/repo>");
}

// ---- gitlab / gitea：自建可多实例。每实例 host + base_url + token，下挂 scope（group/org）与单仓（project/repo）----
const PROV = {
  gitlab: { scope: "groups", repo: "projects", scopeName: "group", repoName: "project", scopeKey: "group" },
  gitea: { scope: "orgs", repo: "repos", scopeName: "org", repoName: "repo", scopeKey: "org" },
};
const normProv = (r, provider) => { r[provider] = r[provider] || {}; r[provider].instances = r[provider].instances || []; return r; };
const findInst = (r, provider, host) => (r[provider].instances).find((i) => (i.host || "").toLowerCase() === host.toLowerCase());
const scopeNameOf = (m, x) => (typeof x === "string" ? x : (x?.[m.scopeKey]));
const repoKeyOf = (x) => (typeof x === "string" ? x : (x?.owner && x?.repo ? `${x.owner}/${x.repo}` : ""));

function providerCmd(provider, o) {
  const m = PROV[provider];
  const r = normProv(normReg(loadReg()), provider);
  const action = o._.shift();

  if (action === "instance") {
    const sub = o._.shift(), host = o._[0];
    if (sub === "list") return void console.log(r[provider].instances.map((i) => `${i.host}${i.base_url ? ` (${i.base_url})` : ""}${i.token ? " [token]" : ""}`).join("\n") || "（无实例）");
    if (!host) fail(`用法：admin ${provider} instance add|rm|list <host> [--base-url <url>] [--token <t>]`);
    if (sub === "add") {
      let inst = findInst(r, provider, host);
      if (!inst) { inst = { host }; r[provider].instances.push(inst); }
      if (o["base-url"]) inst.base_url = o["base-url"];
      if (o.token) inst.token = o.token;
      saveReg(r);
      console.log(`✓ 实例 ${host}${o["base-url"] ? `（base_url=${o["base-url"]}）` : ""}${o.token ? "（带 token）" : ""}${restart() ? "，服务器已重启" : ""}`);
    } else if (sub === "rm" || sub === "remove") {
      r[provider].instances = r[provider].instances.filter((i) => (i.host || "").toLowerCase() !== host.toLowerCase()); saveReg(r);
      console.log(`✓ 已移除实例 ${host}${restart() ? "，服务器已重启" : ""}（已建的 space 不会自动删）`);
    } else fail(`用法：admin ${provider} instance add|rm|list <host>`);
    return;
  }

  const isScope = action === m.scopeName, isRepo = action === m.repoName;
  if (!isScope && !isRepo) fail(`用法：admin ${provider} instance|${m.scopeName}|${m.repoName} …`);
  const listKey = isScope ? m.scope : m.repo;
  const sub = o._.shift(), host = o._[0], name = o._[1];
  if (!host) fail(`用法：admin ${provider} ${action} add|rm|list <host> [<${isScope ? "name" : "owner/repo"}>]`);
  let inst = findInst(r, provider, host);

  if (sub === "list") return void console.log((inst?.[listKey] || []).map((x) => isScope ? scopeNameOf(m, x) : repoKeyOf(x)).join("\n") || "（无）");
  if (!name) fail(`用法：admin ${provider} ${action} add|rm <host> <${isScope ? "name" : "owner/repo"}>`);
  if (isRepo && !/^[a-z0-9_./-]+\/[a-z0-9_.-]+$/i.test(name)) fail("owner/repo 形如 group/sub/proj 或 owner/repo");
  if (!inst) { if (sub !== "add") fail(`实例 ${host} 未登记（先 admin ${provider} instance add ${host}）`); inst = { host }; r[provider].instances.push(inst); }
  inst[listKey] = inst[listKey] || [];

  const has = (x) => isScope ? scopeNameOf(m, x) === name : repoKeyOf(x) === name;
  if (sub === "add") {
    if (inst[listKey].some(has)) fail(`${action} "${name}" 已登记`);
    if (isScope) inst[listKey].push({ [m.scopeKey]: name, ...(o.token ? { token: o.token } : {}) });
    else { const i = name.lastIndexOf("/"); inst[listKey].push({ owner: name.slice(0, i), repo: name.slice(i + 1), ...(o.token ? { token: o.token } : {}) }); }
    saveReg(r);
    console.log(`✓ 已登记 ${provider} ${action} ${host}/${name}${o.token ? "（带 token）" : "（用实例级 token）"}${restart() ? "，服务器已重启" : ""}`);
  } else if (sub === "rm" || sub === "remove") {
    inst[listKey] = inst[listKey].filter((x) => !has(x)); saveReg(r);
    console.log(`✓ 已移除 ${provider} ${action} ${host}/${name}${restart() ? "，服务器已重启" : ""}`);
  } else fail(`用法：admin ${provider} ${action} add|rm|list <host> <${isScope ? "name" : "owner/repo"}>`);
}

const o = parseArgs(process.argv.slice(2));
const cmd = o._.shift();
if (cmd === "add") add(o);
else if (cmd === "list") list();
else if (cmd === "remove" || cmd === "rm") remove(o);
else if (cmd === "org") regOrg(o);
else if (cmd === "repo") regRepo(o);
else if (cmd === "gitlab") providerCmd("gitlab", o);
else if (cmd === "gitea") providerCmd("gitea", o);
else fail("用法：admin add|list|remove|org|repo|gitlab|gitea …");
