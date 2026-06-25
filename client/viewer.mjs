// 本机查看器（M1）：采集常驻内嵌的 127.0.0.1 只读小服务，给「我的足迹」localhost 控制台供数据。
// 只绑 loopback + 本地 token；不碰上传逻辑。数据源：结果账本（core/ledger.mjs）+ 本机源文件实时投影。
// 预览用与服务端【同一套】core 函数（slim → projectSession），所以「脱敏后」与库里一字不差。
import http from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { parseSession } from "../core/parse.mjs";
import { slimRaw, slimRawFile } from "../core/slim.mjs";
import { projectSession } from "../core/project.mjs";
import { coordOf, expandHome } from "../core/coord.mjs";
import { allSessions, getByFile, recordSession, saveLedger } from "../core/ledger.mjs";
import { listOptout, addOptout, removeOptout } from "../core/optout.mjs";
import { listTerms, addTerm, removeTerm, countMatches } from "../core/userredact.mjs";
import { log } from "../core/log.mjs";
import { CLIENT_VERSION } from "../core/version.mjs";
import { stringify } from "yaml";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const RAW_CAP = 400 * 1024;   // 「本机原文」展示上限：截前 400KB，免得把几百 MB 的 codex 原文塞给浏览器
const FLAG_SCAN_CAP = 40;     // overview 自检：一次最多现扫 40 条未缓存的（其余等点开详情时再扫并缓存）

export function startViewer({ ROOT, cfg, paths }) {
  const WEB = join(ROOT, "web");
  const INFO = join(ROOT, ".brain-viewer.json");
  const ctx = { ROOT, WEB, cfg, paths };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => json(res, 500, { error: String(e?.message || e) }));
  });
  server.on("error", (e) => log.warn("viewer 监听异常", { err: e.message }));
  listen(server, Number(cfg.viewer_port) || 7878, 0, (port) => {
    writeFileSync(INFO, JSON.stringify({ port, url: `http://127.0.0.1:${port}/`, pid: process.pid }));
    log.info("本机查看器已起", { url: `http://127.0.0.1:${port}/` });
  });
  return server;
}

// 端口被占就 +1 重试（最多 20 次），只绑 127.0.0.1。
function listen(server, port, tries, onUp) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && tries < 20) { listen(server, port + 1, tries + 1, onUp); }
    else log.warn("viewer 起不来", { err: e.message });
  });
  server.listen(port, "127.0.0.1", () => onUp(port));
}

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

async function handle(req, res, ctx) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;

  // 不再用「本地 token 登录」（本机自己看自己的页面要 token 是多余摩擦）。
  // 本机 loopback 已是边界，再加两道守卫：① Host 必须是回环（挡 DNS rebinding）；
  // ② 带 Origin 的请求其 host 必须是回环（挡别的网站跨站打 127.0.0.1）。同源页面自身的请求都放行。
  const hostName = (req.headers.host || "").split(":")[0];
  if (hostName && hostName !== "127.0.0.1" && hostName !== "localhost") return json(res, 403, { error: "forbidden host" });
  const origin = req.headers.origin;
  if (origin) { let oh = ""; try { oh = new URL(origin).hostname; } catch {} if (oh !== "127.0.0.1" && oh !== "localhost") return json(res, 403, { error: "cross-site blocked" }); }

  // 静态：页面 + 资源
  if (p === "/") return serveFile(res, join(ctx.WEB, "viewer.html"));
  if (!p.startsWith("/api/")) {
    const f = join(ctx.WEB, p.replace(/^\/+/, ""));
    if (f.startsWith(ctx.WEB) && existsSync(f) && statSync(f).isFile()) return serveFile(res, f);
    return json(res, 404, { error: "not found" });
  }

  // GET
  if (req.method === "GET") {
    if (p === "/api/overview") return json(res, 200, overview(ctx));
    if (p === "/api/sessions") return json(res, 200, sessions(ctx));
    if (p === "/api/session") return json(res, 200, await sessionDetail(u.searchParams.get("file")));
    if (p === "/api/log") return json(res, 200, { lines: tailLog(ctx.ROOT, 1000).filter(meaningfulLog).slice(-200) });
    if (p === "/api/optout") return json(res, 200, { entries: listOptout() });
    if (p === "/api/redact") return json(res, 200, redactInfo());
    return json(res, 404, { error: "not found" });
  }
  // POST（前端发的是普通 JSON，不 gzip）
  if (req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readReq(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
    if (p === "/api/exclude") return json(res, 200, await excludeSession(ctx, body.file));
    if (p === "/api/unexclude") return json(res, 200, (removeOptout({ id: body.id, file: body.file }), { ok: true }));
    if (p === "/api/redact-add") return json(res, 200, (addTerm({ pattern: body.pattern, type: body.type }), { ok: true }));
    if (p === "/api/redact-remove") return json(res, 200, (removeTerm(body.pattern), { ok: true }));
    if (p === "/api/config-dryrun") return json(res, 200, configDryrun(ctx, body));
    if (p === "/api/config") return json(res, 200, saveConfig(ctx, body));
    return json(res, 404, { error: "not found" });
  }
  return json(res, 404, { error: "not found" });
}

const readReq = (req) => new Promise((resolve, reject) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); req.on("error", reject); });

function serveFile(res, f) {
  try {
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(readFileSync(f));
  } catch { json(res, 404, { error: "not found" }); }
}

// ---------- 闸门（与 sync.mjs 同逻辑，pending 实时扫描用）----------
const within = (path, f) => { const r = expandHome(f); return !!r && (path === r || path.startsWith(r.endsWith("/") ? r : r + "/")); };
function gateOf(cfg) {
  const excluded = (path) => (cfg.exclude || []).some((e) => within(path, e));
  const collectAll = !!cfg.collect_all;
  return (cwd) => !!cwd && !excluded(cwd) && (collectAll || (cfg.upload_folders || []).some((f) => within(cwd, f)));
}

// ---------- 坐标显示串 ----------
function coordStr(e) {
  if (e.space_key) return `${e.space_key}${e.branch ? " · " + e.branch : ""}`;
  const r = e.remote;
  const base = r ? `${r.host}/${r.owner}/${r.repo}` : (e.folder ? `local · ${e.folder}` : "local");
  return `${base}${e.branch ? " · " + e.branch : ""}`;
}
const toRow = (e) => ({
  file: e.file, id: e.id, tool: toolShort(e.tool), intent: e.intent || "（无意图）",
  coord: coordStr(e), time: e.work_end || e.work_start || null, status: e.status,
});
const toolShort = (t) => ({ "claude-code": "CC", "codex": "Codex", "trae-session-memory": "Trae", "session-history-md": "MD" }[t] || t);

// ---------- overview ----------
function overview(ctx) {
  const all = allSessions();
  const counts = { uploaded: 0, skipped: 0 };
  for (const e of all) if (e.status === "uploaded") counts.uploaded++; else if (e.status === "skipped") counts.skipped++;
  const pending = scanPending(ctx);
  return {
    me: ctx.cfg.me || {}, version: CLIENT_VERSION, server_url: ctx.cfg.server_url || "",
    device_token: ctx.cfg.token || "",          // 展示给本人，方便复制去网站登录（loopback only，仅本人可见）
    lastSync: lastTick(ctx.ROOT),
    counts: { uploaded: counts.uploaded, pending: pending.length, skipped: counts.skipped, localTotal: all.length + pending.length },
    config: pickConfig(ctx.cfg),
  };
}
function pickConfig(cfg) {
  return {
    collect_all: !!cfg.collect_all, upload_folders: cfg.upload_folders || [], exclude: cfg.exclude || [],
    codex: cfg.codex !== false, trae_memory: cfg.trae_memory !== false, session_history_md: cfg.session_history_md !== false,
    interval_sec: cfg.interval_sec ?? 60, debounce_sec: cfg.debounce_sec ?? 60,
  };
}

// ---------- sessions（已在库 + 实时派生的待传）----------
function sessions(ctx) {
  const uploaded = allSessions().filter((e) => e.status === "uploaded")
    .sort((a, b) => String(b.work_end || "").localeCompare(String(a.work_end || ""))).map(toRow);
  return { uploaded, pending: scanPending(ctx) };
}

// 「即将上传」实时派生：扫 CC/Codex 在去抖窗口内（还没稳定、下一轮才会传）且闸门内、尚未上传的文件。
// 不落账本（瞬态），只在 viewer 现算；按 mtime 近期性先筛、再 parse，控制开销。
function scanPending(ctx) {
  const gated = gateOf(ctx.cfg);
  const debounceMs = (ctx.cfg.debounce_sec ?? 60) * 1000;
  const out = [];
  const consider = (file, tool) => {
    let st; try { st = statSync(file); } catch { return; }
    if (Date.now() - st.mtimeMs >= debounceMs) return;          // 已稳定 → 不算待传（要么已传、要么已被处理）
    const e = getByFile(file); if (e && e.status === "uploaded" && e.mtime === st.mtimeMs) return;
    if (st.size > 8 * 1024 * 1024) return;                       // 太大不在 pending 里现 parse
    let s; try { s = parseSession(file); } catch { return; }
    if (!s.intent || !gated(s.cwd)) return;
    const c = coordOf(s.cwd, ctx.cfg.upload_folders);
    out.push({ file, id: basename(file).replace(/\.jsonl$/, ""), tool: toolShort(tool), intent: s.intent,
      coord: coordStr({ remote: c.remote, folder: c.folder, branch: s.branch }), time: s.updated || s.ts, status: "pending", flags: null });
  };
  const { CC_ROOT, CODEX_ROOT } = ctx.paths || {};
  if (CC_ROOT && existsSync(CC_ROOT)) for (const proj of safeDir(CC_ROOT)) for (const f of safeDir(join(CC_ROOT, proj))) if (f.endsWith(".jsonl")) consider(join(CC_ROOT, proj, f), "claude-code");
  if (CODEX_ROOT && ctx.cfg.codex !== false) for (const f of walkCodex(CODEX_ROOT)) consider(f, "codex");
  return out;
}
const safeDir = (d) => { try { return readdirSync(d); } catch { return []; } };
function* walkCodex(dir) {
  for (const e of safeDir(dir)) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walkCodex(p);
    else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) yield p;
  }
}

// ---------- 单条详情：本地投影出「脱敏后」正文（与库里一致）+ 原文 + 自检 ----------
async function sessionDetail(file) {
  if (!file) return { error: "missing file" };
  const e = getByFile(file);
  const tool = e?.tool || "claude-code";
  if (!existsSync(file)) return { error: "源文件已不在本机（可能已删除/移动）", id: e?.id, coord: e ? coordStr(e) : "" };
  let uploadStr;
  try {
    if (tool === "codex") uploadStr = await slimRawFile(file);
    else if (tool === "session-history-md") uploadStr = readFileSync(file, "utf8");   // session-history 上传不蒸馏
    else uploadStr = slimRaw(readFileSync(file, "utf8"));
  } catch (err) { return { error: "读取/蒸馏失败：" + err.message }; }
  const redacted = projectSession(uploadStr, tool);
  const { text: raw, truncated } = readCapped(file);
  return {
    id: e?.id || basename(file).replace(/\.(jsonl|md)$/, ""), tool: toolShort(tool),
    intent: e?.intent || "", coord: e ? coordStr(e) : "", status: e?.status || "uploaded",
    redacted, raw, truncated,
  };
}

// 读文件前 RAW_CAP 字节（大文件不整读）
function readCapped(file) {
  try {
    const size = statSync(file).size;
    if (size <= RAW_CAP) return { text: readFileSync(file, "utf8"), truncated: false };
    const fd = openSync(file, "r"); const buf = Buffer.alloc(RAW_CAP);
    const n = readSync(fd, buf, 0, RAW_CAP, 0); closeSync(fd);
    return { text: buf.subarray(0, n).toString("utf8") + "\n\n…（原文超 400KB，仅展示开头）", truncated: true };
  } catch (e) { return { text: "（读取失败：" + e.message + "）", truncated: false }; }
}

// ---------- M2：排除 / 撤回 ----------
// 排除一条：加进本机 optout（daemon 上传前据此跳过）；若已在库，再调服务端 /retract 删掉。
async function excludeSession(ctx, file) {
  if (!file) return { error: "missing file" };
  const e = getByFile(file);
  const id = e?.id || basename(file).replace(/\.(jsonl|md)$/, "");
  addOptout({ id, file, intent: e?.intent || null });
  let retract = null;
  if (e && e.status === "uploaded") {
    retract = await callRetract(ctx.cfg, id);
    recordSession({ file, status: retract?.ok ? "retracted" : "opted_out" });
  } else if (e) {
    recordSession({ file, status: "opted_out" });
  }
  saveLedger();
  return { ok: true, retract };
}
async function callRetract(cfg, id) {
  if (!cfg.server_url || !cfg.token) return { ok: false, error: "未配置服务器 / token" };
  try {
    const r = await fetch(cfg.server_url.replace(/\/$/, "") + "/retract", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify({ id }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, removed: (j.removed || []).length } : { ok: false, error: j.error || ("HTTP " + r.status) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- M2：个人脱敏词表（含本机命中计数）----------
function redactInfo() {
  const builtin = ["API Key (sk-…)", "GitHub PAT", "GitLab Token", "AWS", "Google", "Slack", "Stripe", "JWT", "私钥 (PEM)", "password/token 赋值", "URL 内账密", "家目录路径 → ~"];
  const terms = listTerms().map((t) => ({ ...t, count: 0, sessions: 0 }));
  if (terms.length) {
    let scanned = 0;
    for (const e of allSessions()) {
      if (e.status !== "uploaded" || e.tool === "codex" || scanned >= FLAG_SCAN_CAP || !existsSync(e.file)) continue;
      let text; try { text = e.tool === "session-history-md" ? readFileSync(e.file, "utf8") : slimRaw(readFileSync(e.file, "utf8")); } catch { continue; }
      scanned++;
      for (const t of terms) { const n = countMatches(text, t); if (n) { t.count += n; t.sessions++; } }
    }
  }
  return { builtin, terms };
}

// ---------- M2：配置预览差量 / 保存 ----------
function configDryrun(ctx, proposed) {
  const cur = gateOf(ctx.cfg);
  const prop = gateOf({ collect_all: !!proposed.collect_all, upload_folders: proposed.upload_folders || [], exclude: proposed.exclude || [] });
  let willAdd = 0, willStop = 0;
  for (const e of allSessions()) {
    if (!e.cwd) continue;
    const a = cur(e.cwd), b = prop(e.cwd);
    if (!a && b) willAdd++;
    else if (a && !b && e.status === "uploaded") willStop++;
  }
  return { willAdd, willStop, basis: "按本机账本里已知 cwd 的 session 估算" };
}
function saveConfig(ctx, body) {
  const cfg = ctx.cfg;
  for (const k of ["collect_all", "upload_folders", "exclude", "codex", "trae_memory", "session_history_md", "interval_sec", "debounce_sec"]) {
    if (k in body) cfg[k] = body[k];
  }
  try {
    writeFileSync(join(ctx.ROOT, "client.config.yaml"), stringify(cfg));
    return { ok: true, note: "已保存。开关类即时生效；采集范围(目录)改动在 brain service restart 后完整补扫历史。" };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- 日志 ----------
// 过滤「无事发生」的空转 tick：tick 行里所有计数都是 0 → 丢；非 tick 行（上传/跳过/错误/启动/回填等）保留。
function meaningfulLog(line) {
  if (!/\btick\b/.test(line)) return true;
  const nums = [...line.matchAll(/=(\d+)/g)].map((m) => Number(m[1]));
  return nums.length === 0 || nums.some((n) => n !== 0);
}
function tailLog(ROOT, n) {
  try {
    const lines = readFileSync(join(ROOT, "sync.log"), "utf8").trimEnd().split("\n");
    return lines.slice(-n);
  } catch { return []; }
}
function lastTick(ROOT) {
  const lines = tailLog(ROOT, 400);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(" tick")) return lines[i];
  return lines[lines.length - 1] || null;
}
