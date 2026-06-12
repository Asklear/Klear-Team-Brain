// 只读「仓库查询」族：grep / find / ls / log —— 把团队大脑真相库当成一个可被 shell 查的目录，
// 但只暴露能力、不暴露 shell：全部 execFile（无 shell → 无 $()/;/| 注入）、锁死在 TRUTH 内、
// 只读、带超时与输出上限。给客户端 Agent 一个比 4 个死板原语更灵活的检索面，且零服务器 LLM。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { safeSegment, safeRelPath } from "../core/safe.mjs";
import { fm } from "../core/card.mjs";
import { canonicalSpaceKey, canonicalizeSubject, resolveAuthorQuery, authorMatches } from "../core/identity.mjs";

const pexec = promisify(execFile);
const TIMEOUT = 8000;                       // 子进程超时：恶意/超大正则不会拖死服务器
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_LINES = 200;                       // grep 输出行上限，超了截断并标记

const ctxOf = (context) => Math.min(Math.max(Number(context) || 0, 0), 3);

// 跑一条 grep（git grep 或普通 grep），统一超时/上限/截断/退出码1=无命中。strip：去掉行首的绝对路径前缀。
async function runGrep(cmd, args, strip) {
  try {
    const { stdout } = await pexec(cmd, args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
    let lines = stdout.split("\n");
    if (strip) lines = lines.map((l) => l.startsWith(strip) ? l.slice(strip.length).replace(/^\//, "") : l);
    return { matches: lines.slice(0, MAX_LINES).join("\n").trimEnd(), truncated: lines.length > MAX_LINES };
  } catch (e) {
    if (e.code === 1) return { matches: "", truncated: false };   // 退出码 1 = 无命中（非错误）
    throw e;
  }
}

// grep：默认只搜卡片(*.md，高信号的意图+结论)；raw=true 才连原文 jsonl。可按 space 收窄。
// 走 git grep：只搜已提交的真相、天然锁在仓库内、各平台 git 都有（生产 Ubuntu 不一定装 rg）。
export async function grepTruth(TRUTH, { pattern, space, context = 1, ignoreCase = true, raw = false } = {}) {
  const pat = String(pattern ?? "").trim();
  if (!pat) throw new Error("missing pattern");
  if (pat.length > 500) throw new Error("pattern too long");
  const globs = raw ? ["*.md", "*.jsonl"] : ["*.md"];
  const pathspec = space
    ? globs.map((g) => `:(glob)spaces/${safeSegment(space, "space")}/**/${g}`)
    : globs.map((g) => `:(glob)**/${g}`);
  const args = ["-C", TRUTH, "grep", "-nI", "--no-color",
    ...(ignoreCase ? ["-i"] : []), "-C", String(ctxOf(context)), "-e", pat, "--", ...pathspec];
  return runGrep("git", args);
}

// 某 space 目录下有没有 session（.md）—— ls 顶层标"活跃 vs 仅登记"用
function hasSessionsDir(spaceDir) {
  const sd = join(spaceDir, "sessions");
  if (!existsSync(sd)) return false;
  try { return readdirSync(sd).some((br) => { try { return readdirSync(join(sd, br)).some((f) => f.endsWith(".md")); } catch { return false; } }); }
  catch { return false; }
}

// ls：列目录结构。给目录 → 列子项（目录在前、附子项计数）；给文件 → 返回大小。锁在 TRUTH 内。
export function lsTruth(TRUTH, { path = "" } = {}) {
  const abs = safeRelPath(TRUTH, path || ".", "path");
  if (!existsSync(abs)) throw new Error("not found");
  const st = statSync(abs);
  if (!st.isDirectory()) return { path: path || "", type: "file", size: st.size };
  const atSpacesTop = (path || "") === "" || path === "spaces";   // 顶层列 space 时标活跃度
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .map((e) => {
      const row = { name: e.name, type: e.isDirectory() ? "dir" : "file" };
      if (e.isDirectory()) {
        try { row.children = readdirSync(join(abs, e.name)).filter((n) => n !== ".git").length; } catch {}
        // 活跃 = 有 session（org 预登记的空 space → active:false，"仅登记"）
        if (atSpacesTop) row.active = hasSessionsDir(join(abs, e.name));
      }
      return row;
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: path || "", type: "dir", entries };
}

// log：真相库 git 历史 = 全队活动流（每条 ingest/doc 一个 commit）。可按 space / 作者 / 时间收窄。
// ⚠️ 时间是【入库/commit 时间】（%aI），不是工作时间；批量回填会把它压成一坨。按"谁这周干了啥"要用 sessionsTruth。
// 坐标归一：commit subject 是入库那刻冻结的文本，owner 搬家（registry.moved）后仍写旧 space_key →
//   出口过 canonicalizeSubject 改成现位置，保证"复制 log 坐标 → read/ls"不再 404。
export async function logTruth(TRUTH, { space, since, author, grep, limit = 20, registry = {} } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const args = ["-C", TRUTH, "log", "--format=%h%x1f%aI%x1f%an%x1f%s", "-n", String(n)];
  // 下面这些都作为独立 argv 元素 + `--opt=value` 形态传入（execFile 无 shell）→ 不会被当命令或前导 flag 解析
  if (since != null && since !== "") {
    if (!/^[\w :.+-]{1,40}$/.test(String(since))) throw new Error("bad since");
    args.push(`--since=${since}`);
  }
  if (author != null && author !== "") args.push(`--author=${String(author).slice(0, 80)}`);
  if (grep != null && grep !== "") args.push(`--grep=${String(grep).slice(0, 200)}`, "-i");
  // space 过滤：用户可能给别名/历史 key（haurhi…）→ 先归一到现位置目录再收窄
  if (space) args.push("--", `spaces/${safeSegment(canonicalSpaceKey(registry, space), "space")}`);
  const { stdout } = await pexec("git", args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
  return stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, date, an, subject] = l.split("\x1f");
    return { sha, date, author: an, subject: canonicalizeSubject(registry, subject) };
  });
}

// 递归收集 spaces 下的 session 卡片 .md（skip .git）。
function* walkMd(dir) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

// 某文件的入库时间（%aI），best-effort；只对返回的 N 条调，避免全量 git。
async function ingestDateOf(TRUTH, rel) {
  try {
    const { stdout } = await pexec("git", ["-C", TRUTH, "log", "-1", "--format=%aI", "--", rel],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
    return stdout.trim();
  } catch { return ""; }
}

// 正文首行预览（frontmatter 之后），给 agent 一眼判断要不要深读。压成单行、截短。
function previewOf(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.replace(/\s+/g, " ").slice(0, 160);
  }
  return "";
}

// sessions：按【人 + 工作时间】检索 session 卡片 —— 这条链路的主原语。
// 与 log 的根本区别：时间维度走卡片 frontmatter 的 date(工作起)/updated(末次输入=工作止)，
//   不是 commit 时间 → 批量回填也能按"真实何时干活"过滤排序，事故必然被查到。
// 身份走花名册归一（tqt==taoqitian），坐标走 canonical（haurhi→Asklear）→ 返回的坐标能被 read 直接消费。
// 不落索引文件（守"视图可重建/别把索引塞落盘层"不变量）：现读卡片 frontmatter，零持久态、零漂移。
export async function sessionsTruth(TRUTH, { author, space, since, until, limit = 50, roster = { members: [] }, registry = {} } = {}) {
  const resolved = resolveAuthorQuery(roster, author);
  const wantSpace = space ? canonicalSpaceKey(registry, space) : null;
  const sinceD = since ? String(since).slice(0, 10) : null;
  const untilD = until ? String(until).slice(0, 10) : null;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = [];
  for (const mdPath of walkMd(join(TRUTH, "spaces"))) {
    const rel = relative(TRUTH, mdPath);
    if (!rel.includes("/sessions/")) continue;          // 只看 session 卡片，skip code-state 等
    let text; try { text = readFileSync(mdPath, "utf8"); } catch { continue; }
    const head = text.slice(0, 4096);
    const date = fm(head, "date");                        // 首条消息时间（工作起）
    if (!date) continue;                                  // 无 date → 非 session 卡片
    const updated = fm(head, "updated") || date;          // 末条输入时间（工作止）= 用户心智里"session 的时间"
    // 坐标用【真实落盘位置】（path 的 space 段）→ 与 path 一致、能被 read 直接消费；
    // 过滤才按 canonical 比较（别名/历史 owner 也能命中），不把输出坐标改到一个可能不存在的位置。
    const realSpace = rel.split("/")[1] || "";
    if (wantSpace && canonicalSpaceKey(registry, realSpace) !== wantSpace) continue;
    const producerId = fm(head, "producer_id");
    const submitter = fm(head, "submitter") || fm(head, "producer");
    if (!authorMatches(resolved, { producerId, author: submitter })) continue;
    const ws = date.slice(0, 10), we = updated.slice(0, 10);
    if (sinceD && we < sinceD) continue;                  // 工作区间 [ws,we] 与查询窗 [since,until] 不相交 → 排除
    if (untilD && ws > untilD) continue;
    const parts = rel.split("/");
    rows.push({
      path: rel, space_key: realSpace, branch: parts[3] || "", file: parts[parts.length - 1],
      producer_id: producerId, author: submitter, tool: fm(head, "tool"),
      work_start: date, work_end: updated, preview: previewOf(text),
    });
  }
  rows.sort((a, b) => (b.work_end || "").localeCompare(a.work_end || ""));  // 默认按末次活动倒序
  const top = rows.slice(0, n);
  for (const r of top) r.ingest_date = await ingestDateOf(TRUTH, r.path);   // 两种时间都带上、标注清楚
  return { sessions: top, total: rows.length, truncated: rows.length > n };
}

// find：按文件名 glob / 子目录前缀找文件（git ls-files：只列已提交、天然锁仓内、跨平台）。
// 与 grep 互补——grep 搜内容、find 搜文件名/路径。name 走 glob（* ? 不跨 /），path 限定子目录。
export async function findTruth(TRUTH, { name = "*", path = "", limit = 200 } = {}) {
  const nm = (String(name ?? "").trim()) || "*";
  if (nm.length > 200) throw new Error("name too long");
  if (/[\0\n\\/]/.test(nm)) throw new Error("bad name");   // 文件名层：挡控制符/反斜杠/路径分隔（目录靠 path 参数）
  let rel = String(path ?? "").trim().replace(/\/+$/, "");
  if (rel) safeRelPath(TRUTH, rel, "path");                // 锁死在 TRUTH 内
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const spec = rel ? `:(glob)${rel}/**/${nm}` : `:(glob)**/${nm}`;
  const { stdout } = await pexec("git", ["-C", TRUTH, "ls-files", "--", spec],
    { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
  const files = stdout.split("\n").filter(Boolean);
  return { files: files.slice(0, n), truncated: files.length > n };
}
