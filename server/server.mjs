#!/usr/bin/env node
// 团队大脑服务器：ingest（块1）+ 文档（块3）+ search/session（块4）。
// 本地先 HTTP；公网部署时套 HTTPS（域名+证书）。token 鉴权走 team.yaml。
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFileSync, existsSync, createReadStream, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { loadRoster, loadTokens, tokenIndex } from "../core/team.mjs";
import { loadRegistry, hasAnyRemote } from "../core/registry.mjs";
import { clientFor, ctxFor } from "../core/repohost.mjs";
import { redactReadable } from "../core/redact.mjs";
import { log } from "../core/log.mjs";
import { CLIENT_VERSION } from "../core/version.mjs";   // 服务器自身版本 == 打进 /client.tgz 的版本（启动重打包）→ 权威「最新客户端版本」
import { safeSegment, safeRelPath } from "../core/safe.mjs";
import { loadFeishu, makeReq } from "../core/feishu.mjs";
import { initTruth } from "./gitstore.mjs";
import { ingest } from "./ingest.mjs";
import { refreshAll, enumAndRegisterOrgRepos } from "./codestate.mjs";
import { readSpaceMeta } from "./space.mjs";
import { syncFeishuDocs } from "./feishudocs.mjs";
import { grepTruth, findTruth, lsTruth, logTruth, sessionsTruth, statsTruth, frontmatterOf, spaceStatsTruth } from "./query.mjs";
import { canonicalizePath, canonicalSpaceKey } from "../core/identity.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRUTH = process.env.TRUTH_DIR || join(ROOT, "truth-server");
const WEB_DIR = join(ROOT, "web");                 // 真相层 Web GUI 静态资源（无密钥）
const PORT = Number(process.env.PORT) || 8787;
// 默认只绑本机回环：公网经 TLS 反代访问，别把 8787 明文直接暴露到外网。
// 容器/反代在别的网段时用 HOST=0.0.0.0 显式放开（此时务必靠防火墙/安全组封住该端口）。
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024 * 1024;
// 安全响应头：挂在所有响应上。CSP 锁死外部加载面（脚本只许自身、无 inline）——给渲染不可信内容的 GUI 兜底。
// style 仍放行 inline（GUI 大量用 style=""）；img 放行 data:（favicon 是内联 svg）。
const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join("; "),
};
// Web GUI 静态资源：只认这些扩展名（不会撞到无扩展名的 API 路由如 /grep /ls）
const WEB_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json",
};

const roster = loadRoster(join(ROOT, "team.yaml"));
const tokens = tokenIndex(roster, loadTokens(process.env.TOKENS_FILE || join(ROOT, "tokens.yaml")));
const registry = loadRegistry(process.env.REGISTRY_FILE || join(ROOT, "registry.yaml"));  // 登记的 github org/repo（启动加载、restart 生效）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
  || (process.env.GITHUB_TOKEN_FILE && existsSync(process.env.GITHUB_TOKEN_FILE)
      ? readFileSync(process.env.GITHUB_TOKEN_FILE, "utf8").trim() : "");
const FEISHU = loadFeishu(process.env.FEISHU_FILE || join(ROOT, "feishu.yaml"));  // 文档层（飞书）凭证：缺则不启用
initTruth(TRUTH);

// 「问一句」理解层（可选）：复用服务器上已装的 codex（或任意 agent CLI）当引擎。
// 配了 ASK_ENABLED=1 才启用；二进制/参数全走 env，便于在服务器上不改代码调参。off 时网站问答 UI 自动隐藏。
const pexec = promisify(execFile);
const ASK = {
  enabled: process.env.ASK_ENABLED === "1",
  bin: process.env.ASK_CODEX_BIN || "codex",
  args: (process.env.ASK_CODEX_ARGS || "exec --skip-git-repo-check").split(/\s+/).filter(Boolean),
  cwd: process.env.ASK_CWD || TRUTH,                         // 默认在真相库里跑 → codex 直接 grep/read .md
  timeout: Number(process.env.ASK_TIMEOUT_MS) || 120000,     // 单次问答超时（agent 多回合，给足）
  max: Number(process.env.ASK_MAX_CONCURRENT) || 2,          // 并发上限，挡住成本/滥用
};
let askInflight = 0;
const ASK_HINT = "你在团队大脑「真相库」（一个 git 仓）当前目录里回答问题。库里有：spaces/<repo>/sessions/**/*.md（全队脱敏对话 transcript）、feishu/**/*.md（飞书文档镜像）、spaces/<repo>/code-state.md（代码状态）。请用 grep/read 翻这些 .md 文件，给出综合答复，并在末尾列出你引用的文件 path。不要读 .jsonl（用 .md）。问题：\n\n";
// 从 codex 输出里抽最终答复：--json 模式解 JSONL 取末条 agent 消息；否则直接回 stdout。
const extractAnswer = (out) => {
  const s = String(out || "").trim();
  if (!ASK.args.includes("--json")) return s;
  let ans = "";
  for (const line of s.split("\n")) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = o?.msg?.content ?? o?.message ?? (o?.type && /agent_message|assistant/i.test(o.type) ? (o.text ?? o.content) : "");
    if (typeof t === "string" && t.trim()) ans = t.trim();
  }
  return ans || s;
};

// 客户端自托管：把这份客户端代码打成 tarball（无密钥），供新人 `curl /get | bash` 下载。
const CLIENT_TGZ = "/tmp/team-brain-client.tgz";
// 客户端只跑 sync / cli / mcp（不碰飞书）→ 装机包里换上**精简版 package.json**：只留客户端真用到的依赖，
// 砍掉 server-only 的 lark SDK（@larksuiteoapi/node-sdk，含 axios/protobufjs 等 ~26M，占 node_modules 近一半）。
// 不带 package-lock.json：lock 里记着 lark 全树，带上反而让 npm 装回来；少了 lock，npm 按精简 deps 现解（就 3 个）。
const CLIENT_DEPS = new Set(["@modelcontextprotocol/sdk", "yaml", "zod"]);
function buildClientTarball() {
  let stage;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const clientPkg = {
      ...pkg,
      dependencies: Object.fromEntries(Object.entries(pkg.dependencies || {}).filter(([k]) => CLIENT_DEPS.has(k))),
    };
    if (clientPkg.scripts) delete clientPkg.scripts.server;   // 客户端不跑 server
    stage = mkdtempSync(join(tmpdir(), "tb-client-"));
    writeFileSync(join(stage, "package.json"), JSON.stringify(clientPkg, null, 2) + "\n");
    // tar 多个 -C：代码取自 ROOT，package.json 取自 stage（GNU/BSD tar 都支持）。
    execFileSync("tar", ["czf", CLIENT_TGZ,
      "-C", ROOT, "core", "client", "mcp", "cli", "install.sh", "client.config.example.yaml",
      "-C", stage, "package.json"], { stdio: "ignore" });
    log.info("[client] 已打包客户端", { path: CLIENT_TGZ });
  } catch (e) { log.warn("[client] 打包失败", { err: e.message }); }
  finally { if (stage) try { rmSync(stage, { recursive: true, force: true }); } catch {} }
}
buildClientTarball();

// 装机脚本（GET /get）：下载代码包 + 装依赖 + 注册全局 brain。SRV 取自请求 Host。
const installScript = (srv) => `#!/usr/bin/env bash
set -euo pipefail
SRV="${srv}"
DIR="$HOME/.team-brain"
command -v node >/dev/null || { echo "✗ 先装 Node 22+：https://nodejs.org"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "✗ Node 版本太低（\$(node -v)），需要 22+：https://nodejs.org"; exit 1; }
echo "[brain] 下载客户端…"
mkdir -p "$DIR"
curl -fsSL "$SRV/client.tgz" | tar xz -C "$DIR"
cd "$DIR"
npm install --silent --omit=dev
chmod +x cli/brain.mjs
# 让 brain 命令可用：优先 npm link（全局）；失败则软链到 ~/.local/bin，并自动把它写进 shell 的 PATH。
# BRAIN（给收尾提示用）：PATH 没就绪时回退成全路径，这样当前终端不用重开也能立刻跑。
BRAIN="brain"
if npm link >/dev/null 2>&1; then :; else
  mkdir -p "$HOME/.local/bin"; ln -sf "$DIR/cli/brain.mjs" "$HOME/.local/bin/brain"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      case "\${SHELL:-}" in *zsh) RC="$HOME/.zshrc";; *bash) RC="$HOME/.bashrc";; *) RC="$HOME/.profile";; esac
      LINE='export PATH="$HOME/.local/bin:$PATH"'
      grep -qF "\$LINE" "\$RC" 2>/dev/null || printf '%s\\n' "\$LINE" >> "\$RC"
      echo "[brain] 已把 ~/.local/bin 写进 \$RC —— 开个新终端，或先跑：source \$RC"
      BRAIN="$DIR/cli/brain.mjs"   # 当前终端 PATH 还没生效 → 用全路径，照样能跑
      ;;
  esac
fi
if [ -f "$DIR/client.config.yaml" ]; then
  echo "[brain] ✓ 客户端已更新（已配置过）。\$BRAIN status 看状态；改了代码/配置用 \$BRAIN service restart"
else
  echo "[brain] ✓ 装好。下一步：\$BRAIN join <你收到的邀请码>"
fi
`;

const authMember = (req) => {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const m = token ? tokens.get(token) || null : null;
  if (m) req._who = m.id;          // 给请求日志记身份用
  return m;
};
// 从 200 响应体推命中数（grep/find/ls/log/sessions 各自的结果字段）—— 给请求日志记 n，区分「空结果 vs 截断」。
const countOf = (o) => {
  if (!o) return undefined;
  if (Array.isArray(o.sessions)) return o.sessions.length;
  if (Array.isArray(o.commits)) return o.commits.length;
  if (Array.isArray(o.files)) return o.files.length;
  if (Array.isArray(o.entries)) return o.entries.length;
  if (Array.isArray(o.rows)) return o.rows.length;
  if (typeof o.matches === "string") return o.matches ? o.matches.split("\n").length : 0;
  return undefined;
};
const json = (res, code, obj) => {
  // 把「失败原因 / 命中数」挂到 res 上，请求收尾那行日志取用（一行就看清成败与缘由，不另起一行）。
  if (code >= 400 && obj?.error) res._err = String(obj.error).slice(0, 300);
  else if (code === 200) { const n = countOf(obj); if (n != null) res._n = n; }
  return res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => {
    try {
      let buf = Buffer.concat(chunks);
      if ((req.headers["content-encoding"] || "").includes("gzip")) buf = gunzipSync(buf);
      resolve(buf.toString("utf8"));
    } catch (e) { reject(e); }
  });
  req.on("error", reject);
});

// 坐标归一【兜底，不强改】：优先按 agent 给的 path 找（真实落盘位置就直接用）；
// 找不到再试 canonical（owner 搬家后抄了旧坐标 → 映射到现位置）。这样既兼容已重新归档的库（旧坐标→现位置），
// 又不会把"未重新归档的库里本就存在的真实路径"强改成一个不存在的位置而误 404。
const resolvePath = (rel) => {
  if (!rel) return rel;
  try { if (existsSync(safeRelPath(TRUTH, rel, "path"))) return rel; } catch { return rel; }
  const c = canonicalizePath(registry, rel);
  if (c !== rel) { try { if (existsSync(safeRelPath(TRUTH, c, "path"))) return c; } catch {} }
  return rel;
};
// 同理的 space 段兜底（grep/find 收窄用）：as-given 目录在就用它，不在再试 canonical。
const resolveSpace = (key) => {
  if (!key) return key;
  if (existsSync(join(TRUTH, "spaces", key))) return key;
  const c = canonicalSpaceKey(registry, key);
  if (c !== key && existsSync(join(TRUTH, "spaces", c))) return c;
  return key;
};

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const u = new URL(req.url, "http://x");
  // 来源 IP：公网套了 HTTPS 反代 → 真实 IP 在 x-forwarded-for（取第一跳）；本地直连回退 socket。
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress || "-";
  // 一个请求一行。字段：方法/路径/状态/耗时/身份/版本/来源IP/命中数(查询)/错误原因(失败)/查询串。
  const fields = () => ({
    m: req.method, path: u.pathname, status: res.statusCode,
    ms: Date.now() - t0, who: req._who || "-",
    cv: req.headers["x-client-version"] || "-",   // 客户端版本：看谁在跑旧版、该提醒更新
    ip,
    ...(res._n != null ? { n: res._n } : {}),     // 查询命中数：区分「0 命中 vs 截断」
    ...(res._err ? { err: res._err } : {}),       // 失败原因：4xx/5xx 才有
    ...(u.search ? { q: u.search.slice(1, 200) } : {}),
  });
  // 正常收尾：级别随严重度——<400 info、4xx warn（客户端/鉴权错）、5xx error（服务端炸）。/health 太吵不记。
  res.on("finish", () => {
    if (u.pathname === "/health") return;
    const s = res.statusCode;
    (s >= 500 ? log.error : s >= 400 ? log.warn : log.info)("req", fields());
  });
  // 连接在写完前就断了（客户端 abort / 网络挂 / 请求卡死被掐）→ finish 不触发，这里兜底记一笔。
  res.on("close", () => {
    if (res.writableFinished || u.pathname === "/health") return;
    log.warn("req aborted", fields());
  });
  // 兜底：任何路由里没被 catch 的异常都落日志 + 回 500，不让连接挂死。
  handle(req, res, u).catch((e) => {
    log.error("unhandled", { m: req.method, path: u.pathname, err: e?.message });
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function handle(req, res, u) {
  // --- 健康检查 ---
  if (req.method === "GET" && u.pathname === "/health") return json(res, 200, { ok: true });

  // --- 最新客户端版本（无需鉴权，版本号非机密）：采集器每天自检，比本机高就自动更新 ---
  if (req.method === "GET" && u.pathname === "/version") return json(res, 200, { version: CLIENT_VERSION });

  // --- 真相层 Web GUI（静态资源，无密钥、无需鉴权；背后的数据接口仍需 token）---
  // 根路径回 index.html；带已知扩展名的请求映射到 web/ 下的文件（路径穿越靠 safeRelPath 兜底）。
  if (req.method === "GET" && (u.pathname === "/" || WEB_TYPES[extname(u.pathname)])) {
    const rel = u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, "");
    let abs;
    try { abs = safeRelPath(WEB_DIR, rel, "asset"); } catch { return json(res, 400, { error: "bad path" }); }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return json(res, 404, { error: "not found" });
    const ext = extname(abs);
    // html 总是重新校验（拿最新视图）；其余静态资源缓存 5 分钟，字体 1 天
    const cache = ext === ".html" ? "no-cache"
      : ext === ".woff2" ? "public, max-age=86400"
      : "public, max-age=300";
    res.writeHead(200, { "content-type": WEB_TYPES[ext] || "application/octet-stream", "cache-control": cache });
    return createReadStream(abs).pipe(res);
  }

  // --- 客户端自托管（无需鉴权，代码不含密钥）---
  if (req.method === "GET" && u.pathname === "/get") {
    // Host 会被写进 curl|bash 的脚本里，必须挡住注入：要么用配好的 PUBLIC_URL，要么白名单校验 Host
    const host = req.headers.host || "";
    const srv = process.env.PUBLIC_URL || (/^[A-Za-z0-9.:-]+$/.test(host) ? `https://${host}` : "");
    if (!srv) return json(res, 400, { error: "bad host" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(installScript(srv));
  }
  if (req.method === "GET" && u.pathname === "/client.tgz") {
    if (!existsSync(CLIENT_TGZ)) return json(res, 503, { error: "client 包未就绪" });
    res.writeHead(200, { "content-type": "application/gzip" });
    return createReadStream(CLIENT_TGZ).pipe(res);
  }

  // --- 校验 token 身份（brain join 自检用）---
  if (req.method === "GET" && u.pathname === "/whoami") {
    const m = authMember(req);
    return m ? json(res, 200, { id: m.id, name: m.name }) : json(res, 401, { error: "invalid token" });
  }

  // --- 花名册（Web GUI「人」视图用）：team.yaml 非机密，只回 id/name，不含 token ---
  if (req.method === "GET" && u.pathname === "/roster") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    return json(res, 200, { members: (roster.members || []).map((m) => ({ id: m.id, name: m.name || m.id })) });
  }

  // --- 能力位（Web GUI 据此决定显隐可选功能）---
  if (req.method === "GET" && u.pathname === "/capabilities") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    return json(res, 200, { ask: ASK.enabled, feishu: !!FEISHU });
  }

  // --- 「问一句」：spawn 服务器上的 codex 现查真相库 → 综合答复（可选，ASK_ENABLED 才开）---
  if (req.method === "POST" && u.pathname === "/ask") {
    const m = authMember(req);
    if (!m) return json(res, 401, { error: "invalid token" });
    if (!ASK.enabled) return json(res, 503, { error: "问答未启用（服务器未配 ASK_ENABLED + codex）" });
    if (askInflight >= ASK.max) return json(res, 429, { error: "问答繁忙，请稍后再试" });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const q = String(body?.q || "").trim();
    if (!q) return json(res, 400, { error: "missing q" });
    if (q.length > 1000) return json(res, 400, { error: "问题过长（>1000 字）" });
    askInflight++;
    const t0 = Date.now();
    try {
      const { stdout } = await pexec(ASK.bin, [...ASK.args, ASK_HINT + q], { cwd: ASK.cwd, timeout: ASK.timeout, maxBuffer: 16 * 1024 * 1024 });
      log.info("ask ok", { who: m.id, ms: Date.now() - t0, qlen: q.length });
      return json(res, 200, { answer: extractAnswer(stdout) });
    } catch (e) {
      log.warn("ask failed", { who: m.id, ms: Date.now() - t0, err: String(e.message || e).slice(0, 200) });
      return json(res, 502, { error: "问答失败，请稍后再试（详情见服务器日志）" });
    } finally { askInflight--; }
  }

  // --- 读真相库任意文件（深挖；统一 path 坐标，grep/find/ls 命中的 path 直接拿来读）---
  // 出口过 redactReadable：.md 只脱敏正文、保留 frontmatter 公开 id（node_token 等不被误打码）；
  // .jsonl 原文无 frontmatter → 整体脱敏兜底，挡裸密钥/家目录离机。
  if (req.method === "GET" && u.pathname === "/read") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    // 坐标归一（兜底）：agent 可能抄了 log 给的旧/别名 space（haurhi…）→ 现位置找不到才映射，消除 404 类不一致
    const path = resolvePath(u.searchParams.get("path") || "");
    let abs;
    try { abs = safeRelPath(TRUTH, path, "path"); } catch { return json(res, 400, { error: "bad path" }); }
    if (!existsSync(abs)) return json(res, 404, { error: "not found" });
    if (statSync(abs).isDirectory()) return json(res, 400, { error: "是目录，请用 ls" });
    let text = redactReadable(readFileSync(abs, "utf8"));
    const offset = Math.max(0, Number(u.searchParams.get("offset")) || 0);
    const limit = Number(u.searchParams.get("limit")) || 0;
    if (offset || limit) text = text.split("\n").slice(offset, limit ? offset + limit : undefined).join("\n");
    return json(res, 200, { path, text });
  }

  // --- find：按文件名 glob / 子目录找文件（与 grep 互补）---
  if (req.method === "GET" && u.pathname === "/find") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    try {
      const fpath = u.searchParams.get("path");
      const r = await findTruth(TRUTH, {
        name: u.searchParams.get("name") || undefined,
        path: fpath ? resolvePath(fpath) : undefined,   // 接受别名/历史坐标（兜底）
        limit: u.searchParams.get("limit"),
      });
      // meta=1：顺带回每个文件的 frontmatter（服务端一次读完，省客户端 N+1 次 /read；走 query 的 mtime 缓存）
      if (u.searchParams.get("meta") === "1" && Array.isArray(r.files)) {
        const keys = ["title", "edited", "date", "updated", "producer", "submitter", "tool", "space_key", "branch"];
        r.files = r.files.map((rel) => {
          try { return { path: rel, meta: frontmatterOf(safeRelPath(TRUTH, rel, "path"), keys) || {} }; }
          catch { return { path: rel, meta: {} }; }
        });
      }
      return json(res, 200, r);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // --- 只读仓库查询：grep / ls / log（无 shell、锁死 TRUTH 内、只读）---
  if (req.method === "GET" && u.pathname === "/grep") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    try {
      const space = u.searchParams.get("space") || undefined;
      const r = await grepTruth(TRUTH, {
        pattern: u.searchParams.get("q") || "",
        context: u.searchParams.get("context"),
        ignoreCase: u.searchParams.get("ci") !== "0",
        space: space ? resolveSpace(space) : undefined,   // 别名/历史 space 收窄也能命中（兜底）
        raw: u.searchParams.get("raw") === "1",
      });
      return json(res, 200, { matches: r.matches, truncated: r.truncated });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }
  if (req.method === "GET" && u.pathname === "/ls") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    const path = resolvePath(u.searchParams.get("path") || "");   // 别名/历史坐标也能 ls（兜底）
    try {
      const top = !path || path === "spaces";
      let r;
      try { r = lsTruth(TRUTH, { path }); }
      catch (e) { if (!top) throw e; r = { path, type: "dir", entries: [] }; } // spaces 还没有也别崩
      // 顶层列 space 时附会话统计（会话数/最近活动/人数）——替代无意义的 children 计数
      if (top && Array.isArray(r.entries)) {
        const stats = spaceStatsTruth(TRUTH);
        for (const e of r.entries) { const s = stats[e.name]; if (s) Object.assign(e, s); }
      }
      return json(res, 200, r);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }
  if (req.method === "GET" && u.pathname === "/log") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    try {
      const r = await logTruth(TRUTH, {
        space: u.searchParams.get("space") || undefined,
        since: u.searchParams.get("since") || undefined,
        author: u.searchParams.get("author") || undefined,
        grep: u.searchParams.get("grep") || undefined,
        limit: u.searchParams.get("limit"),
        registry,                                       // 坐标/分支归一用
      });
      return json(res, 200, { commits: r });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // --- sessions：按【人 + 工作时间】检索 session（这条链路的主原语）---
  // 时间走卡片 frontmatter 的工作时间（非 commit 时间）；身份走花名册归一（tqt==taoqitian）；坐标 canonical。
  if (req.method === "GET" && u.pathname === "/sessions") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    try {
      const r = await sessionsTruth(TRUTH, {
        author: u.searchParams.get("author") || undefined,
        space: u.searchParams.get("space") || undefined,
        since: u.searchParams.get("since") || undefined,
        until: u.searchParams.get("until") || undefined,
        limit: u.searchParams.get("limit"),
        withIngestDate: u.searchParams.get("ingest_date") === "1",   // 入库时间按需（贵：每条一次 git log）
        roster, registry,
      });
      return json(res, 200, r);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // --- stats：全队聚合统计（按【工作时间】，与 sessions 同源；只读卡片 frontmatter、零落盘索引）---
  if (req.method === "GET" && u.pathname === "/stats") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    try {
      const space = u.searchParams.get("space") || undefined;
      const r = await statsTruth(TRUTH, {
        by: u.searchParams.get("by") || undefined,
        split: u.searchParams.get("split") || undefined,
        metric: u.searchParams.get("metric") || undefined,
        since: u.searchParams.get("since") || undefined,
        until: u.searchParams.get("until") || undefined,
        space: space ? resolveSpace(space) : undefined,         // 别名/历史 space 收窄也能命中（兜底）
        author: u.searchParams.get("author") || undefined,
        tool: u.searchParams.get("tool") || undefined,
        limit: u.searchParams.get("limit"),
        offset: u.searchParams.get("offset"),
        roster, registry,
      });
      return json(res, 200, r);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // --- read_github：按需现拉内容 / 看 code-state（块: read_github）---
  if (req.method === "GET" && u.pathname === "/github") {
    if (!authMember(req)) return json(res, 401, { error: "invalid token" });
    const space_key = u.searchParams.get("space_key") || "";
    try { safeSegment(space_key, "space_key"); } catch { return json(res, 400, { error: "bad space_key" }); }
    const path = u.searchParams.get("path");
    const ref = u.searchParams.get("ref") || undefined;
    const meta = readSpaceMeta(TRUTH, space_key);          // provider/host/owner/repo/base_url（老 github 空间自动归一）
    const client = clientFor(meta.provider);
    if (!meta.owner || !meta.repo || !client) return json(res, 404, { error: "该 space 无可现拉的代码坐标" });
    const ctx = ctxFor(registry, meta, GITHUB_TOKEN);
    if (!ctx.token) return json(res, 503, { error: meta.provider === "github"
      ? "该 space 无可用 GitHub PAT（registry 未配，且无全局 GITHUB_TOKEN）"
      : `该 space 无可用 ${meta.provider} token（registry 未配该实例/项目）` });
    try {
      if (path) {
        const content = await client.fileContent(meta.owner, meta.repo, path, ref, ctx);
        return json(res, 200, { space_key, path, ref: ref || "default", content });
      }
      const csp = join(TRUTH, "spaces", space_key, "code-state.md");
      return json(res, 200, { space_key, code_state: existsSync(csp) ? readFileSync(csp, "utf8") : "（尚无 code-state，等首次 4h 轮询）" });
    } catch (e) {
      log.warn("repo read failed", { who: req._who, space_key, err: String(e.message || e).slice(0, 200) });
      return json(res, 502, { error: "代码托管读取失败（详情见服务器日志）" });
    }
  }

  // --- ingest（块1）---
  if (req.method === "POST" && u.pathname === "/ingest") {
    const member = authMember(req);
    if (!member) return json(res, 401, { error: "invalid or missing token" });
    let body;
    try { body = await readBody(req); } catch { return json(res, 413, { error: "payload too large" }); }
    let payload;
    try { payload = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
    try {
      const r = await ingest(TRUTH, payload, member, registry);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      log.error("ingest failed", { who: member.id, id: payload?.id, err: e?.message });
      return json(res, 500, { error: "ingest 失败（详情见服务器日志）" });
    }
  }

  json(res, 404, { error: "not found" });
}

server.listen(PORT, HOST, () =>
  log.info("server up", { host: HOST, port: PORT, truth: TRUTH, members: (roster.members || []).length, tokens: tokens.size })
);
log.info(ASK.enabled ? "[ask] 「问一句」已启用" : "[ask] 「问一句」未启用（配 ASK_ENABLED=1 + 服务器装 codex 即开）",
  ASK.enabled ? { bin: ASK.bin, cwd: ASK.cwd } : {});

// 本地静态开发模式：NO_POLL=1 跳过两个后台轮询（不出网、不改写 TRUTH）→ 拿静态 fixtures 开发 web GUI
const NO_POLL = process.env.NO_POLL === "1";
if (NO_POLL) log.info("[no-poll] 后台轮询已关（NO_POLL=1）：code-state / feishu 同步跳过，TRUTH 保持静态");

// code-state 4h 轮询（registry 有任一 provider 登记、或配了全局 GITHUB_TOKEN 就启用）
if (!NO_POLL && (GITHUB_TOKEN || hasAnyRemote(registry))) {
  // 启动时按 registry 枚举 scope（github org / gitlab group / gitea org）的 repo → 预登记 space（无 session 也建），
  // 再跑首轮 code-state（懒加载只刷有 session 的）。各仓 token/baseUrl 由 ctxFor 按 registry 解。
  const tick = () => enumAndRegisterOrgRepos(TRUTH, registry, GITHUB_TOKEN)
    .then((e) => e.registered && log.info("[registry] 预登记 space", { count: e.registered }))
    .then(() => refreshAll(TRUTH, registry, GITHUB_TOKEN))
    .then((r) => log.info("[code-state] 刷新完成", { active: r.filter((x) => !x.skipped).length, skipped: r.filter((x) => x.skipped).length }))
    .catch((e) => log.error("[code-state] 失败", { err: e.message }));
  setTimeout(tick, 30_000);                 // 启动 30s 后先跑一次
  setInterval(tick, 4 * 3600 * 1000);       // 之后每 4h
  log.info("[code-state] 轮询已开（每 4h）");
} else {
  log.info("[code-state] 未配 registry 也无 GITHUB_TOKEN → code-state 轮询 / read_github 暂不启用");
}

// 飞书文档镜像轮询（配了 feishu.yaml 就启用）：单向拉 wiki 正文进 feishu/ 子树，grep/read 即可搜
if (!NO_POLL && FEISHU) {
  const freq = makeReq(FEISHU);
  const ftick = () => syncFeishuDocs(TRUTH, freq, { wikiBase: FEISHU.wiki_base })
    .then((r) => log.info("[feishu-docs] 同步完成", { spaces: r.spaces, written: r.written, pruned: r.pruned, skipped: r.skipped, errors: r.errors }))
    .catch((e) => log.error("[feishu-docs] 失败", { err: e.message }));
  setTimeout(ftick, 60_000);                              // 启动 60s 后首跑（错开 code-state 的 30s）
  setInterval(ftick, FEISHU.poll_hours * 3600 * 1000);
  log.info("[feishu-docs] 轮询已开", { hours: FEISHU.poll_hours });
} else {
  log.info("[feishu-docs] 未配 feishu.yaml → 文档层暂不启用");
}
