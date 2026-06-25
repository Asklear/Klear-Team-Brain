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
import { loadLedger, saveLedger, recordSession, getByFile, allSessions } from "../core/ledger.mjs";
import { loadOptout, isOptedOut } from "../core/optout.mjs";
import { loadUserRedact, applyUserRedact } from "../core/userredact.mjs";
import { startViewer } from "./viewer.mjs";
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
const LEDGER = join(ROOT, ".brain-ledger.json");         // 结果账本：viewer 的数据源（传了啥/没传啥/为什么/在库哪）
const OPTOUT = join(ROOT, ".brain-optout.json");         // 逐条排除名单：命中即永不上传
const USERREDACT = join(ROOT, ".brain-redact.json");     // 个人脱敏词表：上传前额外抹除
const BACKFILL_PARSE_CAP = 12 * 1024 * 1024;             // 历史回填：超此大小不细解，按大小/位置粗判，避免回填卡顿
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
  if (cleared) log.info("[pipeline-upgrade] generation bumped -> re-collect Codex history (recover token usage)", { from: prevPipeline, to: PIPELINE_VERSION, codex_resync: cleared });
  prevPipeline = PIPELINE_VERSION;
}

// 范围变了（upload_folders 增/改）→ 清掉 seen，让这轮把"现在范围内"的所有历史重扫补传。
// 否则之前被标 seen 的历史（含当时不在范围、被跳过的）永远不会补。范围改动很少，一次性重传可接受、服务端幂等。
function reconcileScope() {
  const cur = foldersStr();
  if (prevFoldersStr && prevFoldersStr !== cur) {
    seenSession.clear();
    log.info("[scope-changed] upload_folders changed -> clear seen, rescan all in-scope history");
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
  } catch (e) { log.warn("state save failed", { err: e.message }); }
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

// 账本字段：从解析结果 s + 坐标 c 摘出 viewer 要显示的便宜元信息（坐标/意图/工作时间/turns）。
const coordFields = (s, c, branch) => ({
  intent: s.intent, cwd: s.cwd, remote: c?.remote || null, folder: c?.folder || null,
  branch: branch ?? s.branch, work_start: s.ts, work_end: s.updated, turns: s.turns,
});
// 从 /ingest 200 响应体取服务端定下的规范坐标（space_key/file），记进账本好让 viewer 显示「在库哪」。
const serverCoord = (r) => { try { return JSON.parse(r.body) || {}; } catch { return {}; } };

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
    const idEarly = basename(file).replace(/\.jsonl$/, "");
    if (isOptedOut(idEarly, file)) { seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idEarly, tool: "claude-code", status: "opted_out" }); continue; }
    if (st.size > MAX_RAW) { log.warn("cc skip: raw exceeds pre-read cap", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idEarly, tool: "claude-code", status: "skipped", reason: "toobig", bytes_raw: st.size }); continue; }
    const s = parseSession(file);
    if (!s.intent) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id: idEarly, tool: "claude-code", status: "skipped", reason: "nointent", cwd: s.cwd }); continue; }
    if (!gated(s.cwd)) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id: idEarly, tool: "claude-code", status: "skipped", reason: "gated", intent: s.intent, cwd: s.cwd }); continue; }
    jobs.push({ file, m, s, size: st.size });
  }
  await pool(jobs, CONC, async ({ file, m, s, size }) => {
    const id = basename(file).replace(/\.jsonl$/, "");
    try {
      const c = coordOf(s.cwd, cfg.upload_folders);   // 只算 remote + folder；github-vs-local 由服务器定
      const raw = applyUserRedact(slimRaw(readFileSync(file, "utf8")));  // 上传前瘦身 + 个人脱敏词表；完整原文留本机
      if (raw.length > MAX_UPLOAD) { log.warn("cc skip: still over cap after slim", { id, mb: +(raw.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id, tool: "claude-code", status: "skipped", reason: "toobig", ...coordFields(s, c), bytes_raw: size, bytes_slim: raw.length }); return; }
      const r = await post("/ingest", {
        id, tool: "claude-code", raw,
        remote: c.remote, folder: c.folder, branch: s.branch,
        producer: cfg.me,
      });
      if (r.status === 200) {
        up++; seenSession.set(file, m);
        const sk = serverCoord(r);
        recordSession({ file, mtime: m, id, tool: "claude-code", status: "uploaded", ...coordFields(s, c), space_key: sk.space_key, server_file: sk.file, bytes_raw: size, bytes_slim: raw.length });
      } else log.warn("cc upload failed", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("cc error", { id, err: e.message }); } // 读/瘦身/上传任一出错只困住这条，不拖垮整轮；失败不 mark seen → 下一轮重试
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
    const idC = basename(file).replace(/\.jsonl$/, "");
    if (isOptedOut(idC, file)) { seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idC, tool: "codex", status: "opted_out" }); continue; }
    if (st.size > MAX_RAW_CODEX) { log.warn("codex skip: raw over collect cap", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idC, tool: "codex", status: "skipped", reason: "toobig", bytes_raw: st.size }); continue; }
    jobs.push({ file, m, size: st.size });               // 读/蒸馏/判闸门都挪进 worker：流式逐行，不再整文件读成大字符串
  }
  await pool(jobs, CONC, async ({ file, m, size }) => {
    const id = basename(file).replace(/\.jsonl$/, "");   // rollout-<ts>-<uuid>，唯一
    try {
      const slim = await slimRawFile(file);              // 流式蒸馏：逐行读 → 剥图片/截巨型输出，完整原文留本机；几百 MB 也不撞 V8 串上限
      const s = parseSessionText(slim, "codex");          // 用蒸馏后文本判闸门/取坐标（messages + session_meta.git 都保留）
      // 没人类开场 / guardian-子代理噪声 / 不在闸门内 → 跳过（分别记原因）
      if (!s.intent) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id, tool: "codex", status: "skipped", reason: "nointent", cwd: s.cwd }); return; }
      if (s.subagent) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id, tool: "codex", status: "skipped", reason: "subagent", intent: s.intent, cwd: s.cwd }); return; }
      if (!gated(s.cwd)) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id, tool: "codex", status: "skipped", reason: "gated", intent: s.intent, cwd: s.cwd }); return; }
      const c = coordOf(s.cwd, cfg.upload_folders);   // 只算 remote + folder；github-vs-local 由服务器定
      // remote/branch 优先用原文 session_meta.git 记的（session 时刻、可靠）；
      // 没记（旧 rollout）才回退到现场 git：remote 按 cwd 现取 origin、branch 按 cwd 现取当前分支。
      const remote = c.remote || parseRemote(s.repoUrl);
      const branch = s.branch || gitBranch(s.cwd);
      if (slim.length > MAX_UPLOAD) { log.warn("codex skip: still over cap after slim", { id, mb: +(slim.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id, tool: "codex", status: "skipped", reason: "toobig", ...coordFields(s, { remote, folder: c.folder }, branch), bytes_raw: size, bytes_slim: slim.length }); return; }
      const r = await post("/ingest", {
        id, tool: "codex", raw: applyUserRedact(slim),
        remote, folder: c.folder, branch,
        producer: cfg.me,
      });
      if (r.status === 200) {
        up++; seenSession.set(file, m);
        const sk = serverCoord(r);
        recordSession({ file, mtime: m, id, tool: "codex", status: "uploaded", ...coordFields(s, { remote, folder: c.folder }, branch), space_key: sk.space_key, server_file: sk.file, bytes_raw: size, bytes_slim: slim.length });
      } else log.warn("codex upload failed", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("codex error", { id, err: e.message }); } // 单文件出错只困住这条，不拖垮整轮
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
    const idH = sessionHistoryId(file);
    if (isOptedOut(idH, file)) { seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idH, tool: "session-history-md", status: "opted_out" }); continue; }
    if (st.size > MAX_RAW) { log.warn("session-history skip: raw exceeds pre-read cap", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idH, tool: "session-history-md", status: "skipped", reason: "toobig", bytes_raw: st.size }); continue; }
    const cwd = sessionHistoryProjectDir(file);
    if (!gated(cwd) || !gated(file)) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id: sessionHistoryId(file), tool: "session-history-md", status: "skipped", reason: "gated", cwd }); continue; }
    let content; try { content = readFileSync(file, "utf8"); } catch (e) { log.warn("session-history read failed", { file: basename(file), err: e.message }); continue; }
    if (!content.trim()) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id: sessionHistoryId(file), tool: "session-history-md", status: "skipped", reason: "empty", cwd }); continue; }
    jobs.push({ file, m, cwd, content });
  }
  await pool(jobs, CONC, async ({ file, m, cwd, content }) => {
    const id = sessionHistoryId(file);
    try {
      const c = coordOf(cwd, cfg.upload_folders);
      const branch = gitBranch(cwd);
      const s = parseSessionText(content, "session-history-md"); // 取 intent/时间给账本（md 解析很便宜）
      const raw = sessionHistoryRaw({ file, cwd, branch, content, mtimeMs: m });
      if (raw.length > MAX_UPLOAD) { log.warn("session-history skip: payload over cap", { id, mb: +(raw.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id, tool: "session-history-md", status: "skipped", reason: "toobig", ...coordFields({ ...s, cwd }, c, branch), bytes_slim: raw.length }); return; }
      const r = await post("/ingest", {
        id, tool: "session-history-md", raw: applyUserRedact(raw),
        remote: c.remote, folder: c.folder, branch,
        producer: cfg.me,
      });
      if (r.status === 200) {
        up++; seenSession.set(file, m);
        const sk = serverCoord(r);
        recordSession({ file, mtime: m, id, tool: "session-history-md", status: "uploaded", ...coordFields({ ...s, cwd }, c, branch), space_key: sk.space_key, server_file: sk.file, bytes_slim: raw.length });
      } else log.warn("session-history upload failed", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("session-history error", { id, err: e.message }); }
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
      const idT = traeMemoryId(file);
      if (isOptedOut(idT, file)) { seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idT, tool: "trae-session-memory", status: "opted_out" }); continue; }
      if (st.size > MAX_RAW) { log.warn("trae-memory skip: raw exceeds pre-read cap", { file: basename(file), mb: +(st.size / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id: idT, tool: "trae-session-memory", status: "skipped", reason: "toobig", bytes_raw: st.size }); continue; }
      let raw; try { raw = readFileSync(file, "utf8"); } catch (e) { log.warn("trae-memory read failed", { file: basename(file), err: e.message }); continue; }
      const s = parseSessionText(raw, "trae-session-memory");
      if (!s.intent) { skip++; seenSession.set(file, m); recordSession({ file, mtime: m, id: traeMemoryId(file), tool: "trae-session-memory", status: "skipped", reason: "nointent" }); continue; }
      jobs.push({ file, m, project, raw, s });
    }
  }
  await pool(jobs, CONC, async ({ file, m, project, raw, s }) => {
    const id = traeMemoryId(file);
    try {
      const cwd = project.cwd;
      const c = cwd ? coordOf(cwd, cfg.upload_folders) : { remote: null, folder: `trae/${project.slug}` };
      const branch = cwd ? gitBranch(cwd) : "no-branch";
      const folder = c.folder || `trae/${project.slug}`;
      const slimmed = slimRaw(raw); // 复用客户端上传前脱敏/瘦身，避免 Trae memory raw 把密钥带上服务端。
      if (slimmed.length > MAX_UPLOAD) { log.warn("trae-memory skip: payload over cap", { id, mb: +(slimmed.length / 1048576).toFixed(0) }); seenSession.set(file, m); skip++; recordSession({ file, mtime: m, id, tool: "trae-session-memory", status: "skipped", reason: "toobig", ...coordFields({ ...s, cwd }, { remote: c.remote, folder }, branch), bytes_raw: raw.length, bytes_slim: slimmed.length }); return; }
      const r = await post("/ingest", {
        id, tool: "trae-session-memory", raw: applyUserRedact(slimmed),
        remote: c.remote, folder, branch,
        producer: cfg.me,
      });
      if (r.status === 200) {
        up++; seenSession.set(file, m);
        const sk = serverCoord(r);
        recordSession({ file, mtime: m, id, tool: "trae-session-memory", status: "uploaded", ...coordFields({ ...s, cwd }, { remote: c.remote, folder }, branch), space_key: sk.space_key, server_file: sk.file, bytes_raw: raw.length, bytes_slim: slimmed.length });
      } else log.warn("trae-memory upload failed", { id, status: r.status, body: (r.body || "").slice(0, 200) });
    } catch (e) { log.error("trae-memory error", { id, err: e.message }); }
  });
  return { up, skip };
}

// 历史回填：把【上线本功能前就已 seen】但账本没有的源文件，补一条派生记录，让 viewer 也能显示历史。
// 状态按 daemon 真实判定法则重放（seen + 闸门内 + 有 intent + 不超限 → uploaded；否则 skipped+原因），故准确。
// 大文件不细解，按大小/位置粗判，避免回填卡顿。一次性：补过的进账本，下次启动 getByFile 命中自然跳过。
async function backfillLedger() {
  let done = 0;
  for (const [file, m] of seenSession) {
    if (getByFile(file)) continue;                    // 账本已有 → 跳过
    let st; try { st = statSync(file); } catch { continue; }   // 源文件没了 → 无从判定
    const tool = file.startsWith(CODEX_ROOT) ? "codex"
      : file.startsWith(TRAE_MEMORY_ROOT) ? "trae-session-memory"
      : file.endsWith(".md") ? "session-history-md" : "claude-code";
    const id = tool === "session-history-md" ? sessionHistoryId(file)
      : tool === "trae-session-memory" ? traeMemoryId(file)
      : basename(file).replace(/\.jsonl$/, "");
    const maxRaw = tool === "codex" ? MAX_RAW_CODEX : MAX_RAW;
    if (st.size > maxRaw) { recordSession({ file, mtime: m, id, tool, status: "skipped", reason: "toobig", bytes_raw: st.size, backfilled: true }); done++; continue; }
    if (st.size > BACKFILL_PARSE_CAP) { recordSession({ file, mtime: m, id, tool, status: "uploaded", bytes_raw: st.size, backfilled: true }); done++; continue; } // 大文件不细解，假定已传
    try {
      let s;
      if (tool === "codex") s = parseSessionText(await slimRawFile(file), "codex");
      else if (tool === "claude-code") s = parseSession(file);
      else s = parseSessionText(readFileSync(file, "utf8"), tool);
      const cwd = s.cwd || (tool === "session-history-md" ? sessionHistoryProjectDir(file) : null);
      const c = coordOf(cwd, cfg.upload_folders);
      const branch = s.branch || gitBranch(cwd);
      let status = "uploaded", reason;                 // 重放判定法则（与各 sync 函数一致）
      if (!s.intent) { status = "skipped"; reason = "nointent"; }
      else if (s.subagent) { status = "skipped"; reason = "subagent"; }
      else if (!gated(cwd)) { status = "skipped"; reason = "gated"; }
      recordSession({ file, mtime: m, id, tool, status, reason, ...coordFields({ ...s, cwd }, c, branch), bytes_raw: st.size, backfilled: true });
      done++;
    } catch { recordSession({ file, mtime: m, id, tool, status: "uploaded", bytes_raw: st.size, backfilled: true }); done++; }
  }
  if (done) { saveLedger(); log.info("[backfill] ledger backfilled", { added: done }); }
}

async function tick() {
  const s = await syncSessions();
  const x = await syncCodexSessions();
  const h = await syncSessionHistoryMd();
  const t = await syncTraeSessionMemory();
  saveState();                                          // 落盘已上传记录（重启复原）
  saveLedger();                                         // 落盘结果账本（viewer 数据源）
  log.info("tick", { cc_up: s.up, cc_skip: s.skip, codex_up: x.up, codex_skip: x.skip, session_history_up: h.up, session_history_skip: h.skip, trae_memory_up: t.up, trae_memory_skip: t.skip });
}

// 防重叠：一轮没跑完（卡在慢上传）时下一次定时不叠进来重复传
let ticking = false;
async function safeTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { log.error("tick error", { err: e.message }); } finally { ticking = false; }
  try { await maybeAutoUpdate(); } catch (e) { log.warn("auto-update check error", { err: e.message }); }
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
  log.info("[auto-update] newer client found -> stage + restart with new code", { from: CLIENT_VERSION, to: latest });
  await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 300000))); // 抖动 0–5min：错开全队部署后一窝蜂拉 /client.tgz
  // 同步等更新落盘（--no-restart：只覆盖代码，不在子进程里重启）；成功则本进程退出，由常驻管理器以新代码拉起
  const code = await new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, "cli", "brain.mjs"), "update", "--no-restart"], { cwd: ROOT, stdio: "inherit" });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} res(-1); }, 600000); // 10min 封顶：卡死就放弃，明天再试
    child.on("exit", (x) => { clearTimeout(t); res(x ?? -1); });
    child.on("error", () => { clearTimeout(t); res(-1); });
  });
  if (code === 0) {
    log.info("[auto-update] new code staged -> exiting, resident restarts with it");
    process.exit(0);                                     // 退出处理器释放单例锁；KeepAlive/Restart=always 立刻以新代码拉起
  }
  log.warn("[auto-update] update failed, retry tomorrow", { code });
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
    if (alive) { log.warn("another resident sync running, exiting to avoid double upload", { pid: old }); process.exit(0); }
    writeFileSync(LOCK, String(process.pid));             // 陈旧锁（旧进程已死）→ 接管
  }
  const release = () => { try { if (Number(readFileSync(LOCK, "utf8")) === process.pid) unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0)); // 停服务时也释放锁
}

const once = process.argv.includes("--once");
if (!once) acquireLock();                               // 持久模式先抢锁，第二个常驻会在此退出
loadState();                                            // 先复原已上传记录，首轮就跳过历史
loadLedger(LEDGER);                                     // 复原结果账本（viewer 数据源）
loadOptout(OPTOUT);                                     // 复原逐条排除名单
loadUserRedact(USERREDACT);                             // 复原个人脱敏词表
reconcileScope();                                       // 范围变了就清 seen、补全新范围历史
reconcilePipeline();                                    // 流水线升级了就重收受影响历史（当前：Codex token 用量）
log.info("sync started", { server: cfg.server_url, folders: (cfg.upload_folders || []).length, collect_all: COLLECT_ALL, conc: CONC, seen: seenSession.size, ver: CLIENT_VERSION, once });
// 本机查看器（仅常驻模式起；--once 回填不起，免得拉起一个短命监听）。失败不致命：采集照常。
if (!once) { try { startViewer({ ROOT, cfg, paths: { CC_ROOT, CODEX_ROOT, TRAE_MEMORY_ROOT } }); } catch (e) { log.warn("viewer start failed (collection unaffected)", { err: e.message }); } }
await safeTick();
if (once) printOnceSummary();                          // --once（含 join 首次回填）：给一句人话小结，别让用户只看到滚动日志/以为卡死
if (!once) backfillLedger().catch((e) => log.warn("backfill error", { err: e.message }));   // 首轮上传后再回填历史，不拖慢启动
if (!once) setInterval(safeTick, (cfg.interval_sec ?? 60) * 1000);

// --once 跑完打印「本机足迹」小结：传了几条 / 跳过几条（按原因），让 join 首同步有明确收尾。
// 数据取自结果账本（累计），首次接入时≈本轮结果；逐条细节走 brain viewer。
function printOnceSummary() {
  const all = allSessions();
  if (!all.length) { console.log("\n本机足迹：这台机器上还没扫到可上传的 session（装了 Claude Code / Codex 并用过才有）。\n"); return; }
  const up = all.filter((s) => s.status === "uploaded").length;
  const opted = all.filter((s) => s.status === "opted_out").length;
  const skipped = all.filter((s) => s.status === "skipped");
  const REASON_CN = { gated: "不在采集范围", nointent: "无对话内容", toobig: "体积超限", subagent: "子代理会话", empty: "空文件", excluded: "已排除", error: "出错" };
  const byReason = {};
  for (const s of skipped) { const k = REASON_CN[s.reason] || s.reason || "其它"; byReason[k] = (byReason[k] || 0) + 1; }
  const parts = Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
  console.log(`\n本机足迹：已上传 ${up} 条`
    + (opted ? ` · 个人排除 ${opted} 条` : "")
    + (skipped.length ? ` · 跳过 ${skipped.length} 条（${parts.join(" / ")}）` : ""));
  const gatedN = skipped.filter((s) => s.reason === "gated").length;
  if (gatedN) console.log(`  ↳ 其中 ${gatedN} 条不在采集范围（upload_folders 之外）——要纳入就把对应目录加进 upload_folders 再重跑。`);
  console.log(`  逐条看（哪些传了 / 没传 / 为什么）：brain viewer\n`);
}
