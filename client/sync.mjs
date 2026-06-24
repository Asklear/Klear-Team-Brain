#!/usr/bin/env node
// 客户端（块2+3）：按 upload_folders 闸门，把 session 和本地文档传到服务器。
// 用法: node client/sync.mjs           常驻，每 interval_sec 扫一次
//       node client/sync.mjs --once    扫一次就退出（联调用）
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import { parseSession, parseSessionText } from "../core/parse.mjs";
import { coordOf, expandHome, gitBranch, parseRemote } from "../core/coord.mjs";
import { slimRaw, slimRawFile } from "../core/slim.mjs";
import { log } from "../core/log.mjs";
import { CLIENT_VERSION, PIPELINE_VERSION } from "../core/version.mjs";

const MAX_UPLOAD = 80 * 1024 * 1024;   // 蒸馏后仍超此值 → 跳过+标 seen。放到 80MB：超活跃 session（数千次
                                       // 工具调用，截后仍叠到几十 MB，实测 125MB→58MB）也能过；gzip 后才十几 MB，服务端扛得住
const MAX_RAW = 400 * 1024 * 1024;     // 原文超此值连读都不读（防极端大文件冻住采集；并安全低于 V8 ~512MB 字符串上限，
                                       // 否则 readFileSync(utf8) 会每轮直接抛"string too long"）。用于一次整读的路径：CC ingest / session-history。
const MAX_RAW_CODEX = 4 * 1024 * 1024 * 1024;  // Codex 走流式逐行蒸馏(slimRawFile)，不整读 → 不受 V8 串上限约束；
                                       // 这只是个防失控大文件冻住采集的兜底（4GB），实测几百 MB 的 rollout 蒸馏后仅几 MB。

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = parse(readFileSync(join(ROOT, "client.config.yaml"), "utf8"));
cfg.upload_folders = (cfg.upload_folders || []).map(expandHome);
cfg.exclude = (cfg.exclude || []).map(expandHome);
// 没指定工作空间且开了 collect_all → 不按 folder 闸门，采集本机所有 session（安装时未填采集位置的默认）。
// 注意：只放开 session 闸门；session_history 本地 .md 仍只从 upload_folders 白名单扫描（见 AGENTS.md 不变量）。
const COLLECT_ALL = !!cfg.collect_all;
const CC_ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex", "sessions");
const TRAE_MEMORY_ROOT = join(homedir(), ".trae-cn", "memory", "projects");
const SESSION_HISTORY_DIR = "session_history";
const DEBOUNCE = (cfg.debounce_sec ?? 60) * 1000;
const CONC = Math.max(1, cfg.concurrency ?? 4);          // 上传并发：一个卡住的不再串行阻塞整轮
const STATE = join(ROOT, ".brain-state.json");           // 已上传记录持久化：重启不再重传历史
const AUTO_UPDATE = cfg.auto_update !== false;           // 自动更新：默认开；client.config.yaml 写 auto_update:false 可关
const UPDATE_CHECK_MS = 24 * 3600 * 1000;                // 每天最多自检一次（够用、不打扰；部署后最长一天全队收敛）
const IS_DEV = existsSync(join(ROOT, ".git"));           // 开发 checkout 不自动更新（applyUpdate 也会拦，这里先省一次往返）

const seenSession = new Map(); // file -> mtimeMs 已上传

// 已上传记录落盘 / 复原（A：重启后跳过历史，不再把 49 个 session 全重传）
let prevFoldersStr = "";                                  // 上次运行时的 upload_folders（检测范围变化用）
let prevPipeline = 0;                                     // 上次运行时的采集流水线代次（检测升级、触发一次性重收）
let lastUpdateCheck = 0;                                  // 上次自动更新自检时刻（ms）：每天最多查一次，落盘跨重启保留
const foldersStr = () => JSON.stringify((cfg.upload_folders || []).slice().sort());

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    for (const [k, v] of Object.entries(s.session || {})) seenSession.set(k, v);
    prevFoldersStr = s.folders || "";
    prevPipeline = Number(s.pipeline) || 0;              // 缺字段（升级前的老 state）→ 0，必触发回填
    lastUpdateCheck = Number(s.lastUpdateCheck) || 0;    // 缺字段（升级前的老 state）→ 0，首轮就自检一次
  } catch {}
}

// 流水线升级 → 一次性重收受影响的历史（与"范围变了清 seen"同一套路）。
// 历来场景都在 Codex：代次 2 = slim 之前整丢 token_count；代次 3 = redact 误抹数值型 token 计数（统计为 0）
//   + slim 改每北京日留末条 token_count（Codex token 按天精确）。都得用新 slim/redact 重新蒸馏才补得回。
// 只清【Codex】的 seen（本机原文还在 ~/.codex）→ 重传量最小；CC 历史的 token 在服务端 rebuild-cards 补，不必重传。
function reconcilePipeline() {
  if (prevPipeline >= PIPELINE_VERSION) return;
  let cleared = 0;
  for (const file of [...seenSession.keys()]) {
    if (file.startsWith(CODEX_ROOT)) { seenSession.delete(file); cleared++; }
  }
  if (cleared) log.info("[流水线升级] 采集代次提升 → 重收 Codex 历史（补 token 用量）", { from: prevPipeline, to: PIPELINE_VERSION, codex_resync: cleared });
  prevPipeline = PIPELINE_VERSION;
}

// 范围变了（upload_folders 增/改）→ 清掉 seen，让这轮把"现在范围内"的所有历史重扫补传。
// 否则之前被标 seen 的历史（含当时不在范围、被跳过的）永远不会补。范围改动很少，一次性重传可接受、服务端幂等。
function reconcileScope() {
  const cur = foldersStr();
  if (prevFoldersStr && prevFoldersStr !== cur) {
    seenSession.clear();
    log.info("[范围变化] upload_folders 改了 → 清已读、重扫补全范围内所有历史");
  }
  prevFoldersStr = cur;
}
function saveState() {
  try {
    writeFileSync(STATE, JSON.stringify({
      session: Object.fromEntries(seenSession),
      folders: foldersStr(),                             // 记下本次范围，下次启动比对
      pipeline: PIPELINE_VERSION,                        // 记下本次流水线代次，下次启动比对（升级则一次性重收）
      lastUpdateCheck,                                   // 记下上次自动更新自检时刻，重启不重置每天的节流
    }));
  } catch (e) { log.warn("state 落盘失败", { err: e.message }); }
}

// 有限并发池（B）：n 路并发跑 worker，卡住的只占自己一路，不阻塞其余
async function pool(items, n, worker) {
  const it = items[Symbol.iterator]();
  const run = async () => { for (let x = it.next(); !x.done; x = it.next()) await worker(x.value); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

const within = (p, f) => p === f || p.startsWith(f.endsWith("/") ? f : f + "/");
const excluded = (p) => (cfg.exclude || []).some((e) => within(p, e)); // 在某个 exclude 子树下
const gated = (cwd) =>
  !!cwd && !excluded(cwd) && (COLLECT_ALL || (cfg.upload_folders || []).some((f) => within(cwd, f)));
const traeSlug = (p) => expandHome(p).replace(/[^A-Za-z0-9]/g, "-");
const traeMemoryProjectsConfig = () => cfg.trae_memory_projects || cfg.trae_memory_folders || [];

async function post(path, payload, tries = 3) {
  const json = JSON.stringify(payload);
  const body = gzipSync(Buffer.from(json));                       // gzip：跨境省 ~10x 流量
  // 单次超时随原文体积自适应：多 MB 的大 session 服务端 ingest（解析/脱敏/切卡/commit）天然慢，
  // 写死 60s 会把它们永久 abort；按 基线60s + 每MB 30s 放宽，封顶 280s（留在 Node 默认 requestTimeout 300s 内）。
  const mb = Buffer.byteLength(json) / 1048576;
  const TIMEOUT = Math.min(280000, Math.max(60000, 60000 + mb * 30000));
  for (let i = 1; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);          // 单次超时：stall 不再死等
    try {
      const r = await fetch(cfg.server_url + path, {
        method: "POST",
        headers: {
          "content-type": "application/json", "content-encoding": "gzip",
          authorization: `Bearer ${cfg.token}`, connection: "close",
          "x-client-version": CLIENT_VERSION,            // 让服务端日志记下本机客户端版本
        },
        body, signal: ac.signal,
      });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      if (i >= tries) throw e;                                    // 超时/reset → 重试
      await new Promise((res) => setTimeout(res, 300 * i));
    } finally { clearTimeout(timer); }
  }
}

function* sessionFiles() {
  if (!existsSync(CC_ROOT)) return;
  for (const proj of readdirSync(CC_ROOT)) {
    const pd = join(CC_ROOT, proj);
    let st; try { st = statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(pd)) if (f.endsWith(".jsonl")) yield join(pd, f);
  }
}

async function syncSessions() {
  let up = 0, skip = 0;
  const jobs = [];                                    // 先串行做完便宜的筛选（stat/parse/闸门），只把上传交给并发池
  for (const file of sessionFiles()) {
    let st; try { st = statSync(file); } catch { continue; }
    const m = st.mtimeMs;
    if (Date.now() - m < DEBOUNCE) continue;        // 还在活跃，等稳定
    if (seenSession.get(file) === m) continue;        // 没变
    if (st.size > MAX_RAW) { log.warn("ingest 跳过：原文超读前上限", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; continue; }
    const s = parseSession(file);
    if (!s.intent || !gated(s.cwd)) { skip++; seenSession.set(file, m); continue; }
    jobs.push({ file, m, s });
  }
  await pool(jobs, CONC, async ({ file, m, s }) => {
    const id = basename(file).replace(/\.jsonl$/, "");
    try {
      const c = coordOf(s.cwd, cfg.upload_folders);   // 只算 remote + folder；github-vs-local 由服务器定
      const raw = slimRaw(readFileSync(file, "utf8"));  // 上传前瘦身：剥图片/截巨型输出，完整原文留本机
      if (raw.length > MAX_UPLOAD) { log.warn("ingest 跳过：瘦身后仍超上限", { id, mb: +(raw.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; return; }
      const r = await post("/ingest", {
        id, tool: "claude-code", raw,
        remote: c.remote, folder: c.folder, branch: s.branch,
        producer: cfg.me,
      });
      if (r.status === 200) { up++; seenSession.set(file, m); } else log.warn("ingest 上传失败", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("ingest 出错", { id, err: e.message }); } // 读/瘦身/上传任一出错只困住这条，不拖垮整轮；失败不 mark seen → 下一轮重试
  });
  return { up, skip };
}

// Codex rollout 散在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，递归找。
function* codexFiles(dir = CODEX_ROOT) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* codexFiles(p);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) yield p;
  }
}

async function syncCodexSessions() {
  if (cfg.codex === false) return { up: 0, skip: 0 };   // 默认开；显式 false 才关
  let up = 0, skip = 0;
  const jobs = [];
  for (const file of codexFiles()) {
    let st; try { st = statSync(file); } catch { continue; }
    const m = st.mtimeMs;
    if (Date.now() - m < DEBOUNCE) continue;            // 还在活跃，等稳定
    if (seenSession.get(file) === m) continue;            // 没变
    if (st.size > MAX_RAW_CODEX) { log.warn("codex 跳过：原文超采集上限", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; continue; }
    jobs.push({ file, m });                              // 读/蒸馏/判闸门都挪进 worker：流式逐行，不再整文件读成大字符串
  }
  await pool(jobs, CONC, async ({ file, m }) => {
    const id = basename(file).replace(/\.jsonl$/, "");   // rollout-<ts>-<uuid>，唯一
    try {
      const slim = await slimRawFile(file);              // 流式蒸馏：逐行读 → 剥图片/截巨型输出，完整原文留本机；几百 MB 也不撞 V8 串上限
      const s = parseSessionText(slim, "codex");          // 用蒸馏后文本判闸门/取坐标（messages + session_meta.git 都保留）
      // 没人类开场 / 不在闸门内 / guardian-子代理噪声 → 跳过
      if (!s.intent || s.subagent || !gated(s.cwd)) { skip++; seenSession.set(file, m); return; }
      const c = coordOf(s.cwd, cfg.upload_folders);   // 只算 remote + folder；github-vs-local 由服务器定
      // remote/branch 优先用原文 session_meta.git 记的（session 时刻、可靠）；
      // 没记（旧 rollout）才回退到现场 git：remote 按 cwd 现取 origin、branch 按 cwd 现取当前分支。
      const remote = c.remote || parseRemote(s.repoUrl);
      const branch = s.branch || gitBranch(s.cwd);
      if (slim.length > MAX_UPLOAD) { log.warn("codex 跳过：瘦身后仍超上限", { id, mb: +(slim.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; return; }
      const r = await post("/ingest", {
        id, tool: "codex", raw: slim,
        remote, folder: c.folder, branch,
        producer: cfg.me,
      });
      if (r.status === 200) { up++; seenSession.set(file, m); } else log.warn("codex 上传失败", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("codex 出错", { id, err: e.message }); } // 单文件出错只困住这条，不拖垮整轮
  });
  return { up, skip };
}

function sessionHistoryProjectDir(file) {
  const parts = file.split("/");
  const idx = parts.lastIndexOf(SESSION_HISTORY_DIR);
  if (idx <= 0) return dirname(file);
  return parts.slice(0, idx).join("/") || "/";
}

function* sessionHistoryMdFiles(dir, inside = false) {
  if (!dir || excluded(dir)) return;
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (excluded(p)) continue;
    if (e.isDirectory()) {
      yield* sessionHistoryMdFiles(p, inside || e.name === SESSION_HISTORY_DIR);
    } else if (inside && e.name.endsWith(".md")) {
      yield p;
    }
  }
}

function* sessionHistoryFiles() {
  for (const root of cfg.upload_folders || []) {
    if (gated(root)) yield* sessionHistoryMdFiles(root);
  }
}

function sessionHistoryId(file) {
  const name = basename(file, ".md").replace(/[/\\\0]+/g, "-").slice(0, 80) || "session";
  const hash = createHash("sha1").update(file).digest("hex").slice(0, 12);
  return `session-history-${hash}-${name}`;
}

function sessionHistoryRaw({ file, cwd, branch, content, mtimeMs }) {
  const updated = new Date(mtimeMs).toISOString();
  return [
    JSON.stringify({
      type: "session_history_meta",
      timestamp: updated,
      updated,
      cwd,
      branch,
      source_file: file,
      filename: basename(file),
    }),
    JSON.stringify({
      type: "session_history_markdown",
      timestamp: updated,
      content,
    }),
  ].join("\n") + "\n";
}

async function syncSessionHistoryMd() {
  if (cfg.session_history_md === false) return { up: 0, skip: 0 }; // 默认开；显式 false 才关
  let up = 0, skip = 0;
  const jobs = [];
  for (const file of sessionHistoryFiles()) {
    let st; try { st = statSync(file); } catch { continue; }
    const m = st.mtimeMs;
    if (Date.now() - m < DEBOUNCE) continue;
    if (seenSession.get(file) === m) continue;
    if (st.size > MAX_RAW) { log.warn("session-history 跳过：原文超读前上限", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; continue; }
    const cwd = sessionHistoryProjectDir(file);
    if (!gated(cwd) || !gated(file)) { skip++; seenSession.set(file, m); continue; }
    let content; try { content = readFileSync(file, "utf8"); } catch (e) { log.warn("session-history 读取失败", { file: basename(file), err: e.message }); continue; }
    if (!content.trim()) { skip++; seenSession.set(file, m); continue; }
    jobs.push({ file, m, cwd, content });
  }
  await pool(jobs, CONC, async ({ file, m, cwd, content }) => {
    const id = sessionHistoryId(file);
    try {
      const c = coordOf(cwd, cfg.upload_folders);
      const branch = gitBranch(cwd);
      const raw = sessionHistoryRaw({ file, cwd, branch, content, mtimeMs: m });
      if (raw.length > MAX_UPLOAD) { log.warn("session-history 跳过：上传体超上限", { id, mb: +(raw.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; return; }
      const r = await post("/ingest", {
        id, tool: "session-history-md", raw,
        remote: c.remote, folder: c.folder, branch,
        producer: cfg.me,
      });
      if (r.status === 200) { up++; seenSession.set(file, m); } else log.warn("session-history 上传失败", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("session-history 出错", { id, err: e.message }); }
  });
  return { up, skip };
}

function* traeMemoryFiles(dir) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* traeMemoryFiles(p);
    else if (e.name.startsWith("session_memory_") && e.name.endsWith(".jsonl")) yield p;
  }
}

function allowedTraeProjects() {
  const out = new Map();
  const add = (cwd) => {
    if (!cwd || excluded(cwd)) return;
    const slug = traeSlug(cwd);
    if (!out.has(slug)) out.set(slug, { slug, cwd });
  };
  for (const root of cfg.upload_folders || []) add(root);
  return [...out.values()];
}

function explicitTraeProjects(allowed) {
  const bySlug = new Map(allowed.map((p) => [p.slug, p]));
  const out = new Map();
  for (const x of traeMemoryProjectsConfig()) {
    const s = expandHome(x);
    let p = null;
    if (s.includes("/")) {
      if ((cfg.upload_folders || []).some((f) => within(s, f)) && !excluded(s)) p = { slug: traeSlug(s), cwd: s };
    } else {
      p = bySlug.get(s) || null; // 直接填 slug 时，必须能反查到某个 upload_folders 派生的允许工作区。
    }
    if (p && !out.has(p.slug)) out.set(p.slug, p);
  }
  return [...out.values()];
}

function traeMemoryProjects() {
  if (!existsSync(TRAE_MEMORY_ROOT)) return [];
  const allowed = allowedTraeProjects();
  const explicit = traeMemoryProjectsConfig();
  const projects = explicit.length ? explicitTraeProjects(allowed) : allowed;
  return projects.filter((p) => existsSync(join(TRAE_MEMORY_ROOT, p.slug)));
}

function traeMemoryId(file) {
  const rel = file.startsWith(TRAE_MEMORY_ROOT) ? file.slice(TRAE_MEMORY_ROOT.length + 1) : file;
  const name = basename(file, ".jsonl").replace(/[/\\\0]+/g, "-").slice(0, 80) || "session-memory";
  const hash = createHash("sha1").update(rel).digest("hex").slice(0, 12);
  return `trae-memory-${hash}-${name}`;
}

async function syncTraeSessionMemory() {
  if (cfg.trae_memory === false) return { up: 0, skip: 0 }; // 默认开；设 false 关闭
  let up = 0, skip = 0;
  const jobs = [];
  for (const project of traeMemoryProjects()) {
    const projectDir = join(TRAE_MEMORY_ROOT, project.slug);
    const cwd = project.cwd;
    if (cwd && !gated(cwd)) continue;
    for (const file of traeMemoryFiles(projectDir)) {
      let st; try { st = statSync(file); } catch { continue; }
      const m = st.mtimeMs;
      if (Date.now() - m < DEBOUNCE) continue;
      if (seenSession.get(file) === m) continue;
      if (st.size > MAX_RAW) { log.warn("trae-memory 跳过：原文超读前上限", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; continue; }
      let raw; try { raw = readFileSync(file, "utf8"); } catch (e) { log.warn("trae-memory 读取失败", { file: basename(file), err: e.message }); continue; }
      const s = parseSessionText(raw, "trae-session-memory");
      if (!s.intent) { skip++; seenSession.set(file, m); continue; }
      jobs.push({ file, m, project, raw });
    }
  }
  await pool(jobs, CONC, async ({ file, m, project, raw }) => {
    const id = traeMemoryId(file);
    try {
      const cwd = project.cwd;
      const c = cwd ? coordOf(cwd, cfg.upload_folders) : { remote: null, folder: `trae/${project.slug}` };
      const branch = cwd ? gitBranch(cwd) : "no-branch";
      const slimmed = slimRaw(raw); // 复用客户端上传前脱敏/瘦身，避免 Trae memory raw 把密钥带上服务端。
      if (slimmed.length > MAX_UPLOAD) { log.warn("trae-memory 跳过：上传体超上限", { id, mb: +(slimmed.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; return; }
      const r = await post("/ingest", {
        id, tool: "trae-session-memory", raw: slimmed,
        remote: c.remote, folder: c.folder || `trae/${project.slug}`, branch,
        producer: cfg.me,
      });
      if (r.status === 200) { up++; seenSession.set(file, m); } else log.warn("trae-memory 上传失败", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("trae-memory 出错", { id, err: e.message }); }
  });
  return { up, skip };
}

async function tick() {
  const s = await syncSessions();
  const x = await syncCodexSessions();
  const h = await syncSessionHistoryMd();
  const t = await syncTraeSessionMemory();
  saveState();                                          // 落盘已上传记录（重启复原）
  log.info("tick", { cc_up: s.up, cc_skip: s.skip, codex_up: x.up, codex_skip: x.skip, session_history_up: h.up, session_history_skip: h.skip, trae_memory_up: t.up, trae_memory_skip: t.skip });
}

// 防重叠：一轮没跑完（卡在慢上传）时下一次定时不叠进来重复传
let ticking = false;
async function safeTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { log.error("tick 异常", { err: e.message }); } finally { ticking = false; }
  try { await maybeAutoUpdate(); } catch (e) { log.warn("自动更新自检异常", { err: e.message }); }
}

// 版本比较：a>b 正、相等 0、a<b 负（形如 "0.1.15"，非数字段按 0）
function cmpVer(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

// 自动更新（默认开、每天最多自检一次）：问服务器 /version，比本机高就把新代码落盘，然后本进程退出，
// 由常驻管理器（launchd KeepAlive / systemd Restart=always）以新代码重新拉起 —— 全程不在子进程里做重启，避开自更新竞态。
// 只对装了常驻的安装有意义；开发 checkout（IS_DEV）和 --once 回填不参与。
async function maybeAutoUpdate() {
  if (!AUTO_UPDATE || IS_DEV || once) return;
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
  lastUpdateCheck = Date.now(); saveState();             // 先记时间：成败都等明天再试，不打爆 /version、/client.tgz
  let latest;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const r = await fetch(cfg.server_url.replace(/\/$/, "") + "/version", { signal: ac.signal }).finally(() => clearTimeout(timer));
    if (!r.ok) return;
    latest = (await r.json()).version;
  } catch { return; }
  if (!latest || latest === "unknown" || cmpVer(latest, CLIENT_VERSION) <= 0) return;
  log.info("[自动更新] 发现新客户端版本 → 落盘并以新代码重启", { from: CLIENT_VERSION, to: latest });
  await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 300000))); // 抖动 0–5min：错开全队部署后一窝蜂拉 /client.tgz
  // 同步等更新落盘（--no-restart：只覆盖代码，不在子进程里重启）；成功则本进程退出，由常驻管理器以新代码拉起
  const code = await new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, "cli", "brain.mjs"), "update", "--no-restart"], { cwd: ROOT, stdio: "inherit" });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} res(-1); }, 600000); // 10min 封顶：卡死就放弃，明天再试
    child.on("exit", (x) => { clearTimeout(t); res(x ?? -1); });
    child.on("error", () => { clearTimeout(t); res(-1); });
  });
  if (code === 0) {
    log.info("[自动更新] 新代码已就位 → 退出，等常驻以新代码重启");
    process.exit(0);                                     // 退出处理器释放单例锁；KeepAlive/Restart=always 立刻以新代码拉起
  }
  log.warn("[自动更新] 更新失败，明天再试", { code });
}

// 单例锁（仅常驻模式）：挡住同一 checkout 的第二个常驻 sync，避免两个进程重复上传。
// --once 一次性回填不锁（join 首次回填要能跟已有常驻并存）。
const LOCK = join(tmpdir(), `team-brain-sync-${createHash("sha1").update(ROOT).digest("hex").slice(0, 12)}.lock`);
function acquireLock() {
  try {
    const fd = openSync(LOCK, "wx");                      // 原子创建；已存在即 EEXIST
    writeSync(fd, String(process.pid)); closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const old = Number(readFileSync(LOCK, "utf8")) || 0;
    let alive = false; try { process.kill(old, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } // EPERM=进程在没权限→仍算活；ESRCH=真没了
    if (alive) { log.warn("已有常驻 sync 在跑，本进程退出避免重复上传", { pid: old }); process.exit(0); }
    writeFileSync(LOCK, String(process.pid));             // 陈旧锁（旧进程已死）→ 接管
  }
  const release = () => { try { if (Number(readFileSync(LOCK, "utf8")) === process.pid) unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0)); // 停服务时也释放锁
}

const once = process.argv.includes("--once");
if (!once) acquireLock();                               // 持久模式先抢锁，第二个常驻会在此退出
loadState();                                            // 先复原已上传记录，首轮就跳过历史
reconcileScope();                                       // 范围变了就清 seen、补全新范围历史
reconcilePipeline();                                    // 流水线升级了就重收受影响历史（当前：Codex token 用量）
log.info("sync 启动", { server: cfg.server_url, folders: (cfg.upload_folders || []).length, collect_all: COLLECT_ALL, conc: CONC, seen: seenSession.size, ver: CLIENT_VERSION, once });
await safeTick();
if (!once) setInterval(safeTick, (cfg.interval_sec ?? 60) * 1000);
