#!/usr/bin/env node
// quickstart —— 本地单机自助接入：把「建服务端花名册 + 签 token + 写客户端配置」一次性搞定，
// 免 VPS / 免 HTTPS / 免邀请码。给两类用户用：
//   · 本地尝鲜（默认模式）：写 team.yaml + tokens.yaml + client.config.yaml(指 http://127.0.0.1:8787)，
//     之后 `npm run server`(一个终端) + `npm run sync`(另一个) 就能在编辑器里问。
//   · docker 容器自举（--server-bootstrap）：只写 team.yaml + tokens.yaml（落到 TEAM_FILE/TOKENS_FILE，
//     容器里 = 命名卷 /data/config），打印 token，供 entrypoint 在「直接 compose up」时把服务端弄成可用。
//
// 设计要点：不在服务端开鉴权后门 —— 本地「免邀请码」靠**自动签发一个真 token**，鉴权路径与生产同一条。
// 幂等：token 已存在就复用（重跑不换 token，免得客户端/服务端对不上）。
//
// 用法：
//   node scripts/quickstart.mjs [--server <url>] [--id <id>] [--name <名>]   # 默认：本地尝鲜
//   node scripts/quickstart.mjs --server-bootstrap                           # 仅花名册+token（容器用）

import { writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { loadRoster, loadTokens } from "../core/team.mjs";   // 读侧规范来源（与 server.mjs/admin.mjs 同一份）

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEAM = process.env.TEAM_FILE || join(ROOT, "team.yaml");        // 花名册（非机密、对齐 server.mjs 的 TEAM_FILE）
const TOKENS = process.env.TOKENS_FILE || join(ROOT, "tokens.yaml");  // token（机密、gitignore）
const CFG = join(ROOT, "client.config.yaml");                         // 客户端配置（含 token、gitignore）

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const n = argv[i + 1]; o[a.slice(2)] = (n && !n.startsWith("--")) ? argv[++i] : true; }
    else o._.push(a);
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

// 身份：--id / $USER 收敛成 ascii(字母数字-_)；name 取 --name / git user.name / id
const gitName = spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout?.trim() || "";
const rawId = String(args.id || process.env.USER || process.env.LOGNAME || "me");
const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "me";
const name = String(args.name || gitName || id);
const server = String(args.server || "http://127.0.0.1:8787").replace(/\/$/, "");

// 1) 花名册：缺该成员就加（已在就不动，保留别人）
const team = loadRoster(TEAM);                              // 缺/坏文件 → { members: [] }
team.members = team.members || [];
if (!team.members.some((m) => m.id === id)) {
  team.members.push({ id, name, email: "", git_names: gitName ? [gitName] : [] });
  writeFileSync(TEAM, `# 团队花名册 —— 谁能接入「项目大脑」+ 身份归一（token 在 tokens.yaml）。\n` + stringify(team));
  console.log(c.ok(`✓ 花名册 ${TEAM} 加入 ${name}（${id}）`));
} else {
  console.log(c.dim(`· 花名册已含 ${id}，跳过`));
}

// 2) token：已有就复用（幂等，别换），否则现签一个真 token
const tokens = loadTokens(TOKENS);                         // 缺/坏文件 → {}
let token = tokens[id];
if (!token) {
  token = randomBytes(24).toString("hex");
  tokens[id] = token;
  writeFileSync(TOKENS, `# 接入 token（机密，gitignore）。key=team.yaml 的成员 id。\n` + stringify(tokens));
  console.log(c.ok(`✓ 已签发 token → ${TOKENS}`));
} else {
  console.log(c.dim(`· ${id} 已有 token，复用`));
}

// --server-bootstrap：容器自举到此为止（只保证服务端可鉴权），打印 token 供宿主客户端指过来
if (args["server-bootstrap"]) {
  console.log(c.b(`\n服务端已可鉴权。把客户端指到本服务并用此 token：`));
  console.log(`  id:    ${id}`);
  console.log(`  token: ${token}`);
  console.log(c.dim(`（宿主机跑：npm run quickstart -- --server http://localhost:8787 —— 它会写好 client.config.yaml）`));
  process.exit(0);
}

// 3) 客户端配置：指向本地服务，默认全采、关自动更新（本地无上游可更新）
if (existsSync(CFG) && !args.force) {
  console.log(c.warn(`· ${CFG} 已存在，未覆盖（要重写加 --force）`));
} else {
  writeFileSync(CFG,
    `# 客户端配置（含 token、gitignore）。由 quickstart 生成，指向本地服务端。\n` +
    `server_url: ${server}\n` +
    `token: "${token}"\n` +
    // name 来自 git user.name，可能含 : / # 等会破 YAML 的字符 → JSON.stringify 加双引号转义（id 已 sani、token 是 hex，不用）
    `me:\n  id: ${id}\n  name: ${JSON.stringify(name)}\n\n` +
    `# 本地尝鲜：默认采集本机所有 session。要收窄就把 collect_all 删掉、改填 upload_folders。\n` +
    `collect_all: true\n` +
    `upload_folders: []\n` +
    `exclude: []\n\n` +
    `codex: true\n` +
    `session_history_md: true\n` +
    `trae_memory: true\n` +
    `auto_update: false      # 本地自托管：没有上游可自动更新，关掉\n` +
    `interval_sec: 60\n` +
    `debounce_sec: 60\n`);
  console.log(c.ok(`✓ 客户端配置 ${CFG} → ${server}`));
}

console.log(c.b(`\n下一步：`));
console.log(`  1) 起服务端：` + c.b(`npm run server`) + c.dim(`   （另开一个终端，跑在 ${server}）`));
console.log(`  2) 收一次本机 session：` + c.b(`npm run sync -- --once`));
console.log(`  3) 接编辑器 MCP：` + c.b(`node cli/brain.mjs mcp`) + c.dim(`（brain quickstart 已自动做）`));
console.log(c.dim(`  然后在 Claude Code / Codex 里问一句，或开 ${server}/ 浏览。\n`));
