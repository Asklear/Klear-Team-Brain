/* team-brain 真相层 GUI —— 纯 vanilla、零依赖、无构建。
   模型：3 股原料（会话 session / 代码 GitHub / 文档飞书）× 3 视角（人 / 时间 / 搜索）+ 总览。
   打的全是服务器现有只读接口：/whoami /roster /ls /sessions /read /grep /log /github。
   token 只存本浏览器 localStorage，随 Authorization: Bearer 发往真相库。 */

const TOKEN_KEY = "tb_token";
const state = { me: null, roster: null, spaces: null, sesCache: null, codeState: null };
const PAGE_SIZE = 30;

/* ---------- 小工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const enc = encodeURIComponent;
const fmtDate = (s) => {
  if (!s) return "—";
  try { const d = new Date(s); if (isNaN(d)) return String(s).slice(0, 16);
    return d.toLocaleString("zh-CN", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/\//g, "-");
  } catch { return String(s).slice(0, 16); }
};
const ago = (s) => {
  if (!s) return "";
  const d = new Date(s); if (isNaN(d)) return "";
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 90) return "刚刚";
  if (sec < 3600) return Math.round(sec / 60) + " 分钟前";
  if (sec < 86400) return Math.round(sec / 3600) + " 小时前";
  if (sec < 86400 * 30) return Math.round(sec / 86400) + " 天前";
  return fmtDate(s).slice(0, 8);
};
/* 并发受限 map（总览批量读 code-state / 文档 frontmatter 用） */
async function pmap(items, fn, conc = 5) {
  const out = new Array(items.length); let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, run));
  return out;
}

/* space_key ↔ 友好显示 / GitHub 链接 */
function spaceLabel(key) {
  if (key.startsWith("github__")) { const [, owner, ...rest] = key.split("__"); return { name: `${owner}/${rest.join("__")}`, kind: "github" }; }
  if (key.startsWith("local__")) return { name: key.slice("local__".length), kind: "local" };
  return { name: key, kind: "other" };
}
const ghUrlFromRef = (ref) => { const m = /^github\/(.+)$/.exec(String(ref || "").trim()); return m ? "https://github.com/" + m[1] : ""; };
const nameOf = (id) => { const m = (state.roster || []).find((x) => x.id === id); return m ? m.name : id; };
const spaceHref = (key) => key.startsWith("github__") ? `#/repo/${enc(key)}` : `#/space/${enc(key)}`;  // github 仓 → 仓库页；其余（local）→ 个人草稿页
const kbName = (s) => s.replace(/__[A-Za-z0-9]+$/, "");                            // 知识库目录名去尾部 __<space_id>
const docName = (s) => s.replace(/--[A-Za-z0-9]+\.md$/, "").replace(/\.md$/, ""); // 文档文件名去尾部 --<node_token>.md

/* ---------- API ---------- */
async function api(path, params = {}) {
  const token = getToken();
  if (!token) { const e = new Error("未连接"); e.code = 401; throw e; }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, v);
  const url = path + (qs.toString() ? "?" + qs : "");
  let res;
  try { res = await fetch(url, { headers: { authorization: "Bearer " + token } }); }
  catch { throw new Error("网络错误 —— 连不上真相库服务器"); }
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(body?.error || `HTTP ${res.status}`); e.code = res.status; throw e; }
  return body;
}
async function getRoster() { if (state.roster) return state.roster; try { state.roster = (await api("/roster")).members || []; } catch { state.roster = []; } return state.roster; }
async function getSpaces() { if (state.spaces) return state.spaces; try { state.spaces = ((await api("/ls", { path: "spaces" })).entries || []).filter((e) => e.type === "dir"); } catch { state.spaces = []; } return state.spaces; }
// code-state 跨视图缓存（总览/仓库列表徽标/单仓 共用，避免反复 /read）→ {text, cs} 或 null
async function getCodeState(key) {
  state.codeState ||= {};
  if (key in state.codeState) return state.codeState[key];
  let v = null;
  try { const text = (await api("/read", { path: `spaces/${key}/code-state.md` })).text; v = { text, cs: parseCodeState(text) }; } catch { v = null; }
  state.codeState[key] = v; return v;
}

/* ---------- markdown 渲染（先转义再套格式，杜绝 XSS） ---------- */
// 内联：代码 / 粗 / 斜 / 链接 / 裸 URL 自动链接（裸链接用 lookbehind 避开 href 属性内的 URL）
function inlineMd(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) =>
    /^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : t);
  // 裸 URL 自动链接：用捕获前导字符代替 lookbehind（lookbehind 在老 Safari 是解析期报错 → 整站白屏）
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (_m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return s;
}
// 列表（含有序 / 嵌套，按缩进入栈）
function listBlockHtml(items) {
  let html = "";
  const stack = [];
  for (const it of items) {
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ indent: it.indent, tag });
      html += `<${tag}><li>${inlineMd(it.text)}`;
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
      const want = it.ordered ? "ol" : "ul";
      if (stack[stack.length - 1].tag !== want) {   // 同层有序↔无序切换：关旧开新，保语义
        html += `</li></${stack.pop().tag}><${want}><li>${inlineMd(it.text)}`;
        stack.push({ indent: it.indent, tag: want });
      } else html += `</li><li>${inlineMd(it.text)}`;
    }
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}
// GFM 管道表格
function tableHtml(headerLine, rows) {
  const cells = (l) => l.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(headerLine);
  let html = `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>`;
  for (const r of rows) { const c = cells(r); html += `<tr>${head.map((_, j) => `<td>${inlineMd(c[j] || "")}</td>`).join("")}</tr>`; }
  return html + "</tbody></table>";
}
function renderMd(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isHr = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const isQuote = (l) => /^\s*>\s?/.test(l);
  const isBlockStart = (l) => /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || isList(l) || isQuote(l) || isHr(l);
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码块（含语言）
    const f = line.match(/^\s*```(.*)$/);
    if (f) {
      const lang = f[1].trim(), buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`;
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { html += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`; i++; continue; }
    if (isHr(line)) { html += "<hr>"; i++; continue; }
    // 表格：当前行含 | 且下一行是【含 | 的】分隔行（GFM 要求分隔行有管道，避免把散文行+下方 --- 误判成表）
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = line; i += 2; const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
      html += tableHtml(header, rows); continue;
    }
    // 引用（连续 > 合并，递归渲染内部）
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html += `<blockquote>${renderMd(buf.join("\n"))}</blockquote>`; continue;
    }
    // 列表块
    if (isList(line)) {
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (items.length && /^\s+\S/.test(lines[i])))) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (lm) items.push({ indent: lm[1].length, ordered: /\d/.test(lm[2]), text: lm[3] });
        else items[items.length - 1].text += " " + lines[i].trim();  // 续行并入上一项
        i++;
      }
      html += listBlockHtml(items); continue;
    }
    if (!line.trim()) { i++; continue; }
    // 段落：连续非空、非块级行 → 一个 <p>，行内换行用 <br> 保留
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    html += `<p>${buf.map(inlineMd).join("<br>")}</p>`;
  }
  return html;
}
// 对话：把 transcript 的 **用户**/**助手** turn 解析成分说话人的对话块；无 turn 标记则返回 null（回退普通渲染）
function renderTurn(t) {
  const me = t.who === "用户";
  return `<div class="turn ${me ? "turn-user" : "turn-asst"}">
    <div class="turn-who">${me ? "用户" : "助手"}</div>
    <div class="turn-body doc">${renderMd(t.lines.join("\n").trim())}</div>
  </div>`;
}
function renderConversation(body, cap = Infinity) {
  const turns = []; let cur = null, inFence = false; const pre = [];
  for (const ln of String(body).split("\n")) {
    if (/^\s*```/.test(ln)) inFence = !inFence;                 // 代码块内不当 turn 边界（助手贴日志/transcript 常含 **助手**：）
    const m = !inFence && ln.match(/^\*\*(用户|助手)\*\*[：:]\s*(.*)$/);
    if (m) { cur = { who: m[1], lines: m[2] ? [m[2]] : [] }; turns.push(cur); }
    else if (cur) cur.lines.push(ln);
    else pre.push(ln);                                          // 首个 turn 之前的前导内容（别丢）
  }
  if (!turns.length) return null;
  const preHtml = pre.join("\n").trim() ? `<div class="doc">${renderMd(pre.join("\n"))}</div>` : "";
  const shown = Math.min(turns.length, cap);                    // 超长对话先渲前 cap 条，避免一次塞几千 DOM
  const more = turns.length > shown ? `<button class="btn-ghost conv-more" id="conv-expand">展开剩余 ${turns.length - shown} 条对话 ↓</button>` : "";
  return `<div class="conv">${preHtml}${turns.slice(0, shown).map(renderTurn).join("")}</div>${more}`;
}
function splitFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const ln of m[1].split("\n")) { const i = ln.indexOf(":"); if (i > 0) meta[ln.slice(0, i).trim()] = ln.slice(i + 1).trim().replace(/^["']|["']$/g, ""); }
  return { meta, body: text.slice(m[0].length) };
}
/* 解析 code-state.md（codestate.mjs 的固定结构）→ {branches, pulls, noAccess} */
function parseCodeState(text) {
  const branches = [], pulls = []; let sec = "", noAccess = /暂时读不到这个 GitHub 仓/.test(text);
  for (const line of text.split("\n")) {
    if (/^##\s*活跃分支/.test(line)) { sec = "b"; continue; }
    if (/^##\s*Open PR/.test(line)) { sec = "p"; continue; }
    if (/^##/.test(line)) { sec = ""; continue; }
    if (sec === "b") {
      const m = line.match(/^-\s*\*\*(.+?)\*\*\s*—\s*`(.+?)`\s*(.*?)[　 ]?\(([^)]*)\)(.*)$/);
      if (m) branches.push({ name: m[1], sha: m[2], msg: m[3].trim(), when: m[4], leads: /未推进度/.test(m[5]) });
    } else if (sec === "p") {
      const m = line.match(/^-\s*#(\d+)\s*(.+?)[　 ]?\((.+?)\s*→\s*(.+?)\)\s*$/);
      if (m) pulls.push({ n: m[1], title: m[2].trim(), head: m[3], base: m[4] });
    }
  }
  return { branches, pulls, noAccess };
}

/* ---------- 渲染骨架 ---------- */
const loading = (label = "加载中") => `<div class="view"><div class="notice"><span class="spinner"></span> ${esc(label)}…</div></div>`;
const loadingInline = (l = "加载中") => `<div class="notice"><span class="spinner"></span> ${esc(l)}…</div>`;
const emptyNote = (msg) => `<div class="notice"><span class="muted small">${esc(msg)}</span></div>`;  // 统一空态
function errView(e) {
  if (e.code === 401) return connectPrompt();
  return `<div class="view"><div class="notice err"><strong>出错了</strong><br>${esc(e.message)}</div></div>`;
}
function connectPrompt() {
  return `<div class="view"><div class="notice">
    <strong>先连接真相库</strong>
    <p class="muted small" style="margin:8px 0 16px">真相层是全队 session / 文档 / 代码状态的私有库，需要你的个人 token 才能浏览。</p>
    <button class="btn" onclick="openTokenModal()">连接 token</button>
  </div></div>`;
}
const crumb = (...parts) => `<div class="crumb">${parts.map((p, i) => (i ? `<span class="sep">/</span>` : "") + p).join("")}</div>`;

/* ============================================================ 总览（默认 dashboard） ============================================================ */
async function viewOverview() {
  main.innerHTML = `<div class="view">
    <div class="dash-head">
      <h1>总览</h1>
      <p class="sub">全队真相库一眼概览 —— 进展、待关注、文档、活动。</p>
    </div>
    <div class="stats" id="ov-stats">
      ${[["活跃仓库"], ["会话"], ["文档"], ["待关注"]].map(([l], i) =>
        `<div class="stat"><div class="n${i === 0 ? " accent" : ""}">—</div><div class="l">${l}</div></div>`).join("")}
    </div>

    <div class="cols2">
      <div>
        <div class="section-head"><h2>最近活动</h2><a href="#/sessions">全部会话 →</a></div>
        <div id="ov-activity">${loadingInline("加载活动")}</div>
      </div>
      <div>
        <div class="section-head"><h2>⚠️ 待关注 · 未推进度</h2><a href="#/repos">全部仓库 →</a></div>
        <div id="ov-unpushed">${loadingInline("扫描代码状态")}</div>
        <div class="section-head" style="margin-top:var(--sp-8)"><h2>最近文档</h2><a href="#/docs">飞书文档 →</a></div>
        <div id="ov-docs">${loadingInline("加载文档")}</div>
      </div>
    </div>
  </div>`;

  // 统计 + 活动（快）；待关注计数由下方扫描回填
  Promise.all([
    getSpaces(),
    api("/sessions", { limit: 1 }).catch(() => ({ total: 0 })),
    api("/log", { limit: 8 }).catch(() => ({ commits: [] })),
    api("/ls", { path: "feishu" }).catch(() => ({ entries: [] })),
  ]).then(([spaces, ses, lg, feishu]) => {
    const active = spaces.filter((e) => e.name.startsWith("github__") && e.active).length;
    const docs = (feishu.entries || []).reduce((a, e) => a + (e.children || 0), 0);
    setStat(0, active); setStat(1, ses.total ?? 0); setStat(2, docs);
    const act = $("#ov-activity");
    if (act) act.innerHTML = (lg.commits || []).length ? timelineHtml(lg.commits) : emptyNote("暂无活动");
  });

  // 未推进度：扫活跃 github 仓的 code-state（并发受限）→ 同时回填「待关注」统计
  getSpaces().then(async (spaces) => {
    const box = $("#ov-unpushed"); if (!box) return;
    const active = spaces.filter((e) => e.name.startsWith("github__") && e.active);
    if (!active.length) { box.innerHTML = emptyNote("没有活跃仓库。"); setStat(3, 0); return; }
    const rows = await pmap(active, async (sp) => {
      const v = await getCodeState(sp.name); if (!v) return null;
      const leads = v.cs.branches.filter((b) => b.leads); return leads.length ? { key: sp.name, leads } : null;
    }, 5);
    const hit = rows.filter(Boolean);
    setStat(3, hit.length, "warn");
    box.innerHTML = hit.length ? `<div class="list">${hit.map((r) => `<a class="row" href="#/repo/${enc(r.key)}">
        <div class="r-top"><span class="who">${esc(spaceLabel(r.key).name)}</span><span class="badge warn">${r.leads.length} 分支未推</span></div>
        <div class="r-meta">${r.leads.map((b) => esc(b.name)).join(" · ")}</div></a>`).join("")}</div>`
      : emptyNote("全部已推送 ✓");
  });

  // 最近文档：一次 /find?meta=1 拿全部 .md 的 frontmatter（服务端读，免客户端 N+1）
  (async () => {
    const box = $("#ov-docs"); if (!box) return;
    let files = [];
    try { files = (await api("/find", { path: "feishu", name: "*.md", meta: 1, limit: 200 })).files || []; } catch {}
    if (!files.length) { box.innerHTML = emptyNote("还没有文档镜像。"); return; }
    const docs = files.map((f) => ({ path: f.path, ...(f.meta || {}) }))
      .sort((a, b) => String(b.edited || "").localeCompare(String(a.edited || ""))).slice(0, 5);
    box.innerHTML = `<div class="list">${docs.map((d) => `<a class="row" href="#/read?path=${enc(d.path)}">
      <div class="r-top"><span class="who">📄 ${esc(d.title || d.path.split("/").pop())}</span><span class="when">${d.edited ? esc(ago(d.edited)) : ""}</span></div></a>`).join("")}</div>`;
  })();
}
// 回填某个统计格子的数字（i: 0..3；变体 warn 时数字标 amber）
function setStat(i, n, variant) {
  const cell = document.querySelectorAll("#ov-stats .stat .n")[i];
  if (!cell) return;
  cell.textContent = n;
  if (variant === "warn" && Number(n) > 0) cell.style.color = "var(--amber)";
}

/* ============================================================ 仓库 ============================================================ */
async function viewRepos() {
  main.innerHTML = loading("加载仓库");
  let spaces; try { spaces = await getSpaces(); } catch (e) { main.innerHTML = errView(e); return; }
  const gh = spaces.filter((e) => e.name.startsWith("github__"));
  const active = gh.filter((e) => e.active), reg = gh.filter((e) => !e.active);
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<span class="cur">仓库</span>`)}
    <div class="page-head"><h1>GitHub 仓库</h1><p class="sub">团队登记的仓（registry）。活跃 = 有 session；每仓的代码状态来自 4h 轮询的 code-state。</p></div>
    <div class="section-head"><h2>活跃 · ${active.length}</h2></div>
    <div class="cards" id="repos-active">${active.length ? active.map(repoCard).join("") : emptyNote("暂无活跃仓库")}</div>
    ${reg.length ? `<div class="section-head" style="margin-top:var(--sp-9)"><h2>仅登记 · ${reg.length}</h2></div><div class="cards">${reg.map(repoCard).join("")}</div>` : ""}
  </div>`;
  highlightSidebar();
  // 给活跃仓异步补「未推进度」徽标（走 code-state 缓存）
  pmap(active, async (sp) => {
    try { const v = await getCodeState(sp.name); if (!v) return;
      const leads = v.cs.branches.filter((b) => b.leads).length;
      if (leads) { const el = document.querySelector(`[data-repo="${sp.name}"] .repo-badge`); if (el) el.innerHTML = `<span class="badge warn">${leads} 未推</span>`; }
    } catch {}
  }, 5);
}
function repoCard(e) {
  const { name } = spaceLabel(e.name);
  return `<a class="card" data-repo="${esc(e.name)}" href="#/repo/${enc(e.name)}">
    <div class="ct">
      <span class="sp-dot${e.active ? " on" : ""}"></span>
      <span class="name">${esc(name)}</span><span class="tag gh">github</span><span class="repo-badge"></span>
    </div>
    <div class="cmeta">${e.active ? "活跃" : "仅登记"} · ${e.children ?? 0} 项</div>
  </a>`;
}

// code-state 区块：有结构化数据→渲染分支/PR；只有原始 md→渲染 md；都没有→提示。ghUrl 用来拼分支/commit/PR 链接。
function codeStateSection(cs, hasCS, csText, ghUrl) {
  if (cs && !cs.noAccess) {
    const branches = cs.branches.length ? cs.branches.map((b) => `<div class="branch">
        <a class="bn" href="${esc(ghUrl)}/tree/${esc(b.name)}" target="_blank" rel="noopener">${esc(b.name)}</a>
        <a class="bsha" href="${esc(ghUrl)}/commit/${esc(b.sha)}" target="_blank" rel="noopener">${esc(b.sha)}</a>
        <span class="bmsg">${esc(b.msg)}</span>
        ${b.leads ? `<span class="badge warn" title="本地 session 比最后一次 push 新">未推进度</span>` : ""}
        <span class="bwhen">${esc((b.when || "").slice(0, 16))}</span>
      </div>`).join("") : `<div class="muted small">无活跃分支（30 天内）。</div>`;
    const pulls = cs.pulls.length ? cs.pulls.map((p) => `<a class="pr" href="${esc(ghUrl)}/pull/${esc(p.n)}" target="_blank" rel="noopener">
        <span class="pn">#${esc(p.n)}</span><span style="flex:1">${esc(p.title)}</span>
        <span class="bwhen">${esc(p.head)} → ${esc(p.base)}</span></a>`).join("") : `<div class="muted small">无 Open PR。</div>`;
    return `<div class="section-head" style="margin-top:26px"><h2>活跃分支</h2></div>${branches}
      <div class="section-head" style="margin-top:22px"><h2>Open PR</h2></div>${pulls}`;
  }
  if (hasCS) return `<div class="notice" style="margin-top:22px">${renderMd(csText)}</div>`;
  return `<div class="notice" style="margin-top:22px"><span class="muted small">该仓尚无 code-state（仅登记、还没 session，或等首次 4h 轮询）。</span></div>`;
}

async function viewRepo(key) {
  main.innerHTML = loading("加载仓库");
  const { name } = spaceLabel(key);
  let entries = [];
  try { entries = (await api("/ls", { path: "spaces/" + key })).entries || []; } catch (e) { main.innerHTML = errView(e); return; }
  const hasCS = entries.some((x) => x.name === "code-state.md");
  // 元数据 / code-state / sessions 三者独立 → 并行拉（code-state 走跨视图缓存，缺的各自降级）
  const [metaR, csV, sesR] = await Promise.all([
    api("/read", { path: `spaces/${key}/space.yaml` }).catch(() => null),
    hasCS ? getCodeState(key) : Promise.resolve(null),
    api("/sessions", { space: key, limit: 200 }).catch(() => ({ sessions: [] })),
  ]);
  const meta = metaR ? (splitFm(metaR.text).meta || {}) : {};
  const csText = csV ? csV.text : "";
  const cs = csV ? csV.cs : null;
  const sessions = sesR.sessions || [];
  const ghUrl = ghUrlFromRef(meta.ref) || `https://github.com/${name}`;

  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<a href="#/repos">仓库</a>`, `<span class="cur">${esc(name)}</span>`)}
    <div class="repo-head">
      <div>
        <h1>${esc(name)}</h1>
        <div class="sub" style="margin-top:var(--sp-1)">
          ${meta.visibility ? `<span class="badge">${esc(meta.visibility)}</span> ` : ""}
          ${meta.default_branch ? `默认分支 <code>${esc(meta.default_branch)}</code> · ` : ""}${sessions.length} 条 session
        </div>
      </div>
      <a class="btn-ghost" href="${esc(ghUrl)}" target="_blank" rel="noopener">在 GitHub 打开 ↗</a>
    </div>

    ${codeStateSection(cs, hasCS, csText, ghUrl)}

    <div class="section-head" style="margin-top:var(--sp-10)"><h2>Sessions</h2><a href="#/sessions?space=${enc(key)}">在本仓筛选 →</a></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s)).join("") : emptyNote("该仓还没有 session。")}</div>
  </div>`;
  highlightSidebar();
}

/* ============================================================ 本地草稿 space（个人桶，从「人」进来） ============================================================ */
async function viewSpace(key) {
  main.innerHTML = loading("加载");
  const { name } = spaceLabel(key);
  let sessions = []; try { sessions = (await api("/sessions", { space: key, limit: 200 })).sessions || []; } catch (e) { main.innerHTML = errView(e); return; }
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<a href="#/people">人</a>`, `<span class="cur">${esc(name)} · 个人草稿</span>`)}
    <div class="page-head"><h1>${esc(name)} <span class="tag local">个人草稿桶</span></h1>
    <p class="sub">没挂 GitHub remote 的本地 session（按 folder 标签区分项目）。${sessions.length} 条。</p></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s, { showFolder: true })).join("") : emptyNote("空。")}</div>
  </div>`;
  highlightSidebar();
}

function sessionRow(s, { showRepo = false, showFolder = false } = {}) {
  const who = nameOf(s.producer_id || s.author || "?");   // 与 viewPeople 聚合键一致（producer_id 优先）
  const repo = showRepo && s.space_key ? `<span class="tag ${s.space_key.startsWith("github__") ? "gh" : "local"}">${esc(spaceLabel(s.space_key).name)}</span>` : "";
  const branch = s.branch ? ` · ${s.branch}` : "";
  const folder = showFolder && s.folder ? ` · ${s.folder}` : "";
  return `<a class="row" href="#/read?path=${enc(s.path)}">
    <div class="r-top">
      <span class="who">${esc(who)}</span>${repo}
      ${s.tool ? `<span class="tag">${esc(s.tool)}</span>` : ""}
      <span class="when">${esc(ago(s.work_end))}</span>
    </div>
    <div class="r-prev">${esc(s.preview || "(无预览)")}</div>
    <div class="r-meta">${esc(fmtDate(s.work_start))} → ${esc(fmtDate(s.work_end))}${esc(branch)}${esc(folder)}</div>
  </a>`;
}

/* ============================================================ 会话（全局浏览） ============================================================ */
async function viewSessions(q) {
  const [roster, spaces] = await Promise.all([getRoster(), getSpaces()]).catch(() => [[], []]);
  const ghRepos = (spaces || []).filter((e) => e.name.startsWith("github__"));
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<span class="cur">会话</span>`)}
    <div class="page-head"><h1>会话浏览</h1><p class="sub">全队 session 按人 / 仓库 / 时间筛选，按最近活动排序。</p></div>
    <div class="filters">
      <select id="f-author"><option value="">全部人</option>${(roster || []).map((m) => `<option value="${esc(m.id)}" ${q.author === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <select id="f-space"><option value="">全部仓库</option>${ghRepos.map((e) => `<option value="${esc(e.name)}" ${q.space === e.name ? "selected" : ""}>${esc(spaceLabel(e.name).name)}</option>`).join("")}</select>
      <input id="f-since" placeholder="自 (2026-06-01)" value="${esc(q.since || "")}">
      <button class="btn-ghost" onclick="applySessions()">筛选</button>
    </div>
    <div id="ses-list">${loadingInline()}</div>
  </div>`;
  // 一次取全量（按筛选缓存），浏览器内分页 → 切页瞬时、可前进后退、页码进 URL
  const key = JSON.stringify([q.author || "", q.space || "", q.since || ""]);
  let data;
  try {
    if (state.sesCache && state.sesCache.key === key) data = state.sesCache.data;
    else { data = await api("/sessions", { author: q.author, space: q.space, since: q.since, limit: 500 }); state.sesCache = { key, data }; }
  } catch (e) {
    if (e.code === 401) { main.innerHTML = errView(e); return; }
    $("#ses-list").innerHTML = `<div class="notice err">${esc(e.message)}</div>`; highlightSidebar(); return;
  }
  const all = data.sessions || [];
  const box = $("#ses-list");
  if (!all.length) { box.innerHTML = emptyNote("无匹配 session。"); highlightSidebar(); return; }
  const pages = Math.ceil(all.length / PAGE_SIZE);
  const cur = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  const slice = all.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  box.innerHTML = `<div class="muted small" style="margin-bottom:8px">共 ${data.total} 条${data.truncated ? `（仅取前 ${all.length}）` : ""} · 第 ${cur}/${pages} 页</div>
    <div class="list">${slice.map((s) => sessionRow(s, { showRepo: true })).join("")}</div>
    ${pagerHtml(cur, pages, q)}`;
  highlightSidebar();
}
window.applySessions = () => {
  const p = new URLSearchParams();
  for (const k of ["author", "space", "since"]) { const v = $("#f-" + k).value.trim(); if (v) p.set(k, v); }
  go("/sessions" + (p.toString() ? "?" + p : ""));   // 换筛选回到第 1 页
};
// 分页坐标：保留筛选、带上 page（page=1 省略）
function sesHref(q, page) {
  const p = new URLSearchParams();
  for (const k of ["author", "space", "since"]) if (q[k]) p.set(k, q[k]);
  if (page > 1) p.set("page", page);
  return "#/sessions" + (p.toString() ? "?" + p : "");
}
function pagerHtml(cur, pages, q) {
  if (pages <= 1) return "";
  const btn = (label, page, off) => off
    ? `<span class="pager-btn off">${label}</span>`
    : `<a class="pager-btn" href="${sesHref(q, page)}">${label}</a>`;
  let nums = "";
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - cur) <= 2)
      nums += i === cur ? `<span class="pager-btn cur">${i}</span>` : `<a class="pager-btn" href="${sesHref(q, i)}">${i}</a>`;
    else if (Math.abs(i - cur) === 3) nums += `<span class="pager-gap">…</span>`;
  }
  return `<div class="pager">${btn("← 上一页", cur - 1, cur <= 1)}${nums}${btn("下一页 →", cur + 1, cur >= pages)}</div>`;
}

/* ============================================================ 人 ============================================================ */
async function viewPeople() {
  main.innerHTML = loading("加载成员");
  let roster, recent;
  try { [roster, recent] = await Promise.all([getRoster(), api("/sessions", { limit: 200 })]); }
  catch (e) { main.innerHTML = errView(e); return; }
  // 按人聚合最近 session
  const byId = {};
  for (const s of recent.sessions || []) {
    const id = s.producer_id || s.author || "?";
    (byId[id] ||= { n: 0, last: "", repos: new Set() });
    byId[id].n++; if ((s.work_end || "") > byId[id].last) byId[id].last = s.work_end;
    if (s.space_key) byId[id].repos.add(s.space_key);
  }
  // 合并花名册 + 数据里出现过但不在册的 producer
  const ids = new Set([...(roster || []).map((m) => m.id), ...Object.keys(byId)]);
  const people = [...ids].map((id) => ({ id, name: nameOf(id), ...(byId[id] || { n: 0, last: "", repos: new Set() }) }))
    .sort((a, b) => String(b.last).localeCompare(String(a.last)));
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<span class="cur">人</span>`)}
    <div class="page-head"><h1>人</h1><p class="sub">谁在搞什么 —— 去中心化的团队认知。统计基于最近 200 条 session。</p></div>
    <div class="cards">${people.map((p) => `<a class="card" href="#/person/${enc(p.id)}">
      <div class="ct"><span class="name">${esc(p.name)}</span>${p.id !== p.name ? `<span class="tag">${esc(p.id)}</span>` : ""}</div>
      <div class="cmeta">${p.n} 条近期 session · ${p.repos.size} 个仓${p.last ? " · " + esc(ago(p.last)) : "（无近期活动）"}</div>
    </a>`).join("")}</div>
  </div>`;
  highlightSidebar();
}

async function viewPerson(id) {
  main.innerHTML = loading("加载");
  await getRoster();
  let sessions = []; try { sessions = (await api("/sessions", { author: id, limit: 300 })).sessions || []; } catch (e) { main.innerHTML = errView(e); return; }
  const repos = [...new Set(sessions.filter((s) => s.space_key?.startsWith("github__")).map((s) => s.space_key))];
  const hasLocal = sessions.some((s) => s.space_key === `local__${id}`) || (state.spaces || []).some((e) => e.name === `local__${id}`);
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<a href="#/people">人</a>`, `<span class="cur">${esc(nameOf(id))}</span>`)}
    <div class="page-head"><h1>${esc(nameOf(id))} ${id !== nameOf(id) ? `<span class="tag" style="vertical-align:middle">${esc(id)}</span>` : ""}</h1>
    <p class="sub">${sessions.length} 条 session · 碰过 ${repos.length} 个仓${hasLocal ? " · 有个人草稿" : ""}</p></div>
    ${repos.length ? `<div class="section-head"><h2>碰过的仓库</h2></div><div class="cards" style="margin-bottom:var(--sp-8)">${repos.map((k) => `<a class="card" href="#/repo/${enc(k)}"><div class="ct"><span class="name">${esc(spaceLabel(k).name)}</span><span class="tag gh">github</span></div></a>`).join("")}${hasLocal ? `<a class="card" href="#/space/${enc("local__" + id)}"><div class="ct"><span class="name">${esc(id)}</span><span class="tag local">个人草稿</span></div></a>` : ""}</div>` : ""}
    <div class="section-head"><h2>最近 session</h2></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s, { showRepo: true, showFolder: true })).join("") : emptyNote("无 session。")}</div>
  </div>`;
  highlightSidebar();
}

/* ============================================================ 活动流（时间线零件，总览复用） ============================================================ */
function timelineHtml(commits) {
  return `<div class="timeline">${commits.map((c) => {
    const m = c.subject.match(/spaces\/[A-Za-z0-9_./-]+\.(?:md|jsonl)/) || c.subject.match(/(github__|local__)[A-Za-z0-9_-]+/);
    const link = m ? (m[0].startsWith("spaces/") ? `#/read?path=${enc(m[0])}` : spaceHref(m[0])) : "";
    const inner = `<div class="tl-when" title="${esc(c.date)}">${esc(ago(c.date))}</div>
      <div><div class="tl-sub">${esc(c.subject)}</div><div class="tl-meta"><span class="sha">${esc(c.sha)}</span> · ${esc(nameOf(c.author))}</div></div>`;
    return link ? `<a class="tl-row" href="${esc(link)}">${inner}</a>` : `<div class="tl-row">${inner}</div>`;
  }).join("")}</div>`;
}
/* ============================================================ 搜索 ============================================================ */
async function viewSearch(q) {
  const term = q.q || "", space = q.space || "";
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<span class="cur">搜索</span>`, ...(space ? [`<span>${esc(spaceLabel(space).name)}</span>`] : []))}
    <div class="page-head"><h1>搜索真相库</h1><p class="sub">git grep 全文检索全队 session（脱敏 transcript）与飞书文档。支持正则。</p></div>
    <div class="filters">
      <input id="s-q" placeholder="正则 / 关键词…" value="${esc(term)}" style="flex:1;min-width:240px" autofocus>
      <label class="muted small" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="s-raw" ${q.raw ? "checked" : ""}> 连原文 jsonl</label>
      <button class="btn" onclick="applySearch()">搜索</button>
    </div>
    <div id="gres">${term ? loadingInline("搜索中") : `<div class="muted small">输入关键词开始搜索。</div>`}</div>
  </div>`;
  $("#s-q")?.addEventListener("keydown", (e) => { if (e.key === "Enter") applySearch(); });
  if (!term) { highlightSidebar(); return; }
  try { $("#gres").innerHTML = grepResults(await api("/grep", { q: term, space, raw: q.raw ? 1 : 0, context: 1 }), term); }
  catch (e) { if (e.code === 401) { main.innerHTML = errView(e); return; } $("#gres").innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  highlightSidebar();
}
window.applySearch = () => {
  const term = $("#s-q").value.trim(); if (!term) return;
  const p = new URLSearchParams({ q: term });
  if ($("#s-raw")?.checked) p.set("raw", "1");
  const sp = new URLSearchParams(location.hash.split("?")[1] || "").get("space");
  if (sp) p.set("space", sp);
  go("/search?" + p);
};
function grepResults(r, term) {
  const text = (r.matches || "").trim();
  if (!text) return emptyNote("无匹配。");
  const groups = new Map();
  for (const line of text.split("\n")) {
    if (line === "--") continue;
    const m = line.match(/^(.+?)([:-])(\d+)\2(.*)$/);
    if (!m) continue;
    const [, path, sep, ln, content] = m;
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push({ ln, content, hit: sep === ":" });
  }
  let re = null; try { re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"); } catch {}
  const html = [...groups.entries()].map(([path, lines]) => {
    const isMd = path.endsWith(".md");
    const lineHtml = lines.map((l) => {
      let c = esc(l.content); if (l.hit && re) c = c.replace(re, "<mark>$1</mark>");
      return `<div class="gline ${l.hit ? "hit" : ""}"><span class="ln">${esc(l.ln)}</span><span class="lt">${c}</span></div>`;
    }).join("");
    const n = lines.filter((l) => l.hit).length;
    const head = isMd
      ? `<a class="gf-head" href="#/read?path=${enc(path)}"><span class="gf-path">${esc(path)}</span><span class="gf-n">${n} 命中</span></a>`
      : `<div class="gf-head"><span class="gf-path">${esc(path)}</span><span class="gf-n">${n} 命中</span></div>`;
    return `<div class="gfile">${head}${lineHtml}</div>`;
  }).join("");
  return `<div class="gres">${r.truncated ? `<div class="muted small" style="margin-bottom:4px">结果已截断（命中过多，缩小范围看更全）。</div>` : ""}${html}</div>`;
}

/* ============================================================ 读文件（session / 文档 / code-state） ============================================================ */
async function viewRead(q) {
  const path = q.path || "";
  if (!path) { main.innerHTML = errView(new Error("缺少 path")); return; }
  main.innerHTML = loading("读取");
  let data; try { [data] = await Promise.all([api("/read", { path }), getRoster()]); } catch (e) { main.innerHTML = errView(e); return; }
  const { meta, body } = splitFm(data.text);
  const parts = path.split("/");
  const spaceKey = parts[0] === "spaces" ? parts[1] : null;
  const branch = spaceKey && parts[2] === "sessions" ? parts[3] : null;
  const isSession = spaceKey && parts[2] === "sessions";
  const conv = isSession ? renderConversation(body, 80) : null;   // session → 分说话人对话块（超长先渲前 80 条）；否则普通文档
  const title = meta.title || parts[parts.length - 1];
  // session：链回它所属仓库 + 分支（github）
  let ghLink = "";
  if (spaceKey?.startsWith("github__")) {
    const base = `https://github.com/${spaceLabel(spaceKey).name}`;
    ghLink = `<a class="btn-ghost" href="${esc(branch ? base + "/tree/" + branch : base)}" target="_blank" rel="noopener">GitHub${branch ? " · " + esc(branch) : ""} ↗</a>`;
  }
  const crumbParts = [`<a href="#/">总览</a>`];
  if (spaceKey) crumbParts.push(`<a href="${spaceHref(spaceKey)}">${esc(spaceLabel(spaceKey).name)}</a>`);
  else if (parts[0] === "feishu") crumbParts.push(`<a href="#/docs">文档</a>`);
  crumbParts.push(`<span class="cur">${esc(parts[parts.length - 1])}</span>`);

  main.innerHTML = `<div class="view">
    ${crumb(...crumbParts)}
    <div class="repo-head">
      <h1 style="line-height:1.3">${esc(title)}</h1>
      <div style="display:flex;gap:8px">${ghLink}${meta.url && /^https?:/.test(meta.url) ? `<a class="btn-ghost" href="${esc(meta.url)}" target="_blank" rel="noopener">在飞书打开 ↗</a>` : ""}</div>
    </div>
    ${Object.keys(meta).length ? `<div class="meta-card">${metaCard(meta)}</div>` : ""}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--sp-4)"><button class="raw-toggle" id="raw-toggle" type="button">显示原文</button></div>
    <div id="doc-body">${conv || `<div class="doc">${renderMd(body)}</div>`}</div>
    <div class="raw" id="raw-body" hidden><pre><code>${esc(data.text)}</code></pre></div>
  </div>`;
  $("#conv-expand")?.addEventListener("click", () => { $("#doc-body").innerHTML = renderConversation(body); });  // 展开全部对话
  const tog = $("#raw-toggle");
  tog.addEventListener("click", () => {
    const raw = $("#raw-body"), doc = $("#doc-body"), hidden = raw.hasAttribute("hidden");
    raw.toggleAttribute("hidden", !hidden); doc.toggleAttribute("hidden", hidden);
    tog.textContent = hidden ? "显示渲染" : "显示原文";
  });
  highlightSidebar();
}
function metaCard(meta) {
  const order = ["producer", "submitter", "author", "space_key", "branch", "folder", "tool", "date", "updated", "url", "edited", "ref", "visibility", "default_branch"];
  const keys = [...new Set([...order.filter((k) => meta[k]), ...Object.keys(meta)])];
  return keys.map((k) => {
    let v = meta[k]; if (!v) return "";
    if ((k === "url") && /^https?:/.test(v)) v = `<a href="${esc(v)}" target="_blank" rel="noopener">飞书原文 ↗</a>`;
    else if ((k === "date" || k === "updated" || k === "edited") && /\d{4}/.test(v)) v = esc(fmtDate(v));
    else v = esc(v);
    return `<div><div class="mk">${esc(k)}</div><div class="mv">${v}</div></div>`;
  }).join("");
}

/* ============================================================ 文档（飞书） ============================================================ */
async function viewDocs(q) {
  const path = q.path || "feishu";
  main.innerHTML = loading("加载文档");
  let entries;
  try { entries = (await api("/ls", { path })).entries || []; }
  catch (e) {
    if (e.code === 401) { main.innerHTML = errView(e); return; }
    main.innerHTML = `<div class="view">${crumb(`<a href="#/">总览</a>`, `<span class="cur">文档</span>`)}
      <div class="notice">还没有飞书文档镜像。<p class="muted small" style="margin-top:8px">服务器配了 <code>feishu.yaml</code> 并把应用加进知识库后，每 4h 自动镜像进来。</p></div></div>`;
    highlightSidebar(); return;
  }
  const rel = path.replace(/^feishu\/?/, "");
  const dirs = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  const segCrumbs = rel ? rel.split("/").map((seg, i, arr) => { const p = "feishu/" + arr.slice(0, i + 1).join("/"); return i === arr.length - 1 ? `<span class="cur">${esc(kbName(seg))}</span>` : `<a href="#/docs?path=${enc(p)}">${esc(kbName(seg))}</a>`; }) : [];
  main.innerHTML = `<div class="view">
    ${crumb(`<a href="#/">总览</a>`, `<a href="#/docs">文档</a>`, ...segCrumbs)}
    <div class="page-head"><h1>${rel ? esc(kbName(rel.split("/").pop())) : "飞书文档"}</h1></div>
    ${dirs.length ? `<div class="section-head"><h2>知识库 / 目录</h2></div><div class="cards" style="margin-bottom:var(--sp-9)">${dirs.map((d) => `<a class="card" href="#/docs?path=${enc(path.replace(/\/$/, "") + "/" + d.name)}"><div class="ct"><span class="name">📚 ${esc(kbName(d.name))}</span></div><div class="cmeta">${d.children ?? 0} 项</div></a>`).join("")}</div>` : ""}
    ${files.length ? `<div class="section-head"><h2>文档</h2></div><div class="list">${files.map((f) => `<a class="row" href="#/read?path=${enc(path.replace(/\/$/, "") + "/" + f.name)}"><div class="r-prev">📄 ${esc(docName(f.name))}</div></a>`).join("")}</div>` : ""}
    ${!dirs.length && !files.length ? emptyNote("此处为空。") : ""}
  </div>`;
  highlightSidebar();
}

/* ============================================================ 侧栏 ============================================================ */
async function loadSidebar() {
  const box = $("#spaces-list");
  if (!getToken()) { box.innerHTML = `<div class="muted small pad">连接后显示仓库</div>`; return; }
  let spaces; try { spaces = await getSpaces(); } catch { box.innerHTML = `<div class="muted small pad">加载失败</div>`; return; }
  const gh = spaces.filter((e) => e.name.startsWith("github__"));
  const active = gh.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name));
  box.innerHTML = (active.length ? active.map(spaceRowSide).join("") : `<div class="muted small pad">暂无活跃仓库</div>`)
    + `<a class="space-row" href="#/repos" style="color:var(--muted)"><span class="sp-name">查看全部仓库 →</span></a>`;
  highlightSidebar();
}
function spaceRowSide(e) {
  return `<a class="space-row is-active" data-key="${esc(e.name)}" href="#/repo/${enc(e.name)}">
    <span class="sp-dot"></span><span class="sp-name">${esc(spaceLabel(e.name).name)}</span><span class="sp-count">${e.children ?? 0}</span>
  </a>`;
}
function highlightSidebar() {
  const { path } = parseHash();
  let seg = "/" + (path.split("/")[1] || "");
  const map = { "/repo": "/repos", "/person": "/people", "/space": "/people" };  // 详情页归到对应主导航项
  seg = map[seg] || seg;
  document.querySelectorAll(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.nav === seg));
  const key = path.startsWith("/repo/") ? decodeURIComponent(path.slice("/repo/".length)) : null;
  document.querySelectorAll(".space-row").forEach((r) => r.classList.toggle("active", r.dataset.key === key));
}

/* ============================================================ 路由 ============================================================ */
function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const q = {}; new URLSearchParams(qs || "").forEach((v, k) => (q[k] = v));
  return { path: path || "/", q };
}
window.go = (to) => { location.hash = "#" + (to.startsWith("/") ? to : "/" + to); };
async function route() {
  const { path, q } = parseHash();
  window.scrollTo(0, 0);
  try {
    if (path === "/" || path === "") return void await viewOverview();
    if (path === "/repos") return void await viewRepos();
    if (path.startsWith("/repo/")) return void await viewRepo(decodeURIComponent(path.slice("/repo/".length)));
    if (path === "/sessions") return void await viewSessions(q);
    if (path === "/people") return void await viewPeople();
    if (path.startsWith("/person/")) return void await viewPerson(decodeURIComponent(path.slice("/person/".length)));
    if (path === "/docs") return void await viewDocs(q);
    if (path === "/search") return void await viewSearch(q);
    if (path === "/read") return void await viewRead(q);
    if (path.startsWith("/space/")) return void await viewSpace(decodeURIComponent(path.slice("/space/".length)));
    main.innerHTML = `<div class="view"><div class="notice">未知页面。<a href="#/" style="color:var(--green)">回总览</a></div></div>`;
  } catch (e) { main.innerHTML = errView(e); }
}

/* ============================================================ token ============================================================ */
function refreshTokenChip() {
  const chip = $("#token-chip"), label = $("#token-label");
  if (state.me) { chip.classList.add("on"); label.textContent = state.me.name || state.me.id; }
  else { chip.classList.remove("on"); label.textContent = getToken() ? "token 无效" : "未连接"; }
}
let lastFocus = null;
function openTokenModal() {
  lastFocus = document.activeElement;
  $("#token-input").value = getToken();
  $("#token-err").hidden = true;
  $("#token-modal").hidden = false;
  $("#token-input").focus();
}
window.openTokenModal = openTokenModal;
const closeTokenModal = () => { $("#token-modal").hidden = true; if (lastFocus?.focus) { lastFocus.focus(); lastFocus = null; } };
// 焦点陷阱：弹层打开时 Tab 在内部循环，不跑到背后页面
function trapFocus(e) {
  if (e.key !== "Tab" || $("#token-modal").hidden) return;
  const f = [...$("#token-modal").querySelectorAll("input,button")].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
async function whoami() { if (!getToken()) { state.me = null; refreshTokenChip(); return; } try { state.me = await api("/whoami"); } catch { state.me = null; } refreshTokenChip(); }
// caps 先留着（决定将来顶栏框是「问一句」还是「搜索」）；问一句暂降级成搜索，无独立导航项
function resetCaches() { state.roster = null; state.spaces = null; state.sesCache = null; state.codeState = null; }

async function init() {
  $("#token-chip").addEventListener("click", openTokenModal);
  $("#token-save").addEventListener("click", async () => {
    const v = $("#token-input").value.trim(); if (!v) return;
    localStorage.setItem(TOKEN_KEY, v); resetCaches();
    const err = $("#token-err"); err.hidden = true;
    const btn = $("#token-save"); btn.disabled = true; btn.textContent = "验证中…";
    try { state.me = await api("/whoami"); refreshTokenChip(); closeTokenModal(); await loadSidebar(); route(); }
    catch (e) { state.me = null; refreshTokenChip(); err.textContent = e.code === 401 ? "token 无效，检查后重试。" : e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "连接"; }
  });
  $("#token-clear").addEventListener("click", () => { localStorage.removeItem(TOKEN_KEY); state.me = null; resetCaches(); refreshTokenChip(); closeTokenModal(); loadSidebar(); route(); });
  $("#token-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#token-save").click(); });
  $("#token-modal").addEventListener("keydown", trapFocus);
  $("#token-modal").addEventListener("click", (e) => { if (e.target.id === "token-modal") closeTokenModal(); });

  // 窄屏抽屉：汉堡开/关；点遮罩或点导航/仓库项即关
  const setNav = (open) => { document.body.classList.toggle("nav-open", open); $("#nav-toggle")?.setAttribute("aria-expanded", String(open)); };
  $("#nav-toggle")?.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
  $("#nav-scrim")?.addEventListener("click", () => setNav(false));
  $("#sidebar")?.addEventListener("click", (e) => { if (e.target.closest("a, .space-row")) setNav(false); });

  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#search-input").value.trim(); if (v) go("/search?q=" + enc(v)); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("#search-input").focus(); }
    if (e.key === "Escape") { closeTokenModal(); document.body.classList.remove("nav-open"); }
  });

  window.addEventListener("hashchange", route);
  await whoami();
  await loadSidebar();
  route();
  if (!getToken()) openTokenModal();
}
init();
