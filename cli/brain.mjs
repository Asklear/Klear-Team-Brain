#!/usr/bin/env node
// brain —— 团队大脑客户端单入口。降低拉人门槛：setup 一次，service 常驻，status 看状态。
//   brain setup                  交互式生成 client.config.yaml + 接上 MCP
//   brain start [--once]         前台跑 sync（Ctrl-C 关；--once 扫一次就退）
//   brain service install        装后台常驻（mac=launchd / linux=systemd 用户级）
//   brain service uninstall      卸掉常驻（只停常驻，配置/MCP 还在）
//   brain service restart        重启常驻（改了代码/配置后用）
//   brain stop                   停掉常驻（不卸）
//   brain uninstall [--purge]    完整卸载：停常驻 + 摘 MCP + 删 token 配置（--purge 连命令/目录）
//   brain status                 看常驻状态 + 最近一条 sync
//   brain logs [-f]              看 sync 日志（-f 跟随）
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parse } from "yaml";
import { CLIENT_VERSION } from "../core/version.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// NODE（常驻/MCP 要用的绝对 node 路径）在下面 resolveNode() 里解析 —— 避开 nvm 版本路径换/删后失效
const CFG = join(ROOT, "client.config.yaml");
const LOG = join(ROOT, "sync.log");
const LABEL = "com.teambrain.sync";                  // 沿用现有 launchd label
const IS_MAC = platform() === "darwin";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config", "systemd", "user", "team-brain-sync.service");
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (s) => spawnSync("sleep", [String(s)]);   // 同步等一下（launchd teardown 异步）
const has = (cmd) => sh(IS_MAC || platform() === "linux" ? "which" : "where", [cmd]).status === 0;
const die = (msg) => { console.error(c.warn(`✗ ${msg}`)); process.exit(1); };
const loadCfg = () => { try { return parse(readFileSync(CFG, "utf8")) || {}; } catch { return {}; } };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // 给 SSH 远端命令做 shell 转义

// 常驻服务要用绝对 node 路径（launchd/systemd PATH 很瘦）。但当前 node 若在版本管理器目录下
// （nvm/fnm/volta/asdf/n），钉进 plist 会在你换/删该版本后失效 → 优先挑稳定的系统/homebrew node。
function resolveNode() {
  const cur = process.execPath;
  if (!/\/(\.nvm|\.fnm|\.volta|\.asdf|n\/versions)\//.test(cur)) return { node: cur, warn: null };
  for (const cand of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (!existsSync(cand)) continue;
    const v = sh(cand, ["-v"]).stdout?.trim() || "";
    if (Number(v.replace(/^v/, "").split(".")[0]) >= 20) return { node: cand, warn: null };
  }
  return { node: cur, warn: `常驻绑定了当前 node（${cur}），它在版本管理器目录下——以后删/换该 node 版本常驻会失效，届时重跑 brain service install 即可。` };
}
const { node: NODE, warn: NODE_WARN } = resolveNode();

// 接 MCP（join/setup 共用）：尽量同时接 Claude Code 和 Codex，最后给一句明确的
// 「接上了啥 / 没接上啥 / 怎么补 / 别的工具怎么接」。返回已接上的工具名数组（join 用它定收尾话术）。
function addMcp() {
  const mcp = join(ROOT, "mcp", "server.mjs");
  const cmd = `${NODE} ${mcp}`;                         // 团队大脑 MCP 是个 stdio server，任何支持 MCP 的工具都用这条命令起它
  const attached = [];

  // 1) Claude Code —— 用它自带的 `claude mcp add`。--scope user：装到用户全局，
  //    任何目录开 CC 都能用；不带它默认是 local（只绑当前目录，换目录就没了）。
  if (has("claude")) {
    const r = sh("claude", ["mcp", "add", "team-brain", "--scope", "user", "--", NODE, mcp]);
    if (r.status === 0) { console.log(c.ok("✓ Claude Code 已接（team-brain）")); attached.push("Claude Code"); }
    else console.log(c.warn(`✗ Claude Code 接 MCP 失败：${(r.stderr || r.stdout || "").trim().split("\n")[0]}`));
  } else console.log(c.dim("· 未发现 claude CLI（没装 Claude Code，或不在 PATH）"));

  // 2) Codex —— 写 ~/.codex/config.toml
  const codex = addCodexMcp();
  if (codex === "ok") attached.push("Codex");
  else if (codex === "absent") console.log(c.dim("· 未发现 Codex（~/.codex 不存在）"));

  // 3) 小结：接上了就提醒重开会话；一个都没接上就显眼提示「消费侧还用不了 + 怎么补」
  if (attached.length) {
    console.log(c.ok(`✓ MCP 已接：${attached.join(" / ")}`) + c.dim("（重开编辑器/会话生效）"));
  } else {
    console.log(c.warn("\n⚠ 还没接上任何编辑器 —— 在编辑器里问大脑（消费侧）暂时用不了。"));
    console.log(c.dim("  装好 Claude Code 或 Codex 后，回来跑一次：brain mcp"));
  }

  // 4) 没全接上（含「想接别的 coding agent CLI」）就给一份「怎么接」——命令固定就这条 stdio server
  if (attached.length < 2) {
    console.log(c.dim("\n手动 / 接别的工具（团队大脑 MCP 是个 stdio server，命令都是同一条）："));
    console.log(c.dim(`  通用命令       ${cmd}`));
    console.log(c.dim(`  Claude Code    claude mcp add team-brain --scope user -- ${cmd}`));
    console.log(c.dim(`  Codex          ~/.codex/config.toml 加 [mcp_servers.team-brain]：command="${NODE}" args=["${mcp}"]`));
    console.log(c.dim(`  Gemini CLI / Cursor / Cline / opencode 等  在其 MCP 配置里加个 stdio server，command/args 用上面的「通用命令」`));
  } else {
    console.log(c.dim("（想接别的 MCP 工具？命令见 README「在编辑器里问」一节，或再跑 brain mcp）"));
  }
  return attached;
}

// 接 Codex MCP：~/.codex/config.toml 幂等加一段 [mcp_servers.team-brain]（Codex 是 TOML，跟 claude 两套）。
// 返回 "ok"（接上/已在）| "absent"（没装 Codex）| "fail"（写失败），由 addMcp 汇总。
function addCodexMcp() {
  const dir = join(homedir(), ".codex");
  if (!existsSync(dir)) return "absent";               // 没装 Codex 就不接
  const cfgPath = join(dir, "config.toml");
  const mcp = join(ROOT, "mcp", "server.mjs");
  let toml = ""; try { toml = readFileSync(cfgPath, "utf8"); } catch {}
  if (toml.includes("[mcp_servers.team-brain]")) { console.log(c.dim("✓ Codex 已接（~/.codex/config.toml 已有，跳过）")); return "ok"; }
  const head = toml === "" ? "" : (toml.endsWith("\n") ? "\n" : "\n\n");
  try {
    writeFileSync(cfgPath, `${toml}${head}[mcp_servers.team-brain]\ncommand = "${NODE}"\nargs = ["${mcp}"]\n`);
    console.log(c.ok("✓ Codex 已接（team-brain → ~/.codex/config.toml）"));
    return "ok";
  } catch (e) { console.log(c.warn(`✗ Codex 接 MCP 失败：${e.message}`)); return "fail"; }
}

// 写 client.config.yaml（setup 与 join 共用同一份模板）
function writeConfig({ server, token, id, name, folders = [], consumer = false, collectAll = false }) {
  writeFileSync(CFG,
    `# 客户端配置（含 token，已 gitignore）。改了跑 brain service restart。\n` +
    `server_url: ${server}\n` +
    `token: "${token}"\n` +
    `me:\n  id: ${id}\n  name: ${name}\n\n` +
    (consumer
      ? `# 纯消费者：不采集本机，只用来问大脑\nupload_folders: []\n`
      : collectAll
      ? `# 未指定工作空间 → 采集本机所有 session（含全部项目）。要收窄改 upload_folders。\ncollect_all: true\nupload_folders: []\n`
      : `upload_folders:\n${folders.map((f) => `  - ${f}`).join("\n")}\n`) +
    `exclude: []\n\n` +
    // 采集开关：codex / session_history / Trae 原生记忆默认都开（与 client.config.example.yaml 对齐）。
    // 别再写 docs/agentdocs —— M3 起这两个键没有任何代码读，是历史残留。
    `codex: true\nsession_history_md: true\ntrae_memory: true\ninterval_sec: 60\ndebounce_sec: 60\n`);
}

// 从本机 CC session 推测"你常在哪些 git 仓干活"，作为 upload_folders 建议
function detectFolders(limit = 12) {
  const root = join(homedir(), ".claude", "projects");
  const tops = new Set();
  let dirs; try { dirs = readdirSync(root); } catch { return []; }
  // 按最近活跃挑前 limit 个 project
  const ranked = dirs.map((d) => { try { return { d, t: statSync(join(root, d)).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.t - a.t).slice(0, limit);
  for (const { d } of ranked) {
    const pd = join(root, d);
    let files; try { files = readdirSync(pd).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    let lines; try { lines = readFileSync(join(pd, files[0]), "utf8").split("\n"); } catch { continue; }
    for (const line of lines.slice(0, 50)) {             // 扫到第一条带 cwd 的为止（首行常是 meta，没 cwd）
      if (!line.trim()) continue;
      let cwd; try { cwd = JSON.parse(line).cwd; } catch { continue; }
      if (cwd) { const top = sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).stdout?.trim(); tops.add(top || cwd); break; }
    }
  }
  return [...tops];
}

// ---------------- setup ----------------
async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(`${q}${def ? c.dim(` [${def}]`) : ""}: `)).trim();
    return a || def || "";
  };
  console.log(c.b("\n团队大脑 · 客户端配置\n") + c.dim("（CEO 在服务器 tokens.yaml 给你生成 token 后私下发你）\n"));

  if (existsSync(CFG) && (await ask("client.config.yaml 已存在，覆盖？(y/N)", "N")).toLowerCase() !== "y") {
    console.log(c.dim("保留现有配置，跳过。")); rl.close(); return;
  }
  const server = await ask("服务器地址", "https://your-server.example.com");
  const token = await ask("你的 token（必填）");
  if (!token) { rl.close(); die("token 必填"); }
  const id = await ask("你的 id（要和 team.yaml 一致，必填）");
  if (!id) { rl.close(); die("id 必填"); }
  const name = await ask("你的名字", id);
  const foldersRaw = await ask("要采集的工作空间（多个用逗号分隔，留空=采集本机所有 session）");
  const folders = foldersRaw.split(",").map((s) => s.trim()).filter(Boolean);
  let collectAll = false;
  if (!folders.length) {
    collectAll = true;
    console.log(c.warn(`⚠️ 没指定工作空间 → 默认采集本机【所有项目】的 session：这台机器上每个项目的 AI 对话原文都会上传，全队都能 grep 到。`));
    console.log(c.dim(`  含密钥 / 客户数据 / 私人项目的，回头改 upload_folders 收窄（改完 brain service restart）。`));
  } else {
    for (const f of folders) if (!existsSync(f)) console.log(c.warn(`  ⚠ ${f} 现在不存在，先写进去，回头建了即可`));
  }
  rl.close();

  writeConfig({ server, token, id, name, folders, collectAll });
  console.log(c.ok(`\n✓ 写好 ${CFG}`));

  addMcp();                                           // 接 MCP（问 Agent 那条）：Claude Code + Codex，含「没接上怎么补 / 别的工具怎么接」
  console.log(c.b("\n下一步：") + " brain service install  " + c.dim("（装后台常驻；或 brain start 前台试跑）\n"));
}

// ---------------- quickstart（本地单机自助接入：免 VPS/HTTPS/邀请码）----------------
// 跑 scripts/quickstart.mjs 自举（花名册+token+客户端配置→localhost）→ 接 MCP。不在这里起 server/sync：
// 服务端要用户自己 `npm run server` 起来（quickstart 末尾已提示），起好后再 sync 才传得上。
function quickstart() {
  const qs = join(ROOT, "scripts", "quickstart.mjs");
  // quickstart 是「git clone 完整仓 → 本机起服务尝鲜」的玩法；brain join 装的轻量客户端包不含 scripts/server/，用不了。
  if (!existsSync(qs)) die("brain quickstart 只在 git clone 的完整仓里可用（本地起服务尝鲜）。你这是接入已有服务器的客户端包——用 brain join / brain setup。");
  const pass = process.argv.slice(3);                  // 透传 --server/--id/--name/--force 给 scripts/quickstart.mjs
  const r = spawnSync(NODE, [qs, ...pass], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) die("quickstart 自举失败");
  addMcp();                                             // 接 Claude Code + Codex 的 MCP（指向本地 mcp/server.mjs → 读 client.config 打 localhost）
}

// ---------------- start（前台）----------------
function start(once) {
  if (!existsSync(CFG)) die("还没配置，先跑 brain setup");
  const args = [join(ROOT, "client", "sync.mjs"), ...(once ? ["--once"] : [])];
  console.log(c.dim(`前台运行 sync${once ? "（--once）" : "（Ctrl-C 退出）"}…`));
  const p = spawn(NODE, args, { cwd: ROOT, stdio: "inherit" });
  p.on("exit", (code) => process.exit(code ?? 0));
}

// ---------------- update（从服务器拉最新客户端代码 + 重启常驻）----------------
// 服务器的 /client.tgz 只含代码（core/client/mcp/cli + 精简 package.json，无 lark），不含 client.config.yaml/状态，
// 所以解压覆盖到 ROOT 不会动你的 token/配置/已上传记录。比重跑 curl|bash 干净：不重做 MCP/PATH 那些一次性步骤。
// 把服务器最新客户端代码落盘（下载 + 解压覆盖 + 装依赖），不碰常驻。
// 拆出来给两处共用：手动 `brain update`（落盘后再重启）与采集器自动更新（落盘后自己退出、让常驻管理器以新代码拉起，避开重启竞态）。
function applyUpdate() {
  // 安全闸：ROOT 是 git 仓 = 开发 checkout（不是 ~/.team-brain 装机目录）→ 解压会覆盖你的源码改动，拦住。
  if (existsSync(join(ROOT, ".git")))
    die(`这里是 git 开发仓（${ROOT}），brain update 会用服务器代码覆盖它。要更新真实安装请到 ~/.team-brain 跑，或忽略本命令。`);
  const cfg = loadCfg();
  if (!cfg.server_url) die("还没配置，先 brain join / brain setup");
  const url = cfg.server_url.replace(/\/$/, "") + "/client.tgz";
  const tmp = join(tmpdir(), `team-brain-update-${process.pid}.tgz`);
  console.log(c.dim(`拉取最新客户端 ← ${url} …`));
  if (sh("curl", ["-fsSL", "-o", tmp, url]).status !== 0) die("下载失败（检查网络 / server_url）");
  // 先下到临时文件再解：边下边解中途断网会留半个文件树
  if (sh("tar", ["xzf", tmp, "-C", ROOT]).status !== 0) { try { unlinkSync(tmp); } catch {} die("解压失败"); }
  try { unlinkSync(tmp); } catch {}
  console.log(c.dim("更新依赖…"));
  // 旧版装机包带过 lark 全树的 package-lock.json → 删掉它再装，否则 npm 会照旧 lock 把 lark 装回来；
  // 装完 prune 掉 node_modules 里残留的 lark（已不在精简 package.json 里），把客户端瘦下来。
  try { unlinkSync(join(ROOT, "package-lock.json")); } catch {}
  sh("npm", ["install", "--silent", "--omit=dev"], { cwd: ROOT });
  sh("npm", ["prune", "--silent", "--omit=dev"], { cwd: ROOT });
  sh("chmod", ["+x", join(ROOT, "cli", "brain.mjs")]);
  console.log(c.ok("✓ 客户端代码已更新"));
}

// 服务器的 /client.tgz 只含代码（core/client/mcp/cli + 精简 package.json，无 lark），不含 client.config.yaml/状态，
// 所以解压覆盖到 ROOT 不会动你的 token/配置/已上传记录。比重跑 curl|bash 干净：不重做 MCP/PATH 那些一次性步骤。
// restart=false：只落盘不重启（采集器自动更新走它——落盘后采集器自己退出，由 launchd/systemd 以新代码拉起，避开重启竞态）。
function update({ restart = true } = {}) {
  applyUpdate();
  if (restart) {
    // 重启常驻让 sync 用上新代码（没装常驻就提示怎么起）
    if (IS_MAC ? existsSync(PLIST) : existsSync(UNIT)) serviceRestart();
    else console.log(c.dim("（常驻未装：brain service install 起它）"));
  }
  console.log(c.ok("✓ brain update 完成") + c.dim("（编辑器里的 MCP 会在下次重开会话时用上新代码）"));
}

// ---------------- join（一键接入）：解码邀请码 → 校验 → 配置 → 接 MCP → 首同步 → 常驻 ----------------
async function joinCmd(code) {
  if (!code || !code.startsWith("BRAIN-")) die("用法：brain join <邀请码>（找管理员要）");
  let inv;
  try { inv = JSON.parse(Buffer.from(code.slice(6), "base64url").toString("utf8")); } catch { die("邀请码无效/损坏"); }
  const { srv, token, id, name } = inv;
  if (!srv || !token || !id) die("邀请码字段缺失");
  const consume = !!inv.consumer || process.argv.includes("--consume-only");

  // 1. 可达 + 鉴权（分清三种失败：连不上服务器 / token 无效 / 网络抖动 —— 别一律说成「邀请码过期」误导排查）
  // 任意 HTTP 响应都算「连得上」（含 /health 因真相库降级回的 503）—— 只有网络层抛错才是真不可达。
  const reach = await fetch(srv + "/health").then(() => true).catch(() => false);
  if (!reach) die(`连不上 ${srv}（服务器没起 / 网络 / 代理？先确认地址能在浏览器打开）`);
  let who = null, whoErr = "";
  try {
    const r = await fetch(srv + "/whoami", { headers: { authorization: `Bearer ${token}`, "x-client-version": CLIENT_VERSION } });
    if (r.ok) who = await r.json();
    else whoErr = (r.status === 401 || r.status === 403) ? "token 无效或已过期 → 找管理员重发邀请码" : `服务器返回 ${r.status}（服务端异常，找管理员看日志）`;
  } catch (e) { whoErr = `网络中断（${e.message}）—— 刚才还连得上，多半是抖动，稍后重跑 brain join`; }
  if (!who) die(`身份校验没过：${whoErr}`);
  console.log(c.ok(`✓ 服务器 ${srv} 可达，身份 ${who.name}（${who.id}）`));

  // 2. git 名软校验（作者归一；对不上不阻断）
  const gitName = sh("git", ["config", "user.name"]).stdout?.trim();
  if (gitName) console.log(c.dim(`→ 本机 git 名 "${gitName}"（大脑里作者显示不对就找管理员加进你的 git_names）`));

  // 3. upload_folders（纯消费者跳过）。没填任何工作空间 → 默认采集本机所有 session（collect_all）
  let folders = [], collectAll = false;
  if (!consume) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const sugg = detectFolders();
    if (sugg.length) console.log(c.dim(`检测到你常在这些仓干活：\n  ${sugg.join("\n  ")}`));
    const raw = (await rl.question(`要采集的工作空间（逗号分隔${sugg.length ? "，回车=全选上面" : "，留空=采集本机所有 session"}）: `)).trim();
    folders = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : sugg;
    if (!folders.length) {
      console.log(c.warn(`⚠️ 没指定工作空间 → 默认采集本机【所有项目】的 session：不止下面这些仓，这台机器上每个项目的 AI 对话原文都会上传，全队都能 grep 到。`));
      if (sugg.length) console.log(c.dim(`  例如 ${sugg.slice(0, 5).join("、")}${sugg.length > 5 ? " 等" : ""}，以及未列出的其它所有项目。`));
      console.log(c.dim(`  含密钥 / 客户数据 / 私人项目的，强烈建议改填具体工作空间（逗号分隔重跑），或用 --consume-only 只问不传。`));
      const ok = (await rl.question(`确认采集本机【全部】 session？(回车/y=全采，n=取消重选): `)).trim().toLowerCase();
      rl.close();
      if (ok === "n") die("已取消，重跑 brain join 指定工作空间");
      collectAll = true;
    } else {
      console.log(c.warn(`⚠️ 放进去 = 队友能看到这些文件夹 session 的原文。含密钥/客户数据的别放。`));
      const ok = (await rl.question(`确认上面 ${folders.length} 个？(Y/n): `)).trim().toLowerCase();
      rl.close();
      if (ok === "n") die("已取消，重跑 brain join 再选");
    }
  }

  // 4. 写配置 → 接 MCP → 首次回填 → 装常驻
  writeConfig({ server: srv, token, id, name, folders, consumer: consume, collectAll });
  console.log(c.ok(`✓ 配置写好 ${CFG}`));
  const mcpAttached = addMcp();
  console.log(c.dim("→ 首次回填历史 session（跨境可能要几分钟，别关）。下面会滚动日志，结束有一句「本机足迹」小结…"));
  spawnSync(NODE, [join(ROOT, "client", "sync.mjs"), "--once"], { cwd: ROOT, stdio: "inherit" });
  serviceInstall({ soft: true });                       // 装常驻失败不致命：配置/MCP/回填都已成 —— 再起服务（sync 启动时已能读到完整 config）
  if (mcpAttached.length)
    console.log(c.ok(`\n✅ 接入成功。`) + ` 去 ${mcpAttached[0]} 问问：「X 做到哪了 / 这周谁在动」\n`);
  else
    console.log(c.ok(`\n✅ 客户端已接入（采集已开）。`) +
      c.warn(" 但还没接上编辑器，消费侧暂不可用：") + "装好 Claude Code 或 Codex 后跑 " + c.b("brain mcp") + "。\n");
}

// ---------------- admin（控制面，经 SSH 在服务器上加人/列人/撤人）----------------
function adminCmd(sub, rest) {
  const a = loadCfg().admin;
  if (!a?.ssh || !a?.dir) die("本机不是 admin（client.config.yaml 里没有 admin: {ssh, dir}）");
  let rargs;
  if (sub === "add") rargs = ["add", ...rest, "--server-url", loadCfg().server_url];
  else if (sub === "who" || sub === "list") rargs = ["list"];
  else if (sub === "rm" || sub === "remove") rargs = ["remove", ...rest];
  else if (sub === "org") rargs = ["org", ...rest];     // org add <name> | org rm <name> | org list
  else if (sub === "repo") rargs = ["repo", ...rest];   // repo add <owner/repo> | repo rm <owner/repo> | repo list
  else if (sub === "gitlab") rargs = ["gitlab", ...rest];  // gitlab instance|group|project add|rm|list …
  else if (sub === "gitea") rargs = ["gitea", ...rest];    // gitea instance|org|repo add|rm|list …
  else die("用法：brain admin add|who|rm|org|repo|gitlab|gitea …（org/repo/gitlab/gitea 管 registry 登记的团队空间）");
  const remote = `cd ${shq(a.dir)} && node server/admin.mjs ${rargs.map(shq).join(" ")}`;
  const r = spawnSync("ssh", [a.ssh, remote], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

// ---------------- service（常驻）----------------
function writePlist() {
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>${join(ROOT, "client", "sync.mjs")}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>\n`);
}
function writeUnit() {
  mkdirSync(dirname(UNIT), { recursive: true });
  writeFileSync(UNIT, `[Unit]
Description=Team Brain sync
After=network-online.target

[Service]
ExecStart=${NODE} ${join(ROOT, "client", "sync.mjs")}
WorkingDirectory=${ROOT}
Restart=always
RestartSec=5
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
\n`);
}
const gui = () => `gui/${process.getuid()}`;

// soft=true：失败不退出整个进程，只 return false（给 join 用——配置已就绪，常驻没装上不该让整条接入算失败）。
function serviceInstall({ soft = false } = {}) {
  const fail = (msg) => { if (soft) { console.log(c.warn(`⚠ 常驻没装上（${msg}）。配置已就绪，稍后单独跑 brain service install 重试即可。`)); return false; } die(msg); };
  if (!existsSync(CFG)) return fail("还没配置，先跑 brain setup");
  if (IS_MAC) {
    writePlist();
    if (NODE_WARN) console.log(c.warn(`⚠ ${NODE_WARN}`));
    // 只有已加载才 bootout（首装跳过）——bootout 是异步拆除，紧接 bootstrap 会撞 "5: I/O error"，首装本就不需要它。
    if (sh("launchctl", ["print", `${gui()}/${LABEL}`]).status === 0) { sh("launchctl", ["bootout", `${gui()}/${LABEL}`]); sleep(1); }
    let r;
    for (let i = 0; i < 4; i++) {
      r = sh("launchctl", ["bootstrap", gui(), PLIST]);
      if (r.status === 0) break;
      sleep(1);                                                  // 偶发 I/O error → 等一下重试
    }
    if (r.status !== 0) return fail(`launchctl bootstrap 失败：${(r.stderr || "").trim()}`);
    sh("launchctl", ["enable", `${gui()}/${LABEL}`]);
    sh("launchctl", ["kickstart", "-k", `${gui()}/${LABEL}`]);
    console.log(c.ok(`✓ 已装常驻（launchd ${LABEL}），开机自启。日志：${LOG}`));
  } else {
    writeUnit();
    if (NODE_WARN) console.log(c.warn(`⚠ ${NODE_WARN}`));
    sh("systemctl", ["--user", "daemon-reload"]);
    const r = sh("systemctl", ["--user", "enable", "--now", "team-brain-sync"]);
    if (r.status !== 0) return fail(`systemctl enable 失败：${(r.stderr || "").trim()}`);
    console.log(c.ok(`✓ 已装常驻（systemd --user team-brain-sync）。日志：${LOG}`));
    console.log(c.dim("想注销后仍跑：loginctl enable-linger $USER"));
  }
  return true;
}
function serviceUninstall() {
  if (IS_MAC) {
    sh("launchctl", ["bootout", `${gui()}/${LABEL}`]);
    if (existsSync(PLIST)) unlinkSync(PLIST);
  } else {
    sh("systemctl", ["--user", "disable", "--now", "team-brain-sync"]);
    if (existsSync(UNIT)) unlinkSync(UNIT);
    sh("systemctl", ["--user", "daemon-reload"]);
  }
  console.log(c.ok("✓ 已卸掉常驻"));
  console.log(c.dim("（配置和 MCP 还在；要彻底退出团队用 brain uninstall）"));
}

// ---------------- uninstall（完整卸载：退出团队该清的都清）----------------
function uninstall(purge) {
  serviceUninstall();                                   // 1. 停 + 删常驻

  // 2. 摘掉 Claude Code 里的 MCP 注册（否则留个指向已删路径的死 MCP，CC 启动会报错）
  if (has("claude")) {
    const r = sh("claude", ["mcp", "remove", "team-brain", "--scope", "user"]);
    console.log(r.status === 0 ? c.ok("✓ 已摘 Claude Code MCP（team-brain）")
      : c.dim(`（CC MCP 本就没有/已摘：${((r.stderr || r.stdout || "").trim().split("\n")[0]) || "ok"}）`));
  }

  // 3. 删本机产物（含 token 的配置 / 状态 / 日志 / 锁）
  const STATE = join(ROOT, ".brain-state.json");
  const LOCK = join(tmpdir(), `team-brain-sync-${createHash("sha1").update(ROOT).digest("hex").slice(0, 12)}.lock`); // 与 sync.mjs 同算法
  let n = 0;
  for (const f of [CFG, STATE, LOG, LOCK]) { try { if (existsSync(f)) { unlinkSync(f); n++; } } catch {} }
  console.log(c.ok(`✓ 已删本机产物 ${n} 个（含 token 的配置 / 状态 / 日志 / 锁）`));
  console.log(c.dim("Codex 用户记得手删 ~/.codex/config.toml 里的 [mcp_servers.team-brain] 段。"));

  // 4. --purge：再移除全局 brain 命令 + 提示删安装目录（不自删运行中的目录）
  if (purge) {
    sh("npm", ["rm", "-g", "team-brain"]);               // npm link 装的全局包
    const localBin = join(homedir(), ".local", "bin", "brain");
    try { if (existsSync(localBin)) unlinkSync(localBin); } catch {}
    console.log(c.ok("✓ 已移除全局 brain 命令（npm / 软链）"));
    console.log(c.warn(`最后一步手动删安装目录：rm -rf ${ROOT}`));
  } else {
    console.log(c.dim("（连 brain 命令和安装目录一起删：brain uninstall --purge）"));
  }
  console.log(c.ok("\n✓ 卸载完成。"));
}

function serviceRestart() {
  if (IS_MAC) {
    if (!existsSync(PLIST)) die("常驻没装，先 brain service install");
    sh("launchctl", ["kickstart", "-k", `${gui()}/${LABEL}`]);
  } else {
    sh("systemctl", ["--user", "restart", "team-brain-sync"]);
  }
  console.log(c.ok("✓ 已重启常驻"));
}
function serviceStop() {
  if (IS_MAC) sh("launchctl", ["bootout", `${gui()}/${LABEL}`]);
  else sh("systemctl", ["--user", "stop", "team-brain-sync"]);
  console.log(c.ok("✓ 已停（未卸，restart/install 可再起）"));
}

// ---------------- status / logs ----------------
function status() {
  console.log(c.b("团队大脑客户端\n"));
  console.log(`配置:    ${existsSync(CFG) ? c.ok(CFG) : c.warn("未配置（brain setup）")}`);
  if (existsSync(CFG)) {
    try { const m = readFileSync(CFG, "utf8").match(/server_url:\s*(.*)/); if (m) console.log(`服务器:  ${m[1].trim()}`); } catch {}
  }
  let running = false;
  if (IS_MAC) {
    // print 退出码先分清「没装/没加载」与「装了」：失败=没加载（别再被正则兜成误导的状态字）。
    const r = sh("launchctl", ["print", `${gui()}/${LABEL}`]);
    if (r.status !== 0) {
      console.log(`常驻:    ${c.warn("未装 / 未加载")}`);
    } else {
      const st = (r.stdout.match(/state = (\S+)/) || [, "unknown"])[1];
      const pid = (r.stdout.match(/pid = (\d+)/) || [, null])[1];
      running = st === "running";
      console.log(`常驻:    ${running ? c.ok(`running (pid ${pid})`) : c.warn(`已加载但没在跑（state=${st}）—— 看 brain logs 找原因`)}`);
    }
  } else {
    const a = sh("systemctl", ["--user", "is-active", "team-brain-sync"]).stdout.trim();
    running = a === "active";
    console.log(`常驻:    ${running ? c.ok(a) : c.warn(a || "未装 / 未加载")}`);
  }
  // 采集足迹（从结果账本）：让用户一眼看到「传了多少 / 跳过多少」，不必去 viewer
  try {
    const led = JSON.parse(readFileSync(join(ROOT, ".brain-ledger.json"), "utf8"));
    const ss = led.sessions || [];
    const up = ss.filter((s) => s.status === "uploaded").length;
    const sk = ss.filter((s) => s.status === "skipped").length;
    if (up || sk) console.log(`采集:    ${c.ok(`${up} 已传`)}${sk ? c.dim(` · ${sk} 跳过（brain viewer 看逐条原因）`) : ""}`);
  } catch {}
  if (existsSync(LOG)) {
    // 一次读，既取最近一条 tick，也扫尾巴有没有失败/报错 —— 别让「同步坏了」时 status 还显得一切正常
    const lines = readFileSync(LOG, "utf8").trimEnd().split("\n");
    const last = [...lines].reverse().find((l) => / tick /.test(l));
    if (last) {
      const ts = (last.match(/^(\S+)/) || [])[1] || "";
      const body = last.split(" tick ")[1] || last;
      console.log(`最近同步: ${c.dim((ts.slice(11, 19) + " " + body).trim())}`);
    }
    const fails = lines.slice(-300).filter((l) => /上传失败|tick 异常|出错|ERROR/.test(l)).length;
    if (fails) console.log(c.warn(`⚠ 最近日志里有 ${fails} 条失败/报错 —— brain logs -f 看详情`));
  }
  try { const vi = JSON.parse(readFileSync(join(ROOT, ".brain-viewer.json"), "utf8")); if (vi.url) console.log(`查看器:  ${c.ok(vi.url)} ${c.dim("(brain viewer 打开)")}`); } catch {}
  if (!running && existsSync(CFG)) console.log(c.dim("\n起常驻：brain service install"));
}

// ---------------- viewer（本机足迹查看器）----------------
// 常驻 sync 内嵌了一个 127.0.0.1 只读小服务（client/viewer.mjs），把地址写进 .brain-viewer.json。
// 这里读出来用浏览器打开。没在跑就提示先起常驻。
function viewer() {
  let info; try { info = JSON.parse(readFileSync(join(ROOT, ".brain-viewer.json"), "utf8")); } catch {}
  if (!info?.url) die("本机查看器还没起（需要常驻在跑）。先 brain service install（或 brain start），再 brain viewer。");
  console.log(c.ok("本机足迹查看器：") + " " + info.url + c.dim("  （仅本机可见）"));
  const opener = IS_MAC ? "open" : "xdg-open";
  if (has(opener)) sh(opener, [info.url]);
  else console.log(c.dim("（手动在浏览器打开上面的地址）"));
}
function logs(follow) {
  if (!existsSync(LOG)) die("还没有日志（没跑过 sync）");
  const args = follow ? ["-n", "40", "-f", LOG] : ["-n", "40", LOG];
  spawn("tail", args, { stdio: "inherit" }).on("exit", (x) => process.exit(x ?? 0));
}


// ---------------- 路由 ----------------
const [cmd, sub] = process.argv.slice(2);
const flag = (f) => process.argv.includes(f);
const HELP = `brain —— 团队大脑客户端
  brain join <邀请码> [--consume-only]   一键接入（管理员给你的码）
  brain quickstart            本地单机自助接入（免 VPS/HTTPS/邀请码；配合 npm run server）
  brain setup                 手动配置（token / 工作空间 / 接 MCP）
  brain mcp                   （重新）接 Claude Code + Codex 的 MCP
  brain update                从服务器拉最新客户端代码 + 重启常驻
  brain start [--once]        前台跑 sync
  brain service install       装后台常驻（开机自启）
  brain service uninstall     卸常驻
  brain service restart       重启常驻（改了代码/配置后）
  brain stop                  停常驻（不卸）
  brain uninstall [--purge]   完整卸载（停常驻+摘MCP+删token配置；--purge 连命令和安装目录）
  brain status                看状态
  brain viewer                打开本机足迹查看器（127.0.0.1，仅本机可见）
  brain version               看客户端版本
  brain logs [-f]             看日志
  brain admin add <id> --name <显示名> [--email][--git-name][--consumer]   （管理员）加人，吐邀请码
  brain admin who             （管理员）看花名册
  brain admin rm <id>         （管理员）撤销某人访问
  brain admin org add|rm|list <org> [--pat <PAT>]          （管理员）登记 GitHub org（一把 PAT 覆盖其全部 repo）
  brain admin repo add|rm|list <owner/repo> [--pat <PAT>]  （管理员）登记单个 GitHub repo（每仓一把 PAT）
  brain admin gitlab instance add <host> [--base-url <url>] [--token <t>]   （管理员）登记 GitLab 自建实例
  brain admin gitlab group|project add|rm|list <host> <名/owner/repo> [--token]  （管理员）登记 GitLab group/project
  brain admin gitea  instance add <host> [--base-url <url>] [--token <t>]   （管理员）登记 Gitea 自建实例
  brain admin gitea  org|repo add|rm|list <host> <名/owner/repo> [--token]      （管理员）登记 Gitea org/repo`;
try {
  switch (cmd) {
    case "join": await joinCmd(sub); break;
    case "quickstart": quickstart(); break;           // 本地单机自助接入（免 VPS/HTTPS/邀请码）
    case "admin": adminCmd(sub, process.argv.slice(4)); break;
    case "mcp": addMcp(); break;                      // 按需（重新）接 Claude + Codex 的 MCP
    case "update": update({ restart: !process.argv.includes("--no-restart") }); break; // 拉最新客户端代码 + 重启常驻（--no-restart：只落盘，给采集器自动更新用）
    case "setup": await setup(); break;
    case "start": start(flag("--once")); break;
    case "service":
      if (sub === "install") serviceInstall();
      else if (sub === "uninstall") serviceUninstall();
      else if (sub === "restart") serviceRestart();
      else if (sub === "stop") serviceStop();
      else die("用法：brain service install|uninstall|restart|stop");
      break;
    case "uninstall": uninstall(flag("--purge")); break;
    case "restart": serviceRestart(); break;
    case "stop": serviceStop(); break;
    case "status": case undefined: status(); break;
    case "viewer": viewer(); break;                   // 打开本机足迹查看器（常驻内嵌的 127.0.0.1 服务）
    case "logs": logs(flag("-f") || flag("--follow")); break;
    case "version": case "-v": case "--version": console.log(`brain ${CLIENT_VERSION}`); break;
    case "help": case "-h": case "--help": console.log(HELP); break;
    default: die(`未知命令 ${cmd}\n\n${HELP}`);
  }
} catch (e) { die(e.message || String(e)); }
