/* team-brain 真相层 GUI —— 纯 vanilla、零依赖、无构建。
   模型：3 股原料（会话 session / 代码 GitHub / 文档飞书）× 3 视角（人 / 时间 / 搜索）+ 总览。
   打的全是服务器现有只读接口：/whoami /roster /ls /sessions /read /grep /log /github。
   token 只存本浏览器 localStorage，随 Authorization: Bearer 发往真相库。
   双语：默认英文（lang=en），中英切换存 localStorage；所有 UI 文案走 t(key)。 */

const TOKEN_KEY = "tb_token";
const LANG_KEY = "tb_lang";
const state = { me: null, roster: null, spaces: null, sesCache: null, codeState: null };
const PAGE_SIZE = 30;

/* ---------- i18n ---------- */
// 语言只有 en / zh；默认英文。函数值用于带插值的文案，t(key, ...args) 调用时传参。
let lang = localStorage.getItem(LANG_KEY) === "zh" ? "zh" : "en";
const I18N = {
  en: {
    // 静态（index.html）
    "doc.title": "team-brain · truth layer",
    "doc.desc": "The truth layer of the team project brain — browse the whole team's sessions, Feishu docs, code state and activity.",
    "nav.menu": "Menu",
    "brand.tag": "truth layer",
    "search.ph": "grep the team truth repo…  ( / to focus)",
    "search.aria": "Search the truth repo",
    "token.chipTitle": "Connect / switch token",
    "nav.overview": "Overview",
    "nav.repos": "Repos",
    "nav.sessions": "Sessions",
    "nav.docs": "Docs",
    "nav.people": "People",
    "nav.stats": "Stats",
    "rail.active": "Active repos",
    "rail.loading": "…",
    "modal.title": "Connect to the truth repo",
    "modal.desc1": "Paste your personal token (the string in ",
    "modal.desc2": ", or one your admin sent you). It lives only in this browser's localStorage and is sent only to the truth-repo server with each request.",
    "token.inputPh": "Paste token…",
    "btn.disconnect": "Disconnect",
    "btn.connect": "Connect",
    "lang.toggle": "中文",
    // 通用
    "loading": "Loading",
    "ago.now": "just now",
    "ago.min": (n) => `${n} min ago`,
    "ago.hour": (n) => `${n} h ago`,
    "ago.day": (n) => `${n} d ago`,
    "api.notConnected": "Not connected",
    "api.netErr": "Network error — can't reach the truth-repo server",
    // markdown / 对话
    "md.image": "image",
    "md.lines": (n) => `${n} lines`,
    "conv.more": (n) => `Expand remaining ${n} turns ↓`,
    "who.user": "User",
    "who.asst": "Assistant",
    "who.aside": "Aside",
    // 连接提示 / 错误
    "connect.first": "Connect first",
    "connect.desc": "The truth layer is a private repo of the whole team's sessions / docs / code state. You need your personal token to browse.",
    "connect.btn": "Connect token",
    "err.title": "Something went wrong",
    // 总览
    "ov.title": "Overview",
    "ov.sub": "A bird's-eye view of the team truth repo — progress, attention, docs, activity.",
    "stat.repos": "Active repos",
    "stat.sessions": "Sessions",
    "stat.docs": "Docs",
    "stat.attention": "Needs attention",
    "ov.recentActivity": "Recent activity",
    "ov.allSessions": "All sessions →",
    "ov.attentionHead": "⚠️ Needs attention · unpushed",
    "ov.allRepos": "All repos →",
    "ov.recentDocs": "Recent docs",
    "ov.feishuDocs": "Feishu docs →",
    "load.activity": "Loading activity",
    "load.scanCode": "Scanning code state",
    "load.docs": "Loading docs",
    "ov.noActivity": "No activity yet",
    "ov.noActiveRepos": "No active repos.",
    "ov.branchesUnpushed": (n) => `${n} branches unpushed`,
    "ov.allPushed": "All pushed ✓",
    "ov.noMirror": "No doc mirror yet.",
    // 仓库
    "load.repos": "Loading repos",
    "repos.title": "GitHub repos",
    "repos.sub": "Repos registered by the team (registry). Active = has sessions; each repo's code state comes from the 4h-polled code-state.",
    "repos.active": (n) => `Active · ${n}`,
    "repos.noActive": "No active repos",
    "repos.registered": (n) => `Registered only · ${n}`,
    "repos.unpushedBadge": (n) => `${n} unpushed`,
    "card.registeredOnly": "Registered only",
    "card.meta": (n, agoStr, people) => `Active · ${n} sessions · ${agoStr}${people > 1 ? ` · ${people} people` : ""}`,
    // code-state
    "cs.noBranches": "No active branches (last 30 days).",
    "cs.noPR": "No open PRs.",
    "cs.activeBranches": "Active branches",
    "cs.openPR": "Open PRs",
    "cs.unpushed": "unpushed",
    "cs.unpushedTitle": "Local session is newer than the last push",
    "cs.none": "No code-state for this repo yet (registered only, no sessions yet, or awaiting the first 4h poll).",
    // 单仓
    "load.repo": "Loading repo",
    "repo.defaultBranch": "default branch",
    "repo.sessionsCount": (n) => `${n} sessions`,
    "repo.openGithub": "Open on GitHub ↗",
    "repo.sessions": "Sessions",
    "repo.filterInRepo": "Filter in this repo →",
    "repo.noSessions": "No sessions in this repo yet.",
    // 个人草稿 space
    "load.generic": "Loading",
    "space.tag": "personal draft bucket",
    "space.sub": (n) => `Local sessions with no GitHub remote (grouped by folder tag). ${n} total.`,
    "space.empty": "Empty.",
    "space.crumbSuffix": "· personal drafts",
    "space.draftTag": "personal draft",
    // session 行
    "row.noPreview": "(no preview)",
    // 会话浏览
    "ses.title": "Browse sessions",
    "ses.sub": "Filter all team sessions by person / repo / time, sorted by recent activity.",
    "ses.allPeople": "All people",
    "ses.allRepos": "All repos",
    "ses.sincePh": "since (2026-06-01)",
    "ses.filter": "Filter",
    "ses.summary": (total, n, trunc, cur, pages) => `${total} total${trunc ? ` (first ${n} only)` : ""} · page ${cur}/${pages}`,
    "ses.noMatch": "No matching sessions.",
    "pager.prev": "← Prev",
    "pager.next": "Next →",
    // 人
    "load.members": "Loading members",
    "people.title": "People",
    "people.sub": "Who's doing what — decentralized team awareness. Stats based on the latest 200 sessions.",
    "people.cardMeta": (n, repos, agoStr) => `${n} recent sessions · ${repos} repos${agoStr ? ` · ${agoStr}` : " (no recent activity)"}`,
    "person.sub": (n, repos, hasLocal) => `${n} sessions · touched ${repos} repos${hasLocal ? " · has personal drafts" : ""}`,
    "person.touchedRepos": "Repos touched",
    "person.recentSessions": "Recent sessions",
    "person.noSessions": "No sessions.",
    "tag.github": "github",
    "tag.draft": "personal draft",
    // 搜索
    "search.crumb": "Search",
    "search.title": "Search the truth repo",
    "search.sub": "git grep full-text across all team sessions (redacted transcripts) and Feishu docs. Regex supported.",
    "search.qPh": "regex / keyword…",
    "search.raw": "incl. raw jsonl",
    "search.btn": "Search",
    "search.go": "Searching",
    "search.hint": "Enter a keyword to start searching.",
    "grep.noMatch": "No matches.",
    "grep.truncated": "Results truncated (too many hits; narrow the scope to see more).",
    "grep.hits": (n) => `${n} hits`,
    // 读文件
    "load.read": "Reading",
    "read.missingPath": "Missing path",
    "act.feed": "Feed",
    "act.feedTitle": "Feed to Agent — copy the prompt (with truth-repo path) for your agent",
    "act.link": "Link",
    "act.linkTitle": "Copy web link (share with people, click to open)",
    "act.code": "Code",
    "act.codeTitle": (br) => `Open on GitHub${br ? ` (${br})` : ""}`,
    "act.feishu": "Feishu",
    "act.feishuTitle": "Open the original in Feishu",
    "act.aside": "Aside",
    "act.asideTitle": (n) => `Show / hide assistant asides (${n})`,
    "act.raw": "Raw",
    "act.rendered": "Rendered",
    "act.rawTitle": "Toggle raw / rendered",
    "act.copied": "Copied",
    "act.copyFail": "Copy failed",
    "read.agentMsg": (path) => `Read and explain this record with team-brain, as context for the discussion that follows: ${path}`,
    "meta.detail": "Details",
    "meta.feishuOriginal": "Feishu original ↗",
    // 文档
    "docs.noMirror": "No Feishu doc mirror yet.",
    "docs.noMirrorDesc": "Once the server has feishu.yaml configured and the app added to the wiki, docs auto-mirror in every 4h.",
    "docs.title": "Feishu docs",
    "docs.wikis": "Wikis / folders",
    "docs.docs": "Docs",
    "docs.items": (n) => `${n} items`,
    "docs.empty": "Empty here.",
    // 侧栏
    "side.connectToShow": "Connect to show repos",
    "side.loadFail": "Load failed",
    "side.noActive": "No active repos",
    "side.viewAll": "View all repos →",
    // 路由
    "route.unknown": "Unknown page.",
    "stats.title": "Stats",
    "stats.sub": "Team aggregates by work time — token usage, sessions, turns. Group and slice however you like.",
    "stats.by": "Group by",
    "stats.metric": "Metric",
    "stats.window": "Window",
    "stats.by.day": "Day",
    "stats.by.week": "Week",
    "stats.by.person": "Person",
    "stats.by.space": "Repo",
    "stats.by.tool": "Tool",
    "stats.m.tokens": "Tokens",
    "stats.m.tokens_io": "Tokens (no cache)",
    "stats.m.tokens_in": "Input tokens",
    "stats.m.tokens_out": "Output tokens",
    "stats.m.cache": "Cache tokens",
    "stats.m.sessions": "Sessions",
    "stats.m.turns": "Turns",
    "stats.win.7": "Last 7 days",
    "stats.win.30": "Last 30 days",
    "stats.win.90": "Last 90 days",
    "stats.win.0": "All time",
    "stats.empty": "No data in this window.",
    "stats.coverage": (n, withU) => `${n} sessions in window · ${withU} with token data`,
    "stats.codexNote": "Codex token data only exists for sessions ingested after the client update; older Codex sessions count toward sessions/turns but not tokens.",
    "stats.total": "Total",
    "stats.tokTip": (i, o, c) => `in ${i} / out ${o} / cache ${c}`,
    "stats.prev": "← Prev",
    "stats.next": "Next →",
    "stats.page": (a, b, n) => `${a}–${b} of ${n}`,
    "route.backHome": "Back to overview",
    // token
    "token.notConnected": "Not connected",
    "token.invalid": "invalid token",
    "token.verifying": "Verifying…",
    "token.invalidRetry": "Invalid token, check and retry.",
  },
  zh: {
    "doc.title": "team-brain · 真相层",
    "doc.desc": "团队项目大脑的真相层 —— 浏览全队 session、飞书文档、代码状态与活动流。",
    "nav.menu": "菜单",
    "brand.tag": "真相层",
    "search.ph": "grep 全队真相库…  ( / 聚焦)",
    "search.aria": "搜索真相库",
    "token.chipTitle": "连接 / 切换 token",
    "nav.overview": "总览",
    "nav.repos": "仓库",
    "nav.sessions": "会话",
    "nav.docs": "文档",
    "nav.people": "人",
    "nav.stats": "统计",
    "rail.active": "活跃仓库",
    "rail.loading": "…",
    "modal.title": "连接到真相库",
    "modal.desc1": "粘贴你的个人 token（即 ",
    "modal.desc2": " 里那串，或管理员发你的）。仅存在本浏览器的 localStorage，只随请求发往真相库服务器。",
    "token.inputPh": "粘贴 token…",
    "btn.disconnect": "断开",
    "btn.connect": "连接",
    "lang.toggle": "EN",
    "loading": "加载中",
    "ago.now": "刚刚",
    "ago.min": (n) => `${n} 分钟前`,
    "ago.hour": (n) => `${n} 小时前`,
    "ago.day": (n) => `${n} 天前`,
    "api.notConnected": "未连接",
    "api.netErr": "网络错误 —— 连不上真相库服务器",
    "md.image": "图片",
    "md.lines": (n) => `${n} 行`,
    "conv.more": (n) => `展开剩余 ${n} 条对话 ↓`,
    "who.user": "用户",
    "who.asst": "助手",
    "who.aside": "助手·过程",
    "connect.first": "先连接真相库",
    "connect.desc": "真相层是全队 session / 文档 / 代码状态的私有库，需要你的个人 token 才能浏览。",
    "connect.btn": "连接 token",
    "err.title": "出错了",
    "ov.title": "总览",
    "ov.sub": "全队真相库一眼概览 —— 进展、待关注、文档、活动。",
    "stat.repos": "活跃仓库",
    "stat.sessions": "会话",
    "stat.docs": "文档",
    "stat.attention": "待关注",
    "ov.recentActivity": "最近活动",
    "ov.allSessions": "全部会话 →",
    "ov.attentionHead": "⚠️ 待关注 · 未推进度",
    "ov.allRepos": "全部仓库 →",
    "ov.recentDocs": "最近文档",
    "ov.feishuDocs": "飞书文档 →",
    "load.activity": "加载活动",
    "load.scanCode": "扫描代码状态",
    "load.docs": "加载文档",
    "ov.noActivity": "暂无活动",
    "ov.noActiveRepos": "没有活跃仓库。",
    "ov.branchesUnpushed": (n) => `${n} 分支未推`,
    "ov.allPushed": "全部已推送 ✓",
    "ov.noMirror": "还没有文档镜像。",
    "load.repos": "加载仓库",
    "repos.title": "GitHub 仓库",
    "repos.sub": "团队登记的仓（registry）。活跃 = 有 session；每仓的代码状态来自 4h 轮询的 code-state。",
    "repos.active": (n) => `活跃 · ${n}`,
    "repos.noActive": "暂无活跃仓库",
    "repos.registered": (n) => `仅登记 · ${n}`,
    "repos.unpushedBadge": (n) => `${n} 未推`,
    "card.registeredOnly": "仅登记",
    "card.meta": (n, agoStr, people) => `活跃 · ${n} 会话 · ${agoStr}${people > 1 ? ` · ${people} 人` : ""}`,
    "cs.noBranches": "无活跃分支（30 天内）。",
    "cs.noPR": "无 Open PR。",
    "cs.activeBranches": "活跃分支",
    "cs.openPR": "Open PR",
    "cs.unpushed": "未推进度",
    "cs.unpushedTitle": "本地 session 比最后一次 push 新",
    "cs.none": "该仓尚无 code-state（仅登记、还没 session，或等首次 4h 轮询）。",
    "load.repo": "加载仓库",
    "repo.defaultBranch": "默认分支",
    "repo.sessionsCount": (n) => `${n} 条 session`,
    "repo.openGithub": "在 GitHub 打开 ↗",
    "repo.sessions": "Sessions",
    "repo.filterInRepo": "在本仓筛选 →",
    "repo.noSessions": "该仓还没有 session。",
    "load.generic": "加载",
    "space.tag": "个人草稿桶",
    "space.sub": (n) => `没挂 GitHub remote 的本地 session（按 folder 标签区分项目）。${n} 条。`,
    "space.empty": "空。",
    "space.crumbSuffix": "· 个人草稿",
    "space.draftTag": "个人草稿",
    "row.noPreview": "(无预览)",
    "ses.title": "会话浏览",
    "ses.sub": "全队 session 按人 / 仓库 / 时间筛选，按最近活动排序。",
    "ses.allPeople": "全部人",
    "ses.allRepos": "全部仓库",
    "ses.sincePh": "自 (2026-06-01)",
    "ses.filter": "筛选",
    "ses.summary": (total, n, trunc, cur, pages) => `共 ${total} 条${trunc ? `（仅取前 ${n}）` : ""} · 第 ${cur}/${pages} 页`,
    "ses.noMatch": "无匹配 session。",
    "pager.prev": "← 上一页",
    "pager.next": "下一页 →",
    "load.members": "加载成员",
    "people.title": "人",
    "people.sub": "谁在搞什么 —— 去中心化的团队认知。统计基于最近 200 条 session。",
    "people.cardMeta": (n, repos, agoStr) => `${n} 条近期 session · ${repos} 个仓${agoStr ? ` · ${agoStr}` : "（无近期活动）"}`,
    "person.sub": (n, repos, hasLocal) => `${n} 条 session · 碰过 ${repos} 个仓${hasLocal ? " · 有个人草稿" : ""}`,
    "person.touchedRepos": "碰过的仓库",
    "person.recentSessions": "最近 session",
    "person.noSessions": "无 session。",
    "tag.github": "github",
    "tag.draft": "个人草稿",
    "search.crumb": "搜索",
    "search.title": "搜索真相库",
    "search.sub": "git grep 全文检索全队 session（脱敏 transcript）与飞书文档。支持正则。",
    "search.qPh": "正则 / 关键词…",
    "search.raw": "连原文 jsonl",
    "search.btn": "搜索",
    "search.go": "搜索中",
    "search.hint": "输入关键词开始搜索。",
    "grep.noMatch": "无匹配。",
    "grep.truncated": "结果已截断（命中过多，缩小范围看更全）。",
    "grep.hits": (n) => `${n} 命中`,
    "load.read": "读取",
    "read.missingPath": "缺少 path",
    "act.feed": "投喂",
    "act.feedTitle": "投喂给 Agent — 复制喂给你 agent 的话术（含真相库 path）",
    "act.link": "链接",
    "act.linkTitle": "复制网页链接（分享给人，点开即看）",
    "act.code": "代码",
    "act.codeTitle": (br) => `在 GitHub 打开${br ? `（${br}）` : ""}`,
    "act.feishu": "飞书",
    "act.feishuTitle": "在飞书打开原文",
    "act.aside": "旁白",
    "act.asideTitle": (n) => `显示 / 隐藏过程旁白（${n} 条）`,
    "act.raw": "原文",
    "act.rendered": "渲染",
    "act.rawTitle": "切换原文 / 渲染",
    "act.copied": "已复制",
    "act.copyFail": "复制失败",
    "read.agentMsg": (path) => `用 team-brain 读取并讲解这条记录，作为接下来讨论的上下文：${path}`,
    "meta.detail": "详情",
    "meta.feishuOriginal": "飞书原文 ↗",
    "docs.noMirror": "还没有飞书文档镜像。",
    "docs.noMirrorDesc": "服务器配了 feishu.yaml 并把应用加进知识库后，每 4h 自动镜像进来。",
    "docs.title": "飞书文档",
    "docs.wikis": "知识库 / 目录",
    "docs.docs": "文档",
    "docs.items": (n) => `${n} 项`,
    "docs.empty": "此处为空。",
    "side.connectToShow": "连接后显示仓库",
    "side.loadFail": "加载失败",
    "side.noActive": "暂无活跃仓库",
    "side.viewAll": "查看全部仓库 →",
    "route.unknown": "未知页面。",
    "stats.title": "统计",
    "stats.sub": "按【工作时间】聚合全队——token 用量 / session 数 / 对话轮次，维度任选任拆。",
    "stats.by": "维度",
    "stats.metric": "指标",
    "stats.window": "时间窗",
    "stats.by.day": "按天",
    "stats.by.week": "按周",
    "stats.by.person": "按人",
    "stats.by.space": "按仓",
    "stats.by.tool": "按工具",
    "stats.m.tokens": "Token 总量",
    "stats.m.tokens_io": "token 不含缓存",
    "stats.m.tokens_in": "输入 token",
    "stats.m.tokens_out": "输出 token",
    "stats.m.cache": "缓存 token",
    "stats.m.sessions": "Session 数",
    "stats.m.turns": "对话轮次",
    "stats.win.7": "近 7 天",
    "stats.win.30": "近 30 天",
    "stats.win.90": "近 90 天",
    "stats.win.0": "全部",
    "stats.empty": "该时间窗内没有数据。",
    "stats.coverage": (n, withU) => `窗口内 ${n} 条 session · 其中 ${withU} 条有 token 数据`,
    "stats.codexNote": "Codex 的 token 仅客户端升级后入库的 session 才有；更早的 Codex session 计入 session/轮次，但不计 token。",
    "stats.total": "合计",
    "stats.tokTip": (i, o, c) => `输入 ${i} / 输出 ${o} / 缓存 ${c}`,
    "stats.prev": "← 上一页",
    "stats.next": "下一页 →",
    "stats.page": (a, b, n) => `第 ${a}–${b} / 共 ${n}`,
    "route.backHome": "回总览",
    "token.notConnected": "未连接",
    "token.invalid": "token 无效",
    "token.verifying": "验证中…",
    "token.invalidRetry": "token 无效，检查后重试。",
  },
};
function t(key, ...args) {
  let v = (I18N[lang] || I18N.en)[key];
  if (v == null) v = I18N.en[key];
  if (v == null) return key;
  return typeof v === "function" ? v(...args) : v;
}
// 切语言：存盘 + 改 <html lang> + 重刷静态文案 + 重渲当前视图/侧栏/token 芯片
function setLang(l) {
  lang = l === "zh" ? "zh" : "en";
  localStorage.setItem(LANG_KEY, lang);
  applyStaticI18n();
  refreshTokenChip();
  loadSidebar();
  route();
}
// 刷 index.html 里的静态文案（导航/占位符/标题等，由 data-i18n* 标注）
function applyStaticI18n() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = t("doc.title");
  const desc = document.querySelector('meta[name="description"]'); if (desc) desc.setAttribute("content", t("doc.desc"));
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => el.setAttribute("placeholder", t(el.dataset.i18nPh)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => el.setAttribute("title", t(el.dataset.i18nTitle)));
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
}

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
    const loc = lang === "zh" ? "zh-CN" : "en-CA";   // en-CA → YY-MM-DD（与 zh 的破折号风格一致）
    return d.toLocaleString(loc, { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-");
  } catch { return String(s).slice(0, 16); }
};
const ago = (s) => {
  if (!s) return "";
  const d = new Date(s); if (isNaN(d)) return "";
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 90) return t("ago.now");
  if (sec < 3600) return t("ago.min", Math.round(sec / 60));
  if (sec < 86400) return t("ago.hour", Math.round(sec / 3600));
  if (sec < 86400 * 30) return t("ago.day", Math.round(sec / 86400));
  return fmtDate(s).slice(0, 8);
};
/* 并发受限 map（总览批量读 code-state / 文档 frontmatter 用） */
async function pmap(items, fn, conc = 5) {
  const out = new Array(items.length); let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, run));
  return out;
}

/* space_key ↔ 友好显示 / 仓库链接（支持 github/gitlab/gitea 三家团队仓）*/
const REPO_PREFIXES = ["github__", "gitlab__", "gitea__"];
const isRepoSpace = (key) => REPO_PREFIXES.some((p) => String(key || "").startsWith(p));
const PROVIDER_LABEL = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };
function spaceLabel(key) {
  // github__owner__repo（历史格式，无 host）；gitlab__host__owner__repo / gitea__host__owner__repo
  if (key.startsWith("github__")) { const [, owner, ...rest] = key.split("__"); return { name: `${owner}/${rest.join("__")}`, kind: "github", provider: "GitHub", host: "github.com" }; }
  if (key.startsWith("gitlab__") || key.startsWith("gitea__")) {
    const [prov, host, owner, ...rest] = key.split("__");
    return { name: `${owner}/${rest.join("__")}`, kind: prov, provider: PROVIDER_LABEL[prov] || prov, host };
  }
  if (key.startsWith("local__")) return { name: key.slice("local__".length), kind: "local", provider: "", host: "" };
  return { name: key, kind: "other", provider: "", host: "" };
}
// ref：github=「github/owner/repo」→ github.com；其余=「host/owner/repo」→ https://host/owner/repo
const repoUrlFromRef = (ref) => {
  const s = String(ref || "").trim();
  const gh = /^github\/(.+)$/.exec(s); if (gh) return "https://github.com/" + gh[1];
  return /^[^/]+\.[^/]+\/.+\/.+/.test(s) ? "https://" + s : "";
};
const nameOf = (id) => { const m = (state.roster || []).find((x) => x.id === id); return m ? m.name : id; };
const spaceHref = (key) => isRepoSpace(key) ? `#/repo/${enc(key)}` : `#/space/${enc(key)}`;  // 团队仓 → 仓库页；其余（local）→ 个人草稿页
const kbName = (s) => s.replace(/__[A-Za-z0-9]+$/, "");                            // 知识库目录名去尾部 __<space_id>
const docName = (s) => s.replace(/--[A-Za-z0-9]+\.md$/, "").replace(/\.md$/, ""); // 文档文件名去尾部 --<node_token>.md

/* ---------- API ---------- */
async function api(path, params = {}) {
  const token = getToken();
  if (!token) { const e = new Error(t("api.notConnected")); e.code = 401; throw e; }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, v);
  const url = path + (qs.toString() ? "?" + qs : "");
  let res;
  try { res = await fetch(url, { headers: { authorization: "Bearer " + token } }); }
  catch { throw new Error(t("api.netErr")); }
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
// 内联：代码 / 粗 / 斜 / 删除线 / 链接 / 图片 / 裸 URL 自动链接。
// 顺序要点：先 esc，再把行内代码抽成占位符（保护其内的 * _ ~ 不被当格式），强调在链接之前跑
// （此刻 URL 仍是 (…) 或裸文本，下划线靠词边界规则避开 snake_case），最后还原代码。
function inlineMd(s) {
  s = esc(s);
  // 行内代码 → 占位（\uE0xx 私用区，正文几乎不会出现）；内容已被上面 esc，还原时直接用
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => `${codes.push(c) - 1}`);
  // 强调：三星=粗斜 → 双星=粗 → 单星=斜；下划线同理（仅词边界，避开 a_b_c）；删除线
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/___([^_\n]+)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  // 图片：CSP 不放行外链图（img-src 'self' data:）→ 渲成可点链接而非裂图；非 http(s) 退化成 alt
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, u) =>
    /^https?:\/\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener">🖼 ${alt || t("md.image")}</a>` : (alt || ""));
  // 链接（可带 "title"）：仅放行 http(s)，否则退化成链接文字。u 已被 esc，不再二次转义（修 & 双重转义）
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, txt, u) =>
    /^https?:\/\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${txt}</a>` : txt);
  // 裸 URL 自动链接：捕获前导字符代替 lookbehind（lookbehind 在老 Safari 解析期报错 → 整站白屏）
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (_m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  // 还原行内代码
  s = s.replace(/(\d+)/g, (_m, i) => `<code>${codes[+i]}</code>`);
  return s;
}
// 列表（含有序 / 嵌套 / 任务清单，按缩进入栈）
function listItemHtml(text) {
  const task = text.match(/^\[( |x|X)\] ([\s\S]*)$/);
  if (task) {
    const checked = task[1] !== " ";
    return `<li class="task-item"><input type="checkbox" disabled${checked ? " checked" : ""}> ${inlineMd(task[2])}`;
  }
  return `<li>${inlineMd(text)}`;
}
function listBlockHtml(items) {
  let html = "";
  const stack = [];
  for (const it of items) {
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ indent: it.indent, tag });
      html += `<${tag}>${listItemHtml(it.text)}`;
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
      const want = it.ordered ? "ol" : "ul";
      if (stack[stack.length - 1].tag !== want) {
        html += `</li></${stack.pop().tag}><${want}>${listItemHtml(it.text)}`;
        stack.push({ indent: it.indent, tag: want });
      } else html += `</li>${listItemHtml(it.text)}`;
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
// 旧格式兜底：Codex event_msg 把换行压成空格，导致 ```lang ... ``` 内嵌在单行里。
// 扫每一行：若行内含 ``` 但行首不是 ```，说明是内嵌代码块 → 把每段 ```...``` 展开到独立行，
// 让下面的块级解析器能正常识别。新格式（已有换行）不受影响。
function preExpandFences(src) {
  return src.split("\n").map((line) => {
    if (/^\s*```/.test(line) || !line.includes("```")) return line;
    return line.replace(/```(\w*)\s+([\s\S]*?)\s*```/g,
      (_, lang, body) => `\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`);
  }).join("\n");
}
function renderMd(src) {
  const lines = preExpandFences(String(src).replace(/\r\n/g, "\n")).split("\n");
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
      const codeLang = f[1].trim(), buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const codeHtml = `<pre><code${codeLang ? ` class="lang-${esc(codeLang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`;
      // 大代码块 / ASCII 图默认折叠（设计讨论里满屏架构图最占版面）；native <details>，零 JS、CSP 友好
      html += buf.length > 12
        ? `<details class="fold-code"><summary>${esc(codeLang || "code")} · ${t("md.lines", buf.length)}</summary>${codeHtml}</details>`
        : codeHtml;
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
// 注意：transcript 数据里说话人标记固定是中文（**用户**/**助手**），解析正则不随 UI 语言变；只有展示标签走 t()。
function renderTurn(turn) {
  const me = turn.who === "用户";
  // aside = 助手过程旁白，加 turn-aside 类（默认靠 CSS 在 #doc-body 上隐藏，由顶部开关统一切换）
  const cls = `turn ${me ? "turn-user" : "turn-asst"}${turn.aside ? " turn-aside" : ""}`;
  const who = turn.aside ? t("who.aside") : (me ? t("who.user") : t("who.asst"));
  return `<div class="${cls}">
    <div class="turn-who">${who}</div>
    <div class="turn-body doc">${renderMd(turn.lines.join("\n").trim())}</div>
  </div>`;
}
function parseTurns(body) {
  const turns = []; let cur = null, inFence = false; const pre = [];
  for (const ln of String(body).split("\n")) {
    if (/^\s*```/.test(ln)) inFence = !inFence;                 // 代码块内不当 turn 边界（助手贴日志/transcript 常含 **助手**：）
    const m = !inFence && ln.match(/^\*\*(用户|助手)(·过程)?\*\*[：:]\s*(.*)$/);
    if (m) { cur = { who: m[1], aside: !!m[2], lines: m[3] ? [m[3]] : [] }; turns.push(cur); }
    else if (cur) cur.lines.push(ln);
    else pre.push(ln);                                          // 首个 turn 之前的前导内容（别丢）
  }
  // 去重：连续同说话人、且一条是另一条前缀（用户编辑后重发）→ 只留更长那条
  const dedup = [];
  for (const turn of turns) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.who === turn.who && prev.aside === turn.aside) {
      const a = prev.lines.join("\n").trim(), b = turn.lines.join("\n").trim();
      if (a && b && (a.startsWith(b) || b.startsWith(a))) { if (b.length > a.length) dedup[dedup.length - 1] = turn; continue; }
    }
    dedup.push(turn);
  }
  return { turns: dedup, pre };
}
// 过程旁白条数（viewRead 据此决定要不要显示「过程旁白」开关）
function countAside(body) { return parseTurns(body).turns.filter((turn) => turn.aside).length; }
function renderConversation(body, cap = Infinity) {
  const { turns, pre } = parseTurns(body);
  if (!turns.length) return null;
  const preHtml = pre.join("\n").trim() ? `<div class="doc">${renderMd(pre.join("\n"))}</div>` : "";
  const shown = Math.min(turns.length, cap);                    // 超长对话先渲前 cap 条，避免一次塞几千 DOM
  const more = turns.length > shown ? `<button class="btn-ghost conv-more" id="conv-expand">${esc(t("conv.more", turns.length - shown))}</button>` : "";
  return `<div class="conv">${preHtml}${turns.slice(0, shown).map(renderTurn).join("")}</div>${more}`;
}
function splitFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const ln of m[1].split("\n")) { const i = ln.indexOf(":"); if (i > 0) meta[ln.slice(0, i).trim()] = ln.slice(i + 1).trim().replace(/^(["'])([\s\S]*)\1$/, "$2"); }
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
const loading = (label = t("loading")) => `<div class="view"><div class="notice"><span class="spinner"></span> ${esc(label)}…</div></div>`;
const loadingInline = (l = t("loading")) => `<div class="notice"><span class="spinner"></span> ${esc(l)}…</div>`;
const emptyNote = (msg) => `<div class="notice"><span class="muted small">${esc(msg)}</span></div>`;  // 统一空态
function errView(e) {
  if (e.code === 401) return connectPrompt();
  return `<div class="view"><div class="notice err"><strong>${esc(t("err.title"))}</strong><br>${esc(e.message)}</div></div>`;
}
function connectPrompt() {
  return `<div class="view"><div class="notice">
    <strong>${esc(t("connect.first"))}</strong>
    <p class="muted small" style="margin:8px 0 16px">${esc(t("connect.desc"))}</p>
    <button class="btn" data-action="openTokenModal">${esc(t("connect.btn"))}</button>
  </div></div>`;
}
const crumb = (...parts) => `<div class="crumb">${parts.map((p, i) => (i ? `<span class="sep">/</span>` : "") + p).join("")}</div>`;
const crumbHome = () => `<a href="#/">${esc(t("nav.overview"))}</a>`;

// 图标集（line 风格，currentColor 描边；GitHub 沿用其官方实心 mark）。详情页操作条统一用它。
const ICONS = {
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 13h.01M15 13h.01M2 14h2M20 14h2"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>`,
  github: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>`,
  gitlab: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"/></svg>`,
  gitea: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v2M11 2v3M14 3v2"/></svg>`,
};
// 图标按钮：图标 + 标签竖排；title 给完整说明（hover 原生 tooltip + 无障碍）。tag 可为 a（外链）或 button。
function actBtn(icon, label, { tag = "button", cls = "", attrs = "", title = label } = {}) {
  return `<${tag} class="act-btn ${cls}" title="${esc(title)}" aria-label="${esc(title)}" ${attrs}>` +
    `<span class="act-ico">${ICONS[icon]}</span><span class="act-label">${esc(label)}</span></${tag}>`;
}
// 分享：①投喂（复制现成话术，含 path，粘进 Claude Code/Codex 即用已有 read 工具喂给你的 agent）②链接（人与人）。
// 复制走 data-copy 委托（见 init），CSP 友好。
function shareBtns(url, agentMsg) {
  return actBtn("agent", t("act.feed"), { cls: "act-primary", title: t("act.feedTitle"), attrs: `type="button" data-copy="${esc(agentMsg)}" data-done="${esc(t("act.copied"))}"` }) +
    actBtn("link", t("act.link"), { title: t("act.linkTitle"), attrs: `type="button" data-copy="${esc(url)}" data-done="${esc(t("act.copied"))}"` });
}

/* ============================================================ 总览（默认 dashboard） ============================================================ */
async function viewOverview() {
  main.innerHTML = `<div class="view">
    <div class="dash-head">
      <h1>${esc(t("ov.title"))}</h1>
      <p class="sub">${esc(t("ov.sub"))}</p>
    </div>
    <div class="stats" id="ov-stats">
      ${[t("stat.repos"), t("stat.sessions"), t("stat.docs"), t("stat.attention")].map((l, i) =>
        `<div class="stat"><div class="n${i === 0 ? " accent" : ""}">—</div><div class="l">${esc(l)}</div></div>`).join("")}
    </div>

    <div class="cols2">
      <div>
        <div class="section-head"><h2>${esc(t("ov.recentActivity"))}</h2><a href="#/sessions">${esc(t("ov.allSessions"))}</a></div>
        <div id="ov-activity">${loadingInline(t("load.activity"))}</div>
      </div>
      <div>
        <div class="section-head"><h2>${esc(t("ov.attentionHead"))}</h2><a href="#/repos">${esc(t("ov.allRepos"))}</a></div>
        <div id="ov-unpushed">${loadingInline(t("load.scanCode"))}</div>
        <div class="section-head" style="margin-top:var(--sp-8)"><h2>${esc(t("ov.recentDocs"))}</h2><a href="#/docs">${esc(t("ov.feishuDocs"))}</a></div>
        <div id="ov-docs">${loadingInline(t("load.docs"))}</div>
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
    const active = spaces.filter((e) => isRepoSpace(e.name) && e.active).length;
    const docs = (feishu.entries || []).reduce((a, e) => a + (e.children || 0), 0);
    setStat(0, active); setStat(1, ses.total ?? 0); setStat(2, docs);
    const act = $("#ov-activity");
    if (act) act.innerHTML = (lg.commits || []).length ? timelineHtml(lg.commits) : emptyNote(t("ov.noActivity"));
  });

  // 未推进度：扫活跃 github 仓的 code-state（并发受限）→ 同时回填「待关注」统计
  getSpaces().then(async (spaces) => {
    const box = $("#ov-unpushed"); if (!box) return;
    const active = spaces.filter((e) => isRepoSpace(e.name) && e.active);
    if (!active.length) { box.innerHTML = emptyNote(t("ov.noActiveRepos")); setStat(3, 0); return; }
    const rows = await pmap(active, async (sp) => {
      const v = await getCodeState(sp.name); if (!v) return null;
      const leads = v.cs.branches.filter((b) => b.leads); return leads.length ? { key: sp.name, leads } : null;
    }, 5);
    const hit = rows.filter(Boolean);
    setStat(3, hit.length, "warn");
    box.innerHTML = hit.length ? `<div class="list">${hit.map((r) => `<a class="row" href="#/repo/${enc(r.key)}">
        <div class="r-top"><span class="who">${esc(spaceLabel(r.key).name)}</span><span class="badge warn">${esc(t("ov.branchesUnpushed", r.leads.length))}</span></div>
        <div class="r-meta">${r.leads.map((b) => esc(b.name)).join(" · ")}</div></a>`).join("")}</div>`
      : emptyNote(t("ov.allPushed"));
  });

  // 最近文档：一次 /find?meta=1 拿全部 .md 的 frontmatter（服务端读，免客户端 N+1）
  (async () => {
    const box = $("#ov-docs"); if (!box) return;
    let files = [];
    try { files = (await api("/find", { path: "feishu", name: "*.md", meta: 1, limit: 200 })).files || []; } catch {}
    if (!files.length) { box.innerHTML = emptyNote(t("ov.noMirror")); return; }
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
  main.innerHTML = loading(t("load.repos"));
  let spaces; try { spaces = await getSpaces(); } catch (e) { main.innerHTML = errView(e); return; }
  const gh = spaces.filter((e) => isRepoSpace(e.name));
  const active = gh.filter((e) => e.active).sort((a, b) => (b.last_active || "").localeCompare(a.last_active || ""));  // 最近活动倒序
  const reg = gh.filter((e) => !e.active);
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<span class="cur">${esc(t("nav.repos"))}</span>`)}
    <div class="page-head"><h1>${esc(t("repos.title"))}</h1><p class="sub">${esc(t("repos.sub"))}</p></div>
    <div class="section-head"><h2>${esc(t("repos.active", active.length))}</h2></div>
    <div class="cards" id="repos-active">${active.length ? active.map(repoCard).join("") : emptyNote(t("repos.noActive"))}</div>
    ${reg.length ? `<div class="section-head" style="margin-top:var(--sp-9)"><h2>${esc(t("repos.registered", reg.length))}</h2></div><div class="cards">${reg.map(repoCard).join("")}</div>` : ""}
  </div>`;
  highlightSidebar();
  // 给活跃仓异步补「未推进度」徽标（走 code-state 缓存）
  pmap(active, async (sp) => {
    try { const v = await getCodeState(sp.name); if (!v) return;
      const leads = v.cs.branches.filter((b) => b.leads).length;
      if (leads) { const el = document.querySelector(`[data-repo="${sp.name}"] .repo-badge`); if (el) el.innerHTML = ` · <span class="unpushed">${esc(t("repos.unpushedBadge", leads))}</span>`; }
    } catch {}
  }, 5);
}
function repoCard(e) {
  const lbl = spaceLabel(e.name);
  const agoStr = e.last_active ? ago(e.last_active) : "—";
  const ico = ICONS[lbl.kind] ? lbl.kind : "github";   // kind: github / gitlab / gitea → 右侧 provider 小图标
  return `<a class="card" data-repo="${esc(e.name)}" href="#/repo/${enc(e.name)}">
    <div class="ct">
      <span class="sp-dot${e.active ? " on" : ""}"></span>
      <span class="name" title="${esc(lbl.name)}">${esc(lbl.name)}</span>
      <span class="card-ico" title="${esc(lbl.provider || "")}" aria-label="${esc(lbl.provider || "")}">${ICONS[ico]}</span>
    </div>
    <div class="cmeta">${e.active ? esc(t("card.meta", e.sessions ?? 0, agoStr, e.people)) : esc(t("card.registeredOnly"))}<span class="repo-badge"></span></div>
  </a>`;
}

// code-state 区块：有结构化数据→渲染分支/PR；只有原始 md→渲染 md；都没有→提示。ghUrl 用来拼分支/commit/PR 链接。
function codeStateSection(cs, hasCS, csText, ghUrl) {
  if (cs && !cs.noAccess) {
    const branches = cs.branches.length ? cs.branches.map((b) => `<div class="branch">
        <a class="bn" href="${esc(ghUrl)}/tree/${esc(b.name)}" target="_blank" rel="noopener">${esc(b.name)}</a>
        <a class="bsha" href="${esc(ghUrl)}/commit/${esc(b.sha)}" target="_blank" rel="noopener">${esc(b.sha)}</a>
        <span class="bmsg">${esc(b.msg)}</span>
        ${b.leads ? `<span class="badge warn" title="${esc(t("cs.unpushedTitle"))}">${esc(t("cs.unpushed"))}</span>` : ""}
        <span class="bwhen">${esc((b.when || "").slice(0, 16))}</span>
      </div>`).join("") : `<div class="muted small">${esc(t("cs.noBranches"))}</div>`;
    const pulls = cs.pulls.length ? cs.pulls.map((p) => `<a class="pr" href="${esc(ghUrl)}/pull/${esc(p.n)}" target="_blank" rel="noopener">
        <span class="pn">#${esc(p.n)}</span><span style="flex:1">${esc(p.title)}</span>
        <span class="bwhen">${esc(p.head)} → ${esc(p.base)}</span></a>`).join("") : `<div class="muted small">${esc(t("cs.noPR"))}</div>`;
    return `<div class="section-head" style="margin-top:26px"><h2>${esc(t("cs.activeBranches"))}</h2></div>${branches}
      <div class="section-head" style="margin-top:22px"><h2>${esc(t("cs.openPR"))}</h2></div>${pulls}`;
  }
  if (hasCS) return `<div class="notice" style="margin-top:22px">${renderMd(csText)}</div>`;
  return `<div class="notice" style="margin-top:22px"><span class="muted small">${esc(t("cs.none"))}</span></div>`;
}

async function viewRepo(key) {
  main.innerHTML = loading(t("load.repo"));
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
  const ghUrl = repoUrlFromRef(meta.ref) || `https://${spaceLabel(key).host || "github.com"}/${name}`;

  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<a href="#/repos">${esc(t("nav.repos"))}</a>`, `<span class="cur">${esc(name)}</span>`)}
    <div class="repo-head">
      <div>
        <h1>${esc(name)}</h1>
        <div class="sub" style="margin-top:var(--sp-1)">
          ${meta.visibility ? `<span class="badge">${esc(meta.visibility)}</span> ` : ""}
          ${meta.default_branch ? `${esc(t("repo.defaultBranch"))} <code>${esc(meta.default_branch)}</code> · ` : ""}${esc(t("repo.sessionsCount", sessions.length))}
        </div>
      </div>
      <a class="btn-ghost" href="${esc(ghUrl)}" target="_blank" rel="noopener">${esc(t("repo.openGithub"))}</a>
    </div>

    ${codeStateSection(cs, hasCS, csText, ghUrl)}

    <div class="section-head" style="margin-top:var(--sp-10)"><h2>${esc(t("repo.sessions"))}</h2><a href="#/sessions?space=${enc(key)}">${esc(t("repo.filterInRepo"))}</a></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s)).join("") : emptyNote(t("repo.noSessions"))}</div>
  </div>`;
  highlightSidebar();
}

/* ============================================================ 本地草稿 space（个人桶，从「人」进来） ============================================================ */
async function viewSpace(key) {
  main.innerHTML = loading(t("load.generic"));
  const { name } = spaceLabel(key);
  let sessions = []; try { sessions = (await api("/sessions", { space: key, limit: 200 })).sessions || []; } catch (e) { main.innerHTML = errView(e); return; }
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<a href="#/people">${esc(t("nav.people"))}</a>`, `<span class="cur">${esc(name)} ${esc(t("space.crumbSuffix"))}</span>`)}
    <div class="page-head"><h1>${esc(name)} <span class="tag local">${esc(t("space.tag"))}</span></h1>
    <p class="sub">${esc(t("space.sub", sessions.length))}</p></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s, { showFolder: true })).join("") : emptyNote(t("space.empty"))}</div>
  </div>`;
  highlightSidebar();
}

function sessionRow(s, { showRepo = false, showFolder = false } = {}) {
  const who = nameOf(s.producer_id || s.author || "?");   // 与 viewPeople 聚合键一致（producer_id 优先）
  const repo = showRepo && s.space_key ? `<span class="tag ${isRepoSpace(s.space_key) ? "gh" : "local"}">${esc(spaceLabel(s.space_key).name)}</span>` : "";
  const branch = s.branch ? ` · ${s.branch}` : "";
  const folder = showFolder && s.folder ? ` · ${s.folder}` : "";
  return `<a class="row" href="#/read?path=${enc(s.path)}">
    <div class="r-top">
      <span class="who">${esc(who)}</span>${repo}
      ${s.tool ? `<span class="tag">${esc(s.tool)}</span>` : ""}
      <span class="when">${esc(ago(s.work_end))}</span>
    </div>
    <div class="r-prev">${esc(s.preview || t("row.noPreview"))}</div>
    <div class="r-meta">${esc(fmtDate(s.work_start))} → ${esc(fmtDate(s.work_end))}${esc(branch)}${esc(folder)}</div>
  </a>`;
}

/* ============================================================ 会话（全局浏览） ============================================================ */
async function viewSessions(q) {
  const [roster, spaces] = await Promise.all([getRoster(), getSpaces()]).catch(() => [[], []]);
  const ghRepos = (spaces || []).filter((e) => isRepoSpace(e.name));
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<span class="cur">${esc(t("nav.sessions"))}</span>`)}
    <div class="page-head"><h1>${esc(t("ses.title"))}</h1><p class="sub">${esc(t("ses.sub"))}</p></div>
    <div class="filters">
      <select id="f-author"><option value="">${esc(t("ses.allPeople"))}</option>${(roster || []).map((m) => `<option value="${esc(m.id)}" ${q.author === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <select id="f-space"><option value="">${esc(t("ses.allRepos"))}</option>${ghRepos.map((e) => `<option value="${esc(e.name)}" ${q.space === e.name ? "selected" : ""}>${esc(spaceLabel(e.name).name)}</option>`).join("")}</select>
      <input id="f-since" placeholder="${esc(t("ses.sincePh"))}" value="${esc(q.since || "")}">
      <button class="btn-ghost" data-action="applySessions">${esc(t("ses.filter"))}</button>
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
  if (!all.length) { box.innerHTML = emptyNote(t("ses.noMatch")); highlightSidebar(); return; }
  const pages = Math.ceil(all.length / PAGE_SIZE);
  const cur = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  const slice = all.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  box.innerHTML = `<div class="muted small" style="margin-bottom:8px">${esc(t("ses.summary", data.total, all.length, !!data.truncated, cur, pages))}</div>
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
    ? `<span class="pager-btn off">${esc(label)}</span>`
    : `<a class="pager-btn" href="${sesHref(q, page)}">${esc(label)}</a>`;
  let nums = "";
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - cur) <= 2)
      nums += i === cur ? `<span class="pager-btn cur">${i}</span>` : `<a class="pager-btn" href="${sesHref(q, i)}">${i}</a>`;
    else if (Math.abs(i - cur) === 3) nums += `<span class="pager-gap">…</span>`;
  }
  return `<div class="pager">${btn(t("pager.prev"), cur - 1, cur <= 1)}${nums}${btn(t("pager.next"), cur + 1, cur >= pages)}</div>`;
}

/* ============================================================ 人 ============================================================ */
async function viewPeople() {
  main.innerHTML = loading(t("load.members"));
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
    ${crumb(crumbHome(), `<span class="cur">${esc(t("nav.people"))}</span>`)}
    <div class="page-head"><h1>${esc(t("people.title"))}</h1><p class="sub">${esc(t("people.sub"))}</p></div>
    <div class="cards">${people.map((p) => `<a class="card" href="#/person/${enc(p.id)}">
      <div class="ct"><span class="name">${esc(p.name)}</span>${p.id !== p.name ? `<span class="tag">${esc(p.id)}</span>` : ""}</div>
      <div class="cmeta">${esc(t("people.cardMeta", p.n, p.repos.size, p.last ? ago(p.last) : ""))}</div>
    </a>`).join("")}</div>
  </div>`;
  highlightSidebar();
}

async function viewPerson(id) {
  main.innerHTML = loading(t("load.generic"));
  await getRoster();
  let sessions = []; try { sessions = (await api("/sessions", { author: id, limit: 300 })).sessions || []; } catch (e) { main.innerHTML = errView(e); return; }
  const repos = [...new Set(sessions.filter((s) => isRepoSpace(s.space_key)).map((s) => s.space_key))];
  const hasLocal = sessions.some((s) => s.space_key === `local__${id}`) || (state.spaces || []).some((e) => e.name === `local__${id}`);
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<a href="#/people">${esc(t("nav.people"))}</a>`, `<span class="cur">${esc(nameOf(id))}</span>`)}
    <div class="page-head"><h1>${esc(nameOf(id))} ${id !== nameOf(id) ? `<span class="tag" style="vertical-align:middle">${esc(id)}</span>` : ""}</h1>
    <p class="sub">${esc(t("person.sub", sessions.length, repos.length, hasLocal))}</p></div>
    ${repos.length ? `<div class="section-head"><h2>${esc(t("person.touchedRepos"))}</h2></div><div class="cards" style="margin-bottom:var(--sp-8)">${repos.map((k) => `<a class="card" href="#/repo/${enc(k)}"><div class="ct"><span class="name">${esc(spaceLabel(k).name)}</span><span class="tag gh">${esc(spaceLabel(k).provider)}</span></div></a>`).join("")}${hasLocal ? `<a class="card" href="#/space/${enc("local__" + id)}"><div class="ct"><span class="name">${esc(id)}</span><span class="tag local">${esc(t("tag.draft"))}</span></div></a>` : ""}</div>` : ""}
    <div class="section-head"><h2>${esc(t("person.recentSessions"))}</h2></div>
    <div class="list">${sessions.length ? sessions.map((s) => sessionRow(s, { showRepo: true, showFolder: true })).join("") : emptyNote(t("person.noSessions"))}</div>
  </div>`;
  highlightSidebar();
}

/* ============================================================ 统计 ============================================================ */
// 大数压缩：1234→1.2k、3.45e6→3.5M（柱上读数）；title 里给精确值。
function fmtN(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
const STAT_BY = ["day", "week", "person", "space", "tool"];
const STAT_METRICS = ["tokens", "tokens_io", "tokens_in", "tokens_out", "cache", "sessions", "turns"];
const STAT_WINDOWS = ["7", "30", "90", "0"];
const STAT_PAGE = 20;   // 每页组数（day/week 倒序翻页主要用它）
// 取某组的指标读数（与服务端 metricOf 对齐）
function statMetricVal(row, metric) {
  switch (metric) {
    case "sessions": return row.sessions;
    case "turns": return row.turns;
    case "tokens_io": return (row.tokens_in || 0) + (row.tokens_out || 0);
    case "cache": return (row.tokens_cache_r || 0) + (row.tokens_cache_w || 0);
    case "tokens_in": return row.tokens_in;
    case "tokens_out": return row.tokens_out;
    default: return row.tokens_total;
  }
}
// 维度键 → 展示名（人用花名册名、仓用短名、其余原样）
function statKeyLabel(by, key) {
  if (by === "person") return nameOf(key);
  if (by === "space") return spaceLabel(key).name;
  return key;
}
// 维度键 → 展示名，支持组合键（按各维分别标注，· 连接）
function statRowLabel(dims, row) {
  const ks = row.keys || [row.key];
  return ks.map((k, i) => statKeyLabel(dims[i] || "", k)).join(" · ");
}
// 一行 pill 单选器（纯 <a> 链接改 hash，避免 inline JS，守 CSP）
function pillRow(label, param, cur, opts, q) {
  const pills = opts.map((o) => {
    const next = { ...q, [param]: o.val };
    const href = "#/stats?" + new URLSearchParams(next).toString();
    return `<a class="pill${o.val === cur ? " on" : ""}" href="${esc(href)}">${esc(o.label)}</a>`;
  }).join("");
  return `<div class="stat-ctl"><span class="stat-ctl-label">${esc(label)}</span><div class="pills">${pills}</div></div>`;
}
// 维度【多选】pill：点一下切换该维度的选中；规范成 STAT_BY 顺序（时间维领先）；至少留一个
function pillMulti(label, cur, opts, q) {
  const pills = opts.map((o) => {
    const on = cur.includes(o.val);
    let next = on ? cur.filter((v) => v !== o.val) : [...cur, o.val];
    if (!next.length) next = [o.val];
    next = STAT_BY.filter((d) => next.includes(d));
    const href = "#/stats?" + new URLSearchParams({ ...q, by: next.join(",") }).toString();
    return `<a class="pill${on ? " on" : ""}" href="${esc(href)}">${esc(o.label)}</a>`;
  }).join("");
  return `<div class="stat-ctl"><span class="stat-ctl-label">${esc(label)}</span><div class="pills">${pills}</div></div>`;
}

async function viewStats(q) {
  const by = STAT_BY.filter((d) => String(q.by || "day").split(",").map((s) => s.trim()).includes(d));
  if (!by.length) by.push("day");
  const byStr = by.join(",");
  const metric = STAT_METRICS.includes(q.metric) ? q.metric : "tokens";
  const days = STAT_WINDOWS.includes(q.days) ? q.days : "30";
  const qNorm = { by: byStr, metric, days };
  // 时间窗 → since（按工作时间，客户端算今天减 N 天；days=0 全部）
  let since;
  if (days !== "0") {
    const d = new Date(); d.setDate(d.getDate() - Number(days));
    since = d.toISOString().slice(0, 10);
  }
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<span class="cur">${esc(t("stats.title"))}</span>`)}
    <div class="page-head"><h1>${esc(t("stats.title"))}</h1><p class="sub">${esc(t("stats.sub"))}</p></div>
    <div class="stat-ctls">
      ${pillMulti(t("stats.by"), by, STAT_BY.map((v) => ({ val: v, label: t("stats.by." + v) })), qNorm)}
      ${pillRow(t("stats.metric"), "metric", metric, STAT_METRICS.map((v) => ({ val: v, label: t("stats.m." + v) })), qNorm)}
      ${pillRow(t("stats.window"), "days", days, STAT_WINDOWS.map((v) => ({ val: v, label: t("stats.win." + v) })), qNorm)}
    </div>
    <div id="stat-body"><div class="notice"><span class="spinner"></span> ${esc(t("loading"))}…</div></div>
  </div>`;
  highlightSidebar();

  const off = Math.max(0, Number(q.off) || 0);     // 翻页偏移（pill 切维度不带它 → 自动回第 1 页）
  await getRoster().catch(() => {});   // by=person 的柱标用花名册名（拿不到就退回 id）
  let r;
  try { r = await api("/stats", { by: byStr, metric, since, limit: STAT_PAGE, offset: off }); }
  catch (e) { $("#stat-body").innerHTML = errView(e); return; }

  const rows = r.rows || [];
  if (!rows.length) { $("#stat-body").innerHTML = emptyNote(t("stats.empty")); return; }
  const dims = r.dims || by;
  const scale = Math.max(1, r.peak || 0, ...rows.map((row) => statMetricVal(row, metric)));   // 全量峰值缩放 → 跨页柱子可比
  const isTokenMetric = !["sessions", "turns"].includes(metric);
  const bars = rows.map((row) => {
    const v = statMetricVal(row, metric);
    const pct = Math.max(v > 0 ? 1.5 : 0, (v / scale) * 100);   // 给非零值留一丝可见宽度
    const tip = isTokenMetric ? t("stats.tokTip", row.tokens_in, row.tokens_out, (row.tokens_cache_r || 0) + (row.tokens_cache_w || 0)) : `${row.sessions} session · ${row.turns} 轮`;
    return `<div class="stat-bar-row">
      <div class="stat-bar-key" title="${esc(row.key)}">${esc(statRowLabel(dims, row))}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
      <div class="stat-bar-val" title="${esc(tip)}">${esc(fmtN(v))}</div>
    </div>`;
  }).join("");
  const T = r.totals || {};
  const totVal = statMetricVal(T, metric);
  const cov = r.coverage || { sessions: 0, with_usage: 0 };
  const codexNote = cov.with_usage < cov.sessions ? `<p class="stat-note">${esc(t("stats.codexNote"))}</p>` : "";
  // 翻页条：上一页/下一页 <a> 改 hash（带回 by/metric/days + off），到头就置灰
  const total = r.total ?? rows.length, shown = rows.length;
  const pageHref = (o) => "#/stats?" + new URLSearchParams({ ...qNorm, off: o }).toString();
  const pager = total > shown || off > 0 ? `<div class="stat-pager">
    ${off > 0 ? `<a class="pg-btn" href="${esc(pageHref(Math.max(0, off - STAT_PAGE)))}">${esc(t("stats.prev"))}</a>` : `<span class="pg-btn off">${esc(t("stats.prev"))}</span>`}
    <span class="pg-info">${esc(t("stats.page", off + 1, off + shown, total))}</span>
    ${off + shown < total ? `<a class="pg-btn" href="${esc(pageHref(off + STAT_PAGE))}">${esc(t("stats.next"))}</a>` : `<span class="pg-btn off">${esc(t("stats.next"))}</span>`}
  </div>` : "";
  $("#stat-body").innerHTML = `
    <div class="stat-summary">
      <span class="stat-total">${esc(t("stats.total"))}: <b>${esc(fmtN(totVal))}</b> ${esc(t("stats.m." + metric))}</span>
      <span class="stat-cov">${esc(t("stats.coverage", cov.sessions, cov.with_usage))}</span>
    </div>
    <div class="stat-bars">${bars}</div>
    ${pager}
    ${codexNote}`;
}

/* ============================================================ 活动流（时间线零件，总览复用） ============================================================ */
function timelineHtml(commits) {
  return `<div class="timeline">${commits.map((c) => {
    const m = c.subject.match(/spaces\/[A-Za-z0-9_./-]+\.(?:md|jsonl)/) || c.subject.match(/(github__|gitlab__|gitea__|local__)[A-Za-z0-9_.-]+/);
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
    ${crumb(crumbHome(), `<span class="cur">${esc(t("search.crumb"))}</span>`, ...(space ? [`<span>${esc(spaceLabel(space).name)}</span>`] : []))}
    <div class="page-head"><h1>${esc(t("search.title"))}</h1><p class="sub">${esc(t("search.sub"))}</p></div>
    <div class="filters">
      <input id="s-q" placeholder="${esc(t("search.qPh"))}" value="${esc(term)}" style="flex:1;min-width:240px" autofocus>
      <label class="muted small" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="s-raw" ${q.raw ? "checked" : ""}> ${esc(t("search.raw"))}</label>
      <button class="btn" data-action="applySearch">${esc(t("search.btn"))}</button>
    </div>
    <div id="gres">${term ? loadingInline(t("search.go")) : `<div class="muted small">${esc(t("search.hint"))}</div>`}</div>
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
  if (!text) return emptyNote(t("grep.noMatch"));
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
      ? `<a class="gf-head" href="#/read?path=${enc(path)}"><span class="gf-path">${esc(path)}</span><span class="gf-n">${esc(t("grep.hits", n))}</span></a>`
      : `<div class="gf-head"><span class="gf-path">${esc(path)}</span><span class="gf-n">${esc(t("grep.hits", n))}</span></div>`;
    return `<div class="gfile">${head}${lineHtml}</div>`;
  }).join("");
  return `<div class="gres">${r.truncated ? `<div class="muted small" style="margin-bottom:4px">${esc(t("grep.truncated"))}</div>` : ""}${html}</div>`;
}

/* ============================================================ 读文件（session / 文档 / code-state） ============================================================ */
async function viewRead(q) {
  const path = q.path || "";
  if (!path) { main.innerHTML = errView(new Error(t("read.missingPath"))); return; }
  main.innerHTML = loading(t("load.read"));
  let data; try { [data] = await Promise.all([api("/read", { path }), getRoster()]); } catch (e) { main.innerHTML = errView(e); return; }
  const { meta, body } = splitFm(data.text);
  const parts = path.split("/");
  const spaceKey = parts[0] === "spaces" ? parts[1] : null;
  const branch = spaceKey && parts[2] === "sessions" ? parts[3] : null;
  const isSession = spaceKey && parts[2] === "sessions";
  const conv = isSession ? renderConversation(body, 80) : null;   // session → 分说话人对话块（超长先渲前 80 条）；否则普通文档
  const asideN = isSession ? countAside(body) : 0;                 // 过程旁白条数（>0 才显示开关）
  const shareUrl = location.origin + location.pathname + "#/read?path=" + enc(path);   // 人与人分享：可点开的网页链接
  const agentMsg = t("read.agentMsg", path);   // 给 Agent：现成话术（含 path，agent 用已有 read 工具取全文）
  const title = meta.title || parts[parts.length - 1];
  // session：链回它所属仓库 + 分支 → 图标按钮（github/gitlab/gitea）
  let ghBtn = "";
  if (isRepoSpace(spaceKey)) {
    const lbl = spaceLabel(spaceKey);
    const base = repoUrlFromRef(meta.ref) || `https://${lbl.host || "github.com"}/${lbl.name}`;
    const href = (lbl.kind === "github" && branch) ? base + "/tree/" + branch : base;   // 分支深链各家路径不同 → 仅 github 拼，其余回仓根
    ghBtn = actBtn("github", t("act.code"), { tag: "a", title: t("act.codeTitle", branch || ""), attrs: `href="${esc(href)}" target="_blank" rel="noopener"` });
  }
  const feishuBtn = (meta.url && /^https?:/.test(meta.url))
    ? actBtn("external", t("act.feishu"), { tag: "a", title: t("act.feishuTitle"), attrs: `href="${esc(meta.url)}" target="_blank" rel="noopener"` }) : "";
  const crumbParts = [crumbHome()];
  if (spaceKey) crumbParts.push(`<a href="${spaceHref(spaceKey)}">${esc(spaceLabel(spaceKey).name)}</a>`);
  else if (parts[0] === "feishu") crumbParts.push(`<a href="#/docs">${esc(t("nav.docs"))}</a>`);
  crumbParts.push(`<span class="cur">${esc(parts[parts.length - 1])}</span>`);

  main.innerHTML = `<div class="view view-doc">
    ${crumb(...crumbParts)}
    <div class="doc-actions">
      ${shareBtns(shareUrl, agentMsg)}${ghBtn}${feishuBtn}
      ${asideN ? actBtn("eye", t("act.aside"), { title: t("act.asideTitle", asideN), attrs: `type="button" id="aside-toggle"` }) : ""}
      ${actBtn("code", t("act.raw"), { title: t("act.rawTitle"), attrs: `type="button" id="raw-toggle"` })}
    </div>
    <div class="repo-head"><h1 style="line-height:1.3">${esc(title)}</h1></div>
    ${Object.keys(meta).length ? `<details class="meta-card"><summary>${metaSummary(meta)}</summary><div class="meta-grid">${metaCard(meta)}</div></details>` : ""}
    <div id="doc-body">${conv || `<div class="doc">${renderMd(body)}</div>`}</div>
    <div class="raw" id="raw-body" hidden><pre><code>${esc(data.text)}</code></pre></div>
  </div>`;
  $("#conv-expand")?.addEventListener("click", () => { $("#doc-body").innerHTML = renderConversation(body); });  // 展开全部对话
  // 过程旁白开关：切 #doc-body 的 show-aside 类（CSS 控制 .turn-aside 显隐）。类挂在 doc-body 本身，
  // 展开剩余对话只改 innerHTML 不动这个类 → 状态不丢。
  const asideBtn = $("#aside-toggle");
  asideBtn?.addEventListener("click", () => {
    const on = $("#doc-body").classList.toggle("show-aside");
    asideBtn.classList.toggle("act-on", on);   // 标签固定「旁白」，开启态用绿色描边表示
  });
  const tog = $("#raw-toggle");
  tog.addEventListener("click", () => {
    const raw = $("#raw-body"), doc = $("#doc-body"), hidden = raw.hasAttribute("hidden");
    raw.toggleAttribute("hidden", !hidden); doc.toggleAttribute("hidden", hidden);
    tog.classList.toggle("act-on", hidden);
    const lbl = tog.querySelector(".act-label"); if (lbl) lbl.textContent = hidden ? t("act.rendered") : t("act.raw");
  });
  highlightSidebar();
}
// 元数据折叠后的一行摘要：谁 · 时间 · 分支 · 工具
function metaSummary(meta) {
  const bits = [];
  const who = meta.producer || meta.submitter || meta.author;
  if (who) bits.push(esc(who));
  if (meta.date || meta.updated) bits.push(esc(fmtDate(meta.updated || meta.date)));
  if (meta.branch && meta.branch !== "-") bits.push(esc(meta.branch));
  if (meta.tool) bits.push(esc(meta.tool));
  return bits.length ? bits.join(" · ") : esc(t("meta.detail"));
}
function metaCard(meta) {
  const order = ["producer", "submitter", "author", "space_key", "branch", "folder", "tool", "date", "updated", "url", "edited", "ref", "visibility", "default_branch"];
  const keys = [...new Set([...order.filter((k) => meta[k]), ...Object.keys(meta)])];
  return keys.map((k) => {
    let v = meta[k]; if (!v) return "";
    if ((k === "url") && /^https?:/.test(v)) v = `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(t("meta.feishuOriginal"))}</a>`;
    else if ((k === "date" || k === "updated" || k === "edited") && /\d{4}/.test(v)) v = esc(fmtDate(v));
    else v = esc(v);
    return `<div><div class="mk">${esc(k)}</div><div class="mv">${v}</div></div>`;
  }).join("");
}

/* ============================================================ 文档（飞书） ============================================================ */
async function viewDocs(q) {
  const path = q.path || "feishu";
  main.innerHTML = loading(t("load.docs"));
  let entries;
  try { entries = (await api("/ls", { path })).entries || []; }
  catch (e) {
    if (e.code === 401) { main.innerHTML = errView(e); return; }
    main.innerHTML = `<div class="view">${crumb(crumbHome(), `<span class="cur">${esc(t("nav.docs"))}</span>`)}
      <div class="notice">${esc(t("docs.noMirror"))}<p class="muted small" style="margin-top:8px">${esc(t("docs.noMirrorDesc"))}</p></div></div>`;
    highlightSidebar(); return;
  }
  const rel = path.replace(/^feishu\/?/, "");
  const dirs = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  const segCrumbs = rel ? rel.split("/").map((seg, i, arr) => { const p = "feishu/" + arr.slice(0, i + 1).join("/"); return i === arr.length - 1 ? `<span class="cur">${esc(kbName(seg))}</span>` : `<a href="#/docs?path=${enc(p)}">${esc(kbName(seg))}</a>`; }) : [];
  main.innerHTML = `<div class="view">
    ${crumb(crumbHome(), `<a href="#/docs">${esc(t("nav.docs"))}</a>`, ...segCrumbs)}
    <div class="page-head"><h1>${rel ? esc(kbName(rel.split("/").pop())) : esc(t("docs.title"))}</h1></div>
    ${dirs.length ? `<div class="section-head"><h2>${esc(t("docs.wikis"))}</h2></div><div class="cards" style="margin-bottom:var(--sp-9)">${dirs.map((d) => `<a class="card" href="#/docs?path=${enc(path.replace(/\/$/, "") + "/" + d.name)}"><div class="ct"><span class="name">📚 ${esc(kbName(d.name))}</span></div><div class="cmeta">${esc(t("docs.items", d.children ?? 0))}</div></a>`).join("")}</div>` : ""}
    ${files.length ? `<div class="section-head"><h2>${esc(t("docs.docs"))}</h2></div><div class="list">${files.map((f) => `<a class="row" href="#/read?path=${enc(path.replace(/\/$/, "") + "/" + f.name)}"><div class="r-prev">📄 ${esc(docName(f.name))}</div></a>`).join("")}</div>` : ""}
    ${!dirs.length && !files.length ? emptyNote(t("docs.empty")) : ""}
  </div>`;
  highlightSidebar();
}

/* ============================================================ 侧栏 ============================================================ */
async function loadSidebar() {
  const box = $("#spaces-list");
  if (!box) return;
  if (!getToken()) { box.innerHTML = `<div class="muted small pad">${esc(t("side.connectToShow"))}</div>`; return; }
  let spaces; try { spaces = await getSpaces(); } catch { box.innerHTML = `<div class="muted small pad">${esc(t("side.loadFail"))}</div>`; return; }
  const gh = spaces.filter((e) => isRepoSpace(e.name));
  const active = gh.filter((e) => e.active).sort((a, b) => (b.last_active || "").localeCompare(a.last_active || ""));  // 最近活动倒序
  box.innerHTML = (active.length ? active.map(spaceRowSide).join("") : `<div class="muted small pad">${esc(t("side.noActive"))}</div>`)
    + `<a class="space-row" href="#/repos" style="color:var(--muted)"><span class="sp-name">${esc(t("side.viewAll"))}</span></a>`;
  highlightSidebar();
}
function spaceRowSide(e) {
  return `<a class="space-row is-active" data-key="${esc(e.name)}" href="#/repo/${enc(e.name)}">
    <span class="sp-dot"></span><span class="sp-name">${esc(spaceLabel(e.name).name)}</span><span class="sp-count">${e.last_active ? ago(e.last_active) : ""}</span>
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
    if (path === "/stats") return void await viewStats(q);
    if (path.startsWith("/person/")) return void await viewPerson(decodeURIComponent(path.slice("/person/".length)));
    if (path === "/docs") return void await viewDocs(q);
    if (path === "/search") return void await viewSearch(q);
    if (path === "/read") return void await viewRead(q);
    if (path.startsWith("/space/")) return void await viewSpace(decodeURIComponent(path.slice("/space/".length)));
    main.innerHTML = `<div class="view"><div class="notice">${esc(t("route.unknown"))} <a href="#/" style="color:var(--green)">${esc(t("route.backHome"))}</a></div></div>`;
  } catch (e) { main.innerHTML = errView(e); }
}

/* ============================================================ token ============================================================ */
function refreshTokenChip() {
  const chip = $("#token-chip"), label = $("#token-label");
  if (!chip || !label) return;
  if (state.me) { chip.classList.add("on"); label.textContent = state.me.name || state.me.id; }
  else { chip.classList.remove("on"); label.textContent = getToken() ? t("token.invalid") : t("token.notConnected"); }
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
  applyStaticI18n();   // 先把静态文案刷成当前语言（默认英文）

  $("#lang-toggle")?.addEventListener("click", () => setLang(lang === "en" ? "zh" : "en"));

  $("#token-chip").addEventListener("click", openTokenModal);
  $("#token-save").addEventListener("click", async () => {
    const v = $("#token-input").value.trim(); if (!v) return;
    localStorage.setItem(TOKEN_KEY, v); resetCaches();
    const err = $("#token-err"); err.hidden = true;
    const btn = $("#token-save"); btn.disabled = true; btn.textContent = t("token.verifying");
    try { state.me = await api("/whoami"); refreshTokenChip(); closeTokenModal(); await loadSidebar(); route(); }
    catch (e) { state.me = null; refreshTokenChip(); err.textContent = e.code === 401 ? t("token.invalidRetry") : e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = t("btn.connect"); }
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

  // 委托式按钮（替代内联 onclick → 满足严格 CSP script-src 'self'）。白名单挡住任意全局调用。
  const ACTIONS = { openTokenModal, applySessions: window.applySessions, applySearch: window.applySearch };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) ACTIONS[el.getAttribute("data-action")]?.();
  });
  // 分享按钮：复制 data-copy 到剪贴板，按钮短暂回显 data-done（HTTPS/localhost 才有 clipboard API）
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-copy]");
    if (!el) return;
    const lbl = el.querySelector(".act-label") || el;
    try {
      await navigator.clipboard.writeText(el.getAttribute("data-copy"));
      const prev = lbl.textContent;
      lbl.textContent = el.getAttribute("data-done") || t("act.copied");
      el.classList.add("act-done");   // 临时强制展开文字 + 变绿（图标态也看得见反馈）
      setTimeout(() => { el.classList.remove("act-done"); lbl.textContent = prev; }, 1500);
    } catch { lbl.textContent = t("act.copyFail"); el.classList.add("act-done"); }
  });

  window.addEventListener("hashchange", route);
  await whoami();
  await loadSidebar();
  route();
  if (!getToken()) openTokenModal();
}
init();
