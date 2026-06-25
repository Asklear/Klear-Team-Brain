// 本机足迹查看器前端。默认英文，可切中文（localStorage tb_lang）。数据来自常驻内嵌的 127.0.0.1 /api/*。
// 本机 loopback，不需要 token 登录（服务端靠 Host/Origin 守卫挡跨站 + DNS-rebind）。
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ic = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
const shortTime = (t) => { if (!t) return "—"; const s = String(t); return s.includes("T") ? s.replace("T", " ").slice(0, 16) : s.slice(0, 16); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- i18n ----------
let LANG = localStorage.getItem("tb_lang") || "en";
const T = {
  "ribbon.local": ["Local console", "本机控制台"],
  "ribbon.host": ["127.0.0.1 · only you can see this · not the shared library", "127.0.0.1 · 仅你自己可见 · 不是线上共享库"],
  "ribbon.onlinePre": ["Online", "对应线上"],
  "brand.name": ["Team Brain", "团队大脑"],
  "nav.overview": ["Overview", "概览"], "nav.sessions": ["My Sessions", "我的 Session"], "nav.log": ["Activity", "活动日志"], "nav.config": ["Collection", "采集配置"],
  "foot.collector": ["Collector", "采集常驻"], "foot.collectorRun": ["Collector · running", "采集常驻 · 运行中"],
  "foot.sync": ["synced {t}", "同步 {t}"], "foot.noSync": ["no sync yet", "尚无同步"],
  "who": ["{name}'s local footprint", "{name} 的本机足迹"],
  "ov.title": ["Overview", "概览"],
  "ov.sub": ["What this machine has published to the team's shared library — at a glance, retractable anytime.", "team-brain 从这台机器往全队共享库发布了什么 —— 一眼看清，随时可撤。"],
  "ov.what": ["This page lives <b>only on your machine</b> (127.0.0.1) and <b>only you can see it</b>. It governs <span class=\"g\">what the collector uploads from this computer to the team's shared library</span>. Preview and exclude happen locally; only <b>Retract</b> reaches the shared library to delete an entry.",
    "这个页面<b>只在你本机</b>（127.0.0.1）、<b>只有你能看</b>。它管的是「<span class=\"g\">采集常驻从这台电脑上传到全队共享库的内容</span>」。预览、排除都在本地发生；点「撤回」才会去线上库删掉对应那条。"],
  "ov.recent": ["Recent activity", "最近活动"],
  "ov.headCap": ["sessions have entered the team's shared library from this machine", "条 session 已从这台机器进入全队共享库"],
  "ov.headPending": ["another {n} in debounce, uploading soon", "另有 {n} 条正在去抖、即将上传"],
  "ov.headLocal": ["{n} in local ledger", "本机账本共 {n} 条"],
  "ov.headSkip": ["{n} skipped / out of scope", "跳过 / 未在范围 {n} 条"],
  "ov.recentEmpty": ["None yet.", "暂无。"],
  "ov.countNote": ["Counts are reconstructed from sessions still on this machine, so they can be fewer than the shared library (which keeps everything ever uploaded, including sessions whose local files were since removed). The shared library is the source of truth.",
    "计数是按本机现存的 session 重建的，可能比线上共享库少（共享库保留历来上传的全部，含本机源文件已删除的）。以线上共享库为准。"],
  "ses.title": ["My Sessions", "我的 Session"],
  "ses.sub": ["Conversations already in / about to enter the shared library. Click any to see exactly what teammates see.", "已进入 / 即将进入全队共享库的对话。点任意一条，看队友实际会看到的样子。"],
  "th.status": ["Status", "状态"], "th.intent": ["Intent", "意图"], "th.tool": ["Tool", "工具"], "th.coord": ["Location", "在库位置"], "th.time": ["Worked", "干活时间"],
  "ses.note": ["Only sessions in / entering the library are listed. Out-of-scope, skipped, or retracted ones are hidden.", "只列「在库 / 将入库」的。不在采集范围、被跳过、已撤回的不显示。"],
  "ses.empty": ["No sessions in the shared library yet. New conversations appear here once they settle.", "还没有进入共享库的 session。新对话稳定后会自动出现在这里。"],
  "badge.uploaded": ["In library", "已在库"], "badge.pending": ["Uploading", "即将上传"],
  "log.title": ["Activity", "活动日志"],
  "log.sub": ["What the collector has been doing recently — same source as `brain logs`. Idle ticks are hidden.", "采集常驻最近做了什么（和 brain logs 同源）。无事发生的空转已隐藏。"],
  "log.empty": ["Nothing meaningful yet (collector just started / no uploads).", "还没有有意义的活动（常驻刚起 / 没传过东西）。"],
  "cfg.title": ["Collection Settings", "采集配置"],
  "cfg.sub": ["What's collected, where it goes, what's masked before upload. All changes affect this machine only.", "我在采什么、传到哪、上传前再抹掉什么。所有改动只影响这台机器。"],
  "conn.title": ["Connection", "连接"],
  "conn.server": ["Server", "服务器"], "conn.identity": ["Identity", "身份"],
  "conn.token": ["Your token", "你的 token"],
  "conn.tokenHint": ["paste it into the shared-library website to sign in — no need to memorize it", "粘到线上共享库网站登录用 —— 不用记"],
  "conn.copy": ["Copy", "复制"], "conn.copied": ["Token copied to clipboard", "已复制 token 到剪贴板"], "conn.reveal": ["Reveal", "显示"], "conn.hide": ["Hide", "隐藏"],
  "cfg.scope": ["Collection scope", "采集范围"],
  "cfg.scopeWl": ["Whitelist only", "仅白名单目录"], "cfg.scopeWlDesc": ["Only sessions under the listed folders are uploaded; the rest stay on this machine.", "只有列出的目录下的 session 才会上传，其余留在本机。"],
  "cfg.scopeAll": ["All sessions", "采集本机全部"], "cfg.scopeAllDesc": ["Every project's sessions are uploaded, including unlisted ones.", "所有项目的 session 都会传，含没列出的。"],
  "cfg.noWhitelist": ["(no whitelist set)", "（未设置白名单）"], "cfg.addFolder": ["Add upload folder", "添加上传目录"],
  "cfg.exclude": ["Excluded subtrees", "排除子树"], "cfg.excludeX": ["· not uploaded even within the whitelist", "· 白名单内也不传"], "cfg.none": ["(none)", "（无）"], "cfg.addExclude": ["Add excluded folder", "添加排除目录"],
  "cfg.sources": ["Collection sources", "采集来源"],
  "src.ccDesc": ["~/.claude/projects · main source", "~/.claude/projects · 主力来源"], "src.codexDesc": ["~/.codex/sessions", "~/.codex/sessions"], "src.traeDesc": ["~/.trae-cn/memory", "~/.trae-cn/memory"], "src.shDesc": ["session_history docs within the whitelist", "白名单内的 session_history 文档"],
  "cfg.redact": ["Redaction", "脱敏"], "cfg.redactX": ["· masked before upload", "· 上传前抹除敏感内容"],
  "cfg.builtinIntro": ["The following keys / credentials / paths are <b>automatically</b> masked to [REDACTED] before upload:", "以下密钥 / 凭据 / 路径上传前<b>自动</b>替换为 [REDACTED]："],
  "cfg.wordlist": ["Personal redaction list · custom, local only", "个人脱敏词表 · 自定义、只存本机"],
  "cfg.wordlistEmpty": ["Add customer names, your real name, internal code names — covering content-level things the built-in rules can't.", "把客户名、真名、内部代号加进来，补内置规则覆盖不到的内容级。"],
  "cfg.addTerm": ["Add term / regex (/.../ for regex)", "添加词条 / 正则（/.../ 为正则）"],
  "cfg.hitCount": ["{n} hits / {s} sessions", "本机命中 {n} 处 / {s} 条"],
  "cfg.timing": ["Timing", "时机"], "cfg.interval": ["Scan interval", "扫描间隔"], "cfg.debounce": ["Debounce", "去抖"],
  "cfg.unsaved": ["Unsaved changes …", "有未保存改动 …"],
  "cfg.delta": ["Unsaved · this would <b class=\"up\">add {a}</b>, <b class=\"dn\">stop {s}</b>", "有未保存改动 · 这么改会 <b class=\"up\">多传 {a} 条</b>、<b class=\"dn\">少传 {s} 条</b>"],
  "cfg.discard": ["Discard", "放弃"], "cfg.save": ["Save", "保存"],
  "type.text": ["text", "文本"], "type.regex": ["regex", "正则"],
  "dr.tabRed": ["Redacted (what teammates see)", "脱敏后（队友看到的）"], "dr.tabRaw": ["Local original", "本机原文"],
  "dr.hintRetract": ["Retract = delete from the shared library and stop uploading (git history is still recoverable)", "撤回 = 从共享库删掉并不再上传（git 历史仍可考古）"],
  "dr.hintExclude": ["Exclude = never upload this one", "排除 = 本机永不上传这条"],
  "dr.retract": ["Retract from library", "从库中撤回"], "dr.exclude": ["Exclude (don't upload)", "排除（不上传）"],
  "dr.truncated": ["· original truncated", "· 原文已截断"], "dr.loading": ["Loading…", "加载中…"], "dr.cantOpen": ["Can't open", "打不开"], "dr.loadFail": ["Load failed: {e}", "加载失败：{e}"],
  "confirm.retract": ["Retract this from the team's shared library and add to the local exclude list?", "从全队共享库撤回这条，并加入本机排除名单？"],
  "confirm.exclude": ["Add this to the local exclude list so it's never uploaded?", "把这条加入本机排除名单，永不上传？"],
  "toast.retracted": ["Retracted and excluded", "已撤回并排除"], "toast.excludeOnly": ["Excluded", "已排除"],
  "toast.retractPartial": ["Excluded (retract incomplete: {e})", "已排除（撤回未完成：{e}）"],
  "toast.opFail": ["Action failed: {e}", "操作失败：{e}"],
  "toast.termAdded": ["Added to personal redaction list (applies to new uploads)", "已加入个人脱敏词表（对新上传生效）"],
  "toast.saved": ["Saved. Toggles apply immediately; folder-scope changes fully apply after restarting the collector.", "已保存。开关类即时生效；采集范围(目录)改动在 brain service restart 后完整生效。"],
  "prompt.addFolder": ["Absolute path of folder to collect (~ ok)", "要采集的目录绝对路径（~ 也行）"],
  "prompt.addExclude": ["Absolute path of folder to exclude", "要排除的目录绝对路径"],
  "prompt.addTerm": ["Word / regex (use /pattern/flags for regex, e.g. /acme-\\w+/i)", "词 / 正则（用 /pattern/flags 表示正则，如 /acme-\\w+/i）"],
  "connFail": ["Connection failed", "连接失败"],
  "connFailSub": ["{e}. Make sure the collector is running (`brain status`), then reopen with `brain viewer`.", "{e}。确认采集常驻在跑（brain status），再用 brain viewer 打开。"],
};
const BUILTIN = {
  en: ["API Key (sk-…)", "GitHub PAT", "GitLab token", "AWS", "Google", "Slack", "Stripe", "JWT", "Private key (PEM)", "password/token assignments", "credentials in URLs", "home paths → ~"],
  zh: ["API Key (sk-…)", "GitHub PAT", "GitLab Token", "AWS", "Google", "Slack", "Stripe", "JWT", "私钥 (PEM)", "password/token 赋值", "URL 内账密", "家目录路径 → ~"],
};
const L = () => (LANG === "zh" ? 1 : 0);
function t(key, vars) { let s = (T[key] && T[key][L()]) ?? key; if (vars) for (const k in vars) s = s.replaceAll("{" + k + "}", vars[k]); return s; }

function applyStatic() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  document.title = LANG === "zh" ? "团队大脑 · 本机控制台" : "Team Brain · Local Console";
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.getAttribute("data-i18n-html")); });
  $("langtog").textContent = LANG === "zh" ? "EN" : "中文";
}

// ---------- API ----------
async function api(p) {
  const r = await fetch(p);
  if (!r.ok) { let e = {}; try { e = await r.json(); } catch {} throw new Error(e.error || ("HTTP " + r.status)); }
  return r.json();
}
async function apiPost(p, body) {
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) { let e = {}; try { e = await r.json(); } catch {} throw new Error(e.error || ("HTTP " + r.status)); }
  return r.json();
}
let toastT;
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 2800); }

let SESSIONS = { uploaded: [], pending: [] };
let CUR = null, CFG = null, WCFG = null, REDACT = { terms: [] }, OV = null;
let CONN = { server_url: "", device_token: "", me: {} }, TOK_SHOWN = false;

// ---------- overview ----------
function renderOverview(d) {
  OV = d;
  CONN = { server_url: d.server_url || "", device_token: d.device_token || "", me: d.me || {} };
  $("sb-who").textContent = t("who", { name: d.me?.name || d.me?.id || (LANG === "zh" ? "本机" : "this machine") });
  $("sb-n").textContent = d.counts.uploaded + d.counts.pending;
  $("sb-run").textContent = t("foot.collectorRun");
  $("sb-sync").textContent = d.lastSync ? t("foot.sync", { t: d.lastSync.slice(0, 19).replace("T", " ").slice(11) }) : t("foot.noSync");
  $("sb-ver").textContent = `${d.me?.id || ""} · ${d.version}`;
  if (d.server_url) { const a = $("rb-online"); a.textContent = d.server_url.replace(/^https?:\/\//, ""); a.href = d.server_url; }
  $("ov-headline").innerHTML = `<div class="headline">
    <span class="big">${d.counts.uploaded}</span>
    <span class="cap">${t("ov.headCap")}<br><span class="d">${t("ov.headPending", { n: d.counts.pending })}</span></span>
    <span class="small">${t("ov.headLocal", { n: d.counts.localTotal })}<br>${t("ov.headSkip", { n: d.counts.skipped })}</span></div>`;
}

// ---------- sessions ----------
const badge = (st) => st === "pending"
  ? `<span class="badge b-wait">${ic("i-clock")}${t("badge.pending")}</span>`
  : `<span class="badge b-up">${ic("i-check")}${t("badge.uploaded")}</span>`;
const rowHtml = (r) => `<tr data-file="${esc(r.file)}"><td>${badge(r.status)}</td><td class="intent">${esc(r.intent)}</td><td class="tool">${esc(r.tool)}</td><td class="meta">${esc(r.coord)}</td><td class="meta">${shortTime(r.time)}</td></tr>`;
function renderSessions() {
  const rows = [...SESSIONS.pending, ...SESSIONS.uploaded];
  $("sb-n").textContent = rows.length;
  $("rows").innerHTML = rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="5"><div class="empty">${t("ses.empty")}</div></td></tr>`;
  const top = SESSIONS.uploaded.slice(0, 3);
  $("ov-recent").innerHTML = top.length
    ? `<table><tbody>${top.map((r) => `<tr data-file="${esc(r.file)}"><td class="meta" style="width:120px">${shortTime(r.time)}</td><td class="intent">${esc(r.intent)}</td><td class="meta">${esc(r.coord)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="ok">${t("ov.recentEmpty")}</div>`;
}

// ---------- log ----------
let LOGLINES = [];
function renderLog(lines) {
  LOGLINES = lines || [];
  if (!LOGLINES.length) { $("logbox").innerHTML = `<div class="empty">${t("log.empty")}</div>`; return; }
  $("logbox").innerHTML = LOGLINES.slice().reverse().map((l) => {
    const m = l.match(/^(\S+)\s+(\w+)\s+([\s\S]*)$/);
    if (!m) return `<div class="logline"><span class="msg">${esc(l)}</span></div>`;
    const [, ts, lv, msg] = m;
    return `<div class="logline"><span class="ts">${esc(ts.slice(0, 19).replace("T", " "))}</span><span class="lv lv-${esc(lv)}">${esc(lv)}</span><span class="msg">${esc(msg)}</span></div>`;
  }).join("");
}

// ---------- config ----------
const dirty = () => WCFG && CFG && JSON.stringify(WCFG) !== JSON.stringify(CFG);
function renderConfig() {
  if (!WCFG) return;
  const wl = !WCFG.collect_all, folders = WCFG.upload_folders || [], excl = WCFG.exclude || [];
  const tog = (key) => `<span class="toggle ${WCFG[key] === false ? "off" : ""}" data-act="toggle" data-key="${key}"></span>`;
  const tk = CONN.device_token, tkShow = tk ? (TOK_SHOWN ? tk : tk.slice(0, 4) + "••••••••" + tk.slice(-4)) : "-";
  let h = `<div class="sech">${ic("i-lock")}${t("conn.title")}</div>
  <div class="card">
    <div class="row"><div class="lab">${t("conn.server")}</div><div><code>${esc(CONN.server_url)}</code></div></div>
    <div class="row"><div class="lab">${t("conn.identity")}</div><div><code>${esc(CONN.me.id || "")}</code> ${esc(CONN.me.name || "")}</div></div>
    <div class="row"><div class="lab">${t("conn.token")}<small>${t("conn.tokenHint")}</small></div><div class="tokbox"><code>${esc(tkShow)}</code><button class="btn sm" data-act="revealtok">${TOK_SHOWN ? t("conn.hide") : t("conn.reveal")}</button><button class="btn sm" data-act="copytok">${t("conn.copy")}</button></div></div>
  </div>
  <div class="sech">${ic("i-folder")}${t("cfg.scope")}</div>
  <div class="scope">
    <div class="opt ${wl ? "on" : ""}" data-act="scope" data-val="wl"><div class="tt">${ic("i-folder")}${t("cfg.scopeWl")}</div><div class="ds">${t("cfg.scopeWlDesc")}</div></div>
    <div class="opt ${wl ? "" : "on"}" data-act="scope" data-val="all"><div class="tt">${ic("i-layers")}${t("cfg.scopeAll")}</div><div class="ds">${t("cfg.scopeAllDesc")}</div></div>
  </div>
  <div class="card" style="${wl ? "" : "opacity:.45"}">${folders.length ? folders.map((f, i) => `<div class="listrow">${ic("i-folder")}<span class="path"><code>${esc(f)}</code></span><div class="right"><button class="iconbtn" data-act="rmfolder" data-i="${i}">${ic("i-trash")}</button></div></div>`).join("") : `<div class="listrow"><span class="path" style="color:var(--muted-soft)">${t("cfg.noWhitelist")}</span></div>`}<div class="addrow" data-act="addfolder">${ic("i-plus")}${t("cfg.addFolder")}</div></div>`;
  h += `<div class="sech">${ic("i-ban")}${t("cfg.exclude")}<span class="x">${t("cfg.excludeX")}</span></div><div class="card">${excl.length ? excl.map((f, i) => `<div class="listrow">${ic("i-ban")}<span class="path"><code>${esc(f)}</code></span><div class="right"><button class="iconbtn" data-act="rmexcl" data-i="${i}">${ic("i-trash")}</button></div></div>`).join("") : `<div class="listrow"><span class="path" style="color:var(--muted-soft)">${t("cfg.none")}</span></div>`}<div class="addrow" data-act="addexcl">${ic("i-plus")}${t("cfg.addExclude")}</div></div>`;
  h += `<div class="sech">${ic("i-layers")}${t("cfg.sources")}</div><div class="card">
    <div class="row"><div class="lab">Claude Code<small>${t("src.ccDesc")}</small></div><span class="toggle lock"></span></div>
    <div class="row"><div class="lab">Codex<small>${t("src.codexDesc")}</small></div>${tog("codex")}</div>
    <div class="row"><div class="lab">Trae memory<small>${t("src.traeDesc")}</small></div>${tog("trae_memory")}</div>
    <div class="row"><div class="lab">session_history *.md<small>${t("src.shDesc")}</small></div>${tog("session_history_md")}</div></div>`;
  h += `<div class="sech">${ic("i-shield")}${t("cfg.redact")}<span class="x">${t("cfg.redactX")}</span></div><div class="card">
    <div class="listrow" style="color:var(--muted);font-size:11.5px;border-bottom:1px solid var(--line)">${t("cfg.builtinIntro")}</div>
    <div class="rules">${BUILTIN[LANG === "zh" ? "zh" : "en"].map((x) => `<span class="rchip">${ic("i-check")}${esc(x)}</span>`).join("")}</div></div>
    <div class="subh">${t("cfg.wordlist")}</div>
    <div class="card">${REDACT.terms.length ? REDACT.terms.map((x) => `<div class="listrow">${ic("i-shield")}<span class="path">${esc(x.pattern)}</span><span class="pill-type">${t(x.type === "regex" ? "type.regex" : "type.text")}</span><div class="right"><span class="cov">${t("cfg.hitCount", { n: x.count, s: x.sessions })}</span><button class="iconbtn" data-act="rmterm" data-p="${esc(x.pattern)}">${ic("i-trash")}</button></div></div>`).join("") : `<div class="listrow" style="color:var(--muted-soft);font-size:11.5px">${t("cfg.wordlistEmpty")}</div>`}<div class="addrow" data-act="addterm">${ic("i-plus")}${t("cfg.addTerm")}</div></div>`;
  h += `<div class="sech">${ic("i-clock")}${t("cfg.timing")}</div><div class="card">
    <div class="row"><div class="lab">${t("cfg.interval")}</div><div><code>${WCFG.interval_sec}s</code></div></div>
    <div class="row"><div class="lab">${t("cfg.debounce")}</div><div><code>${WCFG.debounce_sec}s</code></div></div></div>`;
  if (dirty()) h += `<div class="savebar">${ic("i-alert")}<span class="delta" id="delta">${t("cfg.unsaved")}</span><span class="sp"></span><button class="btn" data-act="discard">${t("cfg.discard")}</button><button class="btn go" data-act="save">${t("cfg.save")}</button></div>`;
  $("cfg").innerHTML = h;
  if (dirty()) refreshDelta();
}
let deltaT;
function refreshDelta() {
  clearTimeout(deltaT);
  deltaT = setTimeout(async () => {
    try { const d = await apiPost("/api/config-dryrun", WCFG); const el = $("delta"); if (el) el.innerHTML = t("cfg.delta", { a: d.willAdd, s: d.willStop }); } catch {}
  }, 250);
}
async function saveConfig() { try { await apiPost("/api/config", WCFG); CFG = clone(WCFG); renderConfig(); toast(t("toast.saved")); } catch (e) { toast(t("toast.opFail", { e: e.message })); } }
async function refreshRedact() { try { REDACT = await api("/api/redact"); } catch {} }

$("config").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act;
  if (act === "scope") { WCFG.collect_all = el.dataset.val === "all"; renderConfig(); }
  else if (act === "toggle") { const k = el.dataset.key; WCFG[k] = WCFG[k] === false; renderConfig(); }
  else if (act === "addfolder") { const p = prompt(t("prompt.addFolder")); if (p) { (WCFG.upload_folders ||= []).push(p.trim()); renderConfig(); } }
  else if (act === "rmfolder") { WCFG.upload_folders.splice(+el.dataset.i, 1); renderConfig(); }
  else if (act === "addexcl") { const p = prompt(t("prompt.addExclude")); if (p) { (WCFG.exclude ||= []).push(p.trim()); renderConfig(); } }
  else if (act === "rmexcl") { WCFG.exclude.splice(+el.dataset.i, 1); renderConfig(); }
  else if (act === "revealtok") { TOK_SHOWN = !TOK_SHOWN; renderConfig(); }
  else if (act === "copytok") { try { await navigator.clipboard.writeText(CONN.device_token); toast(t("conn.copied")); } catch { toast(CONN.device_token || "-"); } }
  else if (act === "save") saveConfig();
  else if (act === "discard") { WCFG = clone(CFG); renderConfig(); }
  else if (act === "addterm") { const p = prompt(t("prompt.addTerm")); if (p) { const v = p.trim(); const type = /^\/.*\/[gimsuy]*$/.test(v) ? "regex" : "text"; await apiPost("/api/redact-add", { pattern: v, type }); await refreshRedact(); renderConfig(); toast(t("toast.termAdded")); } }
  else if (act === "rmterm") { await apiPost("/api/redact-remove", { pattern: el.dataset.p }); await refreshRedact(); renderConfig(); }
});

// ---------- drawer ----------
function setTab(tab) {
  document.querySelectorAll(".dtab").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  $("d-body").textContent = CUR ? (tab === "red" ? CUR.redacted : CUR.raw) : "";
}
async function openDetail(file) {
  $("scrim").classList.add("on"); $("drawer").classList.add("on");
  $("d-title").textContent = t("dr.loading"); $("d-coord").textContent = ""; $("d-body").textContent = "";
  $("d-exclude").style.display = "none"; $("d-hint").textContent = ""; CUR = null;
  let d; try { d = await api("/api/session?file=" + encodeURIComponent(file)); } catch (e) { $("d-body").textContent = t("dr.loadFail", { e: e.message }); return; }
  if (d.error) { $("d-title").textContent = t("dr.cantOpen"); $("d-coord").innerHTML = d.coord ? `<code>${esc(d.coord)}</code>` : ""; $("d-body").textContent = d.error; return; }
  CUR = d; CUR.file = file;
  $("d-title").textContent = d.intent || d.id;
  $("d-coord").innerHTML = `<code>${esc(d.coord || "")}</code> · ${esc(d.tool)}${d.truncated ? " " + t("dr.truncated") : ""}`;
  const up = d.status === "uploaded";
  $("d-exclude-t").textContent = up ? t("dr.retract") : t("dr.exclude");
  $("d-hint").textContent = up ? t("dr.hintRetract") : t("dr.hintExclude");
  $("d-exclude").style.display = "inline-flex";
  setTab("red");
}
function closeDrawer() { $("scrim").classList.remove("on"); $("drawer").classList.remove("on"); }
$("d-exclude").onclick = async () => {
  if (!CUR) return;
  const up = CUR.status === "uploaded";
  if (!confirm(up ? t("confirm.retract") : t("confirm.exclude"))) return;
  try {
    const r = await apiPost("/api/exclude", { file: CUR.file });
    toast(up ? (r.retract?.ok ? t("toast.retracted") : t("toast.retractPartial", { e: r.retract?.error || "?" })) : t("toast.excludeOnly"));
    closeDrawer(); await reload();
  } catch (e) { toast(t("toast.opFail", { e: e.message })); }
};

// ---------- nav / events ----------
function go(id) {
  document.querySelectorAll(".nav a").forEach((x) => x.classList.toggle("on", x.dataset.go === id));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === id));
}
document.querySelectorAll(".nav a").forEach((a) => a.onclick = () => go(a.dataset.go));
document.querySelectorAll(".dtab").forEach((x) => x.onclick = () => setTab(x.dataset.tab));
$("d-close").onclick = closeDrawer;
$("scrim").onclick = closeDrawer;
$("langtog").onclick = () => {
  LANG = LANG === "zh" ? "en" : "zh"; localStorage.setItem("tb_lang", LANG);
  applyStatic();
  if (OV) renderOverview(OV); renderSessions(); renderLog(LOGLINES); renderConfig();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-act]")) return; const tr = e.target.closest("[data-file]"); if (tr) openDetail(tr.getAttribute("data-file")); });

async function reload() {
  const [ov, ss] = await Promise.all([api("/api/overview"), api("/api/sessions")]);
  renderOverview(ov); SESSIONS = ss; renderSessions();
}
async function init() {
  applyStatic();
  try {
    const [ov, ss, lg, rd] = await Promise.all([api("/api/overview"), api("/api/sessions"), api("/api/log"), api("/api/redact")]);
    REDACT = rd; CFG = ov.config; WCFG = clone(CFG);
    renderOverview(ov); SESSIONS = ss; renderSessions(); renderLog(lg.lines); renderConfig();
  } catch (e) {
    document.querySelector(".main").innerHTML = `<h1>${t("connFail")}</h1><p class="sub">${esc(t("connFailSub", { e: e.message }))}</p>`;
  }
}
init();
