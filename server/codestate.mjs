// 4h 轮询：把各 github space 的元数据(分支/最新commit/PR)写进 spaces/<key>/code-state.md，
// 并对每个活跃分支算"最新 session vs 最后 push"，标"有未推进度"。代码本体不存。
import { join, relative } from "node:path";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fm } from "../core/card.mjs";
import { ownerRepoFromRef, listBranches, latestCommit, openPulls, listReposInOrg } from "../core/github.mjs";
import { patFor } from "../core/registry.mjs";
import { log } from "../core/log.mjs";
import { commit } from "./gitstore.mjs";
import { writeSpaceMeta } from "./space.mjs";

// 读不到该 GitHub 仓时，写一张显式告警 code-state，让 CEO 在 read_github / 搜索里一眼看到该加 key。
function renderNoAccess(spaceKey, ref, status) {
  const why = status === 404 ? "仓库不存在，或当前 GITHUB_TOKEN 无权访问它（私有仓未把它纳入授权）"
    : status === 401 ? "GITHUB_TOKEN 无效或已过期"
    : `GITHUB_TOKEN 被拒（${status}：权限不足 / 触发限流 / org 未授权该 token）`;
  return [
    `# code-state · ${spaceKey}`, `repo: ${ref}`, ``,
    `## ⚠️ 暂时读不到这个 GitHub 仓（HTTP ${status}）`, ``,
    why + "。", ``,
    "**要做的事**：管理员把服务器的 `GITHUB_TOKEN` 换成能读到 `" + ref + "` 的 PAT" +
      "（fine-grained PAT 需把此仓加进仓库名单；org 仓可能还要为该 token 授权 SSO），然后 `systemctl restart team-brain`。", ``,
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
      (r.leads ? `　⚠️ **有未推进度**（session ${r.sess.slice(0, 16)} 晚于最后 push，见 sessions/`
        + `${r.name.replace(/\//g, "-")}/）` : ""));
  }
  lines.push(``, `## Open PR`);
  if (prNote) lines.push(prNote);
  else if (!pulls.length) lines.push(`（无）`);
  for (const p of pulls) lines.push(`- #${p.number} ${p.title}　(${p.head?.ref} → ${p.base?.ref})`);
  lines.push(``, `_由 4h 轮询自动生成；代码本体不存，深看用 read_github 现拉。_`);
  return lines.join("\n") + "\n";
}

export async function refreshSpace(truthDir, spaceKey, token, { activeDays = 30 } = {}) {
  const spaceDir = join(truthDir, "spaces", spaceKey);
  const syp = join(spaceDir, "space.yaml");
  const ref = existsSync(syp) ? fm(readFileSync(syp, "utf8"), "ref") : "";
  const or = ownerRepoFromRef(ref);
  if (!or) return { skipped: "no-github-ref" };

  const { owner, repo } = or;
  // 算"有未推进度"：取本 space 各分支最新 session 时间
  const sessBy = {};
  for (const [br, d] of Object.entries(latestSessionByBranch(spaceDir))) {
    if (d > (sessBy[br] || "")) sessBy[br] = d;
  }
  const now = Date.now();

  let branches;
  try { branches = await listBranches(owner, repo, token); }
  catch (e) {
    // 权限/找不到（401/404 是确定性问题；403 可能是临时限流 → 已有正常 code-state 时不覆盖，避免误报）
    const status = Number((/GitHub (\d+)/.exec(e.message) || [])[1]) || 0;
    const hasCS = existsSync(join(spaceDir, "code-state.md"));
    if (status === 401 || status === 404 || (status === 403 && !hasCS)) {
      writeFileSync(join(spaceDir, "code-state.md"), renderNoAccess(spaceKey, ref, status));
      const sha = await commit(truthDir, {
        name: "team-brain-bot", email: "bot@team-brain", message: `code-state ${spaceKey} (无权限)`,
        paths: [relative(truthDir, join(spaceDir, "code-state.md"))],
      });
      return { space: spaceKey, error: `branches: ${e.message}`, needsKey: true, commit: sha };
    }
    return { space: spaceKey, error: `branches: ${e.message}` };
  }

  // PR 读不到（权限/403）不致命，留空 + 备注
  let pulls = [], prNote = "";
  try { pulls = await openPulls(owner, repo, token); }
  catch { prNote = "（token 无 Pull requests 读取权限）"; }

  const rows = [];
  for (const b of branches) {
    let c = null;
    try { c = await latestCommit(owner, repo, b.name, token); } catch {}
    const when = c?.commit?.committer?.date || c?.commit?.author?.date || "";
    if (when && now - new Date(when).getTime() > activeDays * 864e5) continue; // 只活跃分支
    const sess = sessBy[b.name.replace(/\//g, "-")] || "";
    rows.push({
      name: b.name, sha: (c?.sha || "").slice(0, 7),
      msg: (c?.commit?.message || "").split("\n")[0].slice(0, 80),
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

// 遍历 github space 刷新 —— 懒加载：只轮询有 session 的（决策 5），跳过仅登记的空 space。
// 每个仓用它该用的 PAT（registry 里 org 一把 / repo 每仓一把；都没有则用 fallback 全局 token）。
export async function refreshAll(truthDir, registry, fallbackToken) {
  const root = join(truthDir, "spaces");
  if (!existsSync(root)) return [];
  const out = [];
  for (const key of readdirSync(root)) {
    if (!key.startsWith("github__")) continue;
    if (!hasSessions(join(root, key))) { out.push({ space: key, skipped: "no-session" }); continue; }
    const [, owner, repo] = key.split("__");
    const token = patFor(registry, owner, repo, fallbackToken);
    let r;
    try { r = await refreshSpace(truthDir, key, token); }
    catch (e) { r = { space: key, error: String(e.message || e) }; }
    out.push(r);
    // 每个 github space 一行：失败/需补 key 用 warn（运维要看），正常用 debug（默认不刷屏）。
    if (r.error) log.warn("[code-state] space 刷新失败", { space: key, err: r.error, needsKey: r.needsKey || false });
    else if (!r.skipped) log.debug("[code-state] space 已刷新", { space: key, branches: r.branches, pulls: r.pulls, leads: r.leads });
  }
  return out;
}

// 启动时按 registry 枚举 org 的全部 repo + 单独登记的 repo → 预登记 space.yaml（无 session 也建）。
// org 用该 org 的 PAT 枚举；单独 repo 直接登记。只建元数据，code-state 走 refreshAll 懒加载。
export async function enumAndRegisterOrgRepos(truthDir, registry, fallbackToken) {
  let made = 0;
  const ensure = (owner, repo, registered) => {
    const key = `github__${owner}__${repo}`;
    const yp = join(truthDir, "spaces", key, "space.yaml");
    if (existsSync(yp)) return;                            // 已有就不动（不覆盖缓存字段）
    writeSpaceMeta(truthDir, key, { type: "github", ref: `github/${owner}/${repo}`, registered });
    made++;
  };
  for (const o of registry?.github?.orgs || []) {
    const org = typeof o === "string" ? o : o?.org;
    if (!org) continue;
    const token = patFor(registry, org, "*", fallbackToken);   // org 那把
    let repos; try { repos = await listReposInOrg(org, token); } catch (e) { log.warn("[registry] 枚举 org 失败", { org, err: e.message }); continue; }
    for (const r of repos) ensure(r.owner, r.repo, { via: "org", org });
  }
  for (const r of registry?.github?.repos || []) {
    const owner = typeof r === "string" ? r.split("/")[0] : r?.owner;
    const repo = typeof r === "string" ? r.split("/")[1] : r?.repo;
    if (owner && repo) ensure(owner, repo, { via: "repo" });
  }
  if (made) {
    await commit(truthDir, { name: "team-brain-bot", email: "bot@team-brain", message: `registry: 预登记 ${made} 个 github space`, paths: ["spaces"] });
  }
  return { registered: made };
}
