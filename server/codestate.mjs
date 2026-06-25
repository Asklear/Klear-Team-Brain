// 4h 轮询：把各团队仓 space（github/gitlab/gitea）的元数据(分支/最新commit/PR·MR)写进
// spaces/<key>/code-state.md，并对每个活跃分支算"最新 session vs 最后 push"，标"有未推进度"。代码本体不存。
import { join, relative } from "node:path";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fm } from "../core/card.mjs";
import { tokenFor, spaceKeyFor, refFor, baseUrlOf } from "../core/registry.mjs";
import { clientFor, ctxFor } from "../core/repohost.mjs";
import { log } from "../core/log.mjs";
import { commit } from "./gitstore.mjs";
import { writeSpaceMeta, readSpaceMeta } from "./space.mjs";

const REPO_PREFIXES = ["github__", "gitlab__", "gitea__"];
const isRepoKey = (k) => REPO_PREFIXES.some((p) => k.startsWith(p));

// 「活跃分支」窗口：最后 push 超过这么多天的分支不进 code-state。默认 30 天，长命名 release 分支会被滤掉，
// 用 CODESTATE_ACTIVE_DAYS 调大（如 365）即可纳入。
const ACTIVE_DAYS = Number(process.env.CODESTATE_ACTIVE_DAYS) || 30;

// 读不到该仓时，写一张显式告警 code-state，让管理员在 read_github / 搜索里一眼看到该补 token/权限。
function renderNoAccess(spaceKey, provider, ref, status) {
  const why = status === 404 ? "仓库不存在，或该 token 无权访问它（私有仓未纳入授权）"
    : status === 401 ? "token 无效或已过期"
    : `token 被拒（${status}：权限不足 / 触发限流 / 未授权该 token）`;
  return [
    `# code-state · ${spaceKey}`, `repo: ${ref}`, ``,
    `## ⚠️ 暂时读不到这个 ${provider} 仓（HTTP ${status}）`, ``,
    why + "。", ``,
    "**要做的事**：管理员把 `registry.yaml` 里该实例/项目的 token（或 github 的全局 `GITHUB_TOKEN`）" +
      "换成能读到 `" + ref + "` 的凭证，然后 `systemctl restart team-brain`。", ``,
    "_由 4h 轮询自动生成；权限修好后下次轮询会自动恢复为正常 code-state。_", "",
  ].join("\n");
}

// 该 space 每个分支(branchSafe)的最新 session 时间
function latestSessionByBranch(spaceDir) {
  const out = {};
  const root = join(spaceDir, "sessions");
  if (!existsSync(root)) return out;
  for (const br of readdirSync(root)) {
    const bdir = join(root, br);
    let st; try { st = statSync(bdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let max = "";
    for (const f of readdirSync(bdir)) {
      if (!f.endsWith(".md")) continue;
      const txt = readFileSync(join(bdir, f), "utf8");
      const d = fm(txt, "updated") || fm(txt, "date");   // 最后活跃（老卡片回退创建时间）
      if (d > max) max = d;
    }
    out[br] = max;
  }
  return out;
}

function render(spaceKey, ref, rows, pulls, prNote = "") {
  const lines = [`# code-state · ${spaceKey}`, `repo: ${ref}`, ``, `## 活跃分支`];
  for (const r of rows) {
    lines.push(`- **${r.name}** — \`${r.sha}\` ${r.msg}　(${(r.when || "").slice(0, 16)})` +
      (r.leads ? `　· **push 后有活动**（session ${r.sess.slice(0, 16)} 晚于最后 push，见 sessions/`
        + `${r.name.replace(/\//g, "-")}/）` : ""));
  }
  lines.push(``, `## Open PR/MR`);
  if (prNote) lines.push(prNote);
  else if (!pulls.length) lines.push(`（无）`);
  for (const p of pulls) lines.push(`- #${p.number} ${p.title}　(${p.headRef} → ${p.baseRef})`);
  lines.push(``, `_由 4h 轮询自动生成；代码本体不存，深看用 read_github 现拉。_`);
  return lines.join("\n") + "\n";
}

// 刷新单个团队仓 space：从 space.yaml 取 provider/owner/repo + registry 取 token/baseUrl，按 provider 分发客户端。
export async function refreshSpace(truthDir, spaceKey, registry, fallbackToken, { activeDays = ACTIVE_DAYS } = {}) {
  const spaceDir = join(truthDir, "spaces", spaceKey);
  const meta = readSpaceMeta(truthDir, spaceKey);
  const { provider, owner, repo, ref } = meta;
  if (!provider || !owner || !repo) return { skipped: "no-remote-ref" };
  const client = clientFor(provider);
  if (!client) return { skipped: `unknown-provider:${provider}` };
  const ctx = ctxFor(registry, meta, fallbackToken);

  // 算"有未推进度"：取本 space 各分支最新 session 时间
  const sessBy = {};
  for (const [br, d] of Object.entries(latestSessionByBranch(spaceDir))) {
    if (d > (sessBy[br] || "")) sessBy[br] = d;
  }
  const now = Date.now();

  let branches;
  try { branches = await client.listBranches(owner, repo, ctx); }
  catch (e) {
    // 权限/找不到（401/404 是确定性问题；403 可能是临时限流 → 已有正常 code-state 时不覆盖，避免误报）
    const status = e.status || 0;
    const hasCS = existsSync(join(spaceDir, "code-state.md"));
    if (status === 401 || status === 404 || (status === 403 && !hasCS)) {
      writeFileSync(join(spaceDir, "code-state.md"), renderNoAccess(spaceKey, provider, ref, status));
      const sha = await commit(truthDir, {
        name: "team-brain-bot", email: "bot@team-brain", message: `code-state ${spaceKey} (无权限)`,
        paths: [relative(truthDir, join(spaceDir, "code-state.md"))],
      });
      return { space: spaceKey, error: `branches: ${e.message}`, needsKey: true, commit: sha };
    }
    return { space: spaceKey, error: `branches: ${e.message}` };
  }

  // PR/MR 读不到（权限/403）不致命，留空 + 备注
  let pulls = [], prNote = "";
  try { pulls = await client.openPulls(owner, repo, ctx); }
  catch { prNote = "（token 无 PR/MR 读取权限）"; }

  const rows = [];
  for (const b of branches) {
    let c = null;
    try { c = await client.latestCommit(owner, repo, b.name, ctx); } catch {}
    const when = c?.date || "";
    if (when && now - new Date(when).getTime() > activeDays * 864e5) continue; // 只活跃分支
    const sess = sessBy[b.name.replace(/\//g, "-")] || "";
    rows.push({
      name: b.name, sha: (c?.sha || "").slice(0, 7),
      msg: (c?.message || "").split("\n")[0].slice(0, 80),
      when, sess, leads: !!(sess && when && sess > when),
    });
  }
  rows.sort((a, b) => (b.when || "").localeCompare(a.when || ""));

  const csAbs = join(spaceDir, "code-state.md");
  writeFileSync(csAbs, render(spaceKey, ref, rows, pulls, prNote));
  const sha = await commit(truthDir, {
    name: "team-brain-bot", email: "bot@team-brain", message: `code-state ${spaceKey}`,
    paths: [relative(truthDir, csAbs)],
  });
  return { space: spaceKey, branches: rows.length, pulls: pulls.length, leads: rows.filter((r) => r.leads).length, commit: sha };
}

// 该 space 有没有 session（懒加载判定"活跃"：org 预登记了一堆空 space，不该都轮询）
function hasSessions(spaceDir) {
  const sd = join(spaceDir, "sessions");
  if (!existsSync(sd)) return false;
  for (const br of readdirSync(sd)) {
    try { if (readdirSync(join(sd, br)).some((f) => f.endsWith(".md"))) return true; } catch {}
  }
  return false;
}

// 遍历团队仓 space 刷新 —— 懒加载：只轮询有 session 的（决策 5），跳过仅登记的空 space。
// 每个仓的 token/baseUrl 由 ctxFor 按 registry 解（provider 分发对调用方透明）。
export async function refreshAll(truthDir, registry, fallbackToken) {
  const root = join(truthDir, "spaces");
  if (!existsSync(root)) return [];
  const out = [];
  for (const key of readdirSync(root)) {
    if (!isRepoKey(key)) continue;
    if (!hasSessions(join(root, key))) { out.push({ space: key, skipped: "no-session" }); continue; }
    let r;
    try { r = await refreshSpace(truthDir, key, registry, fallbackToken); }
    catch (e) { r = { space: key, error: String(e.message || e) }; }
    out.push(r);
    // 每个 space 一行：失败/需补 key 用 warn（运维要看），正常用 debug（默认不刷屏）。
    if (r.error) log.warn("[code-state] space 刷新失败", { space: key, err: r.error, needsKey: r.needsKey || false });
    else if (!r.skipped) log.debug("[code-state] space 已刷新", { space: key, branches: r.branches, pulls: r.pulls, leads: r.leads });
  }
  return out;
}

// 启动时按 registry 枚举各 provider 的 scope（github org / gitlab group / gitea org）全部 repo
// + 单独登记的 repo/project → 预登记 space.yaml（无 session 也建）。只建元数据，code-state 走 refreshAll 懒加载。
export async function enumAndRegisterOrgRepos(truthDir, registry, fallbackToken) {
  let made = 0;
  const ensure = (provider, host, base_url, owner, repo, registered) => {
    const key = spaceKeyFor(provider, host, owner, repo);
    const yp = join(truthDir, "spaces", key, "space.yaml");
    if (existsSync(yp)) return;                            // 已有就不动（不覆盖缓存字段）
    writeSpaceMeta(truthDir, key, {
      type: provider, provider, host, base_url: base_url || undefined,
      owner, repo, ref: refFor(provider, host, owner, repo), registered,
    });
    made++;
  };

  // ---- github（顶层名单，host 恒 github.com）----
  for (const o of registry?.github?.orgs || []) {
    const org = typeof o === "string" ? o : o?.org;
    if (!org) continue;
    const token = tokenFor(registry, { provider: "github", owner: org, repo: "*" }, fallbackToken);
    let repos; try { repos = await clientFor("github").listRepos(org, { token }); }
    catch (e) { log.warn("[registry] 枚举 github org 失败", { org, err: e.message }); continue; }
    for (const r of repos) ensure("github", "github.com", "", r.owner, r.repo, { via: "org", org });
  }
  for (const r of registry?.github?.repos || []) {
    const owner = typeof r === "string" ? r.split("/")[0] : r?.owner;
    const repo = typeof r === "string" ? r.split("/")[1] : r?.repo;
    if (owner && repo) ensure("github", "github.com", "", owner, repo, { via: "repo" });
  }

  // ---- gitlab / gitea（按实例；scope/repo 字段名各异）。ensure 经闭包自增 made ----
  await enumProviderInstances(registry, fallbackToken, "gitlab", "groups", "projects", "group", "project", ensure);
  await enumProviderInstances(registry, fallbackToken, "gitea", "orgs", "repos", "org", "repo", ensure);

  if (made) {
    await commit(truthDir, { name: "team-brain-bot", email: "bot@team-brain", message: `registry: 预登记 ${made} 个 space`, paths: ["spaces"] });
  }
  return { registered: made };
}

// 枚举某 provider 全部实例的 scope（group/org）下 repo + 单独登记的 repo/project。新建计数经传入的 ensure 闭包自增（不经返回值）。
async function enumProviderInstances(registry, fallbackToken, provider, scopeField, repoField, scopeVia, repoVia, ensure) {
  const client = clientFor(provider);
  for (const inst of registry?.[provider]?.instances || []) {
    const host = (inst.host || "").toLowerCase();
    if (!host) continue;
    const baseUrl = baseUrlOf(inst);
    for (const s of inst[scopeField] || []) {
      const scope = typeof s === "string" ? s : (s?.group || s?.org);
      if (!scope) continue;
      const token = tokenFor(registry, { provider, host, owner: scope, repo: "*" }, fallbackToken);
      let repos; try { repos = await client.listRepos(scope, { token, baseUrl }); }
      catch (e) { log.warn(`[registry] 枚举 ${provider} ${scopeVia} 失败`, { host, scope, err: e.message }); continue; }
      for (const r of repos) ensure(provider, host, baseUrl, r.owner, r.repo, { via: scopeVia, org: scope });
    }
    for (const r of inst[repoField] || []) {
      const key = typeof r === "string" ? r : (r?.owner && r?.repo ? `${r.owner}/${r.repo}` : "");
      const i2 = key.lastIndexOf("/");
      if (i2 < 0) continue;
      ensure(provider, host, baseUrl, key.slice(0, i2), key.slice(i2 + 1), { via: repoVia });
    }
  }
}
