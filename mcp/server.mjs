#!/usr/bin/env node
// 问 Agent 内核：stdio MCP，后端指向团队大脑服务器。
// 理念：把线上真相库当一个【只读文件夹】暴露给本地 Agent，用 Unix 式原语自由探索——
// grep(搜内容) / find(找文件) / read(读全文) / ls(看结构) / log(看历史) + read_github(出网看代码)。
// 统一坐标 = 真相库相对 path：grep/find/ls 给 path，read 拿 path 深挖。零服务器 LLM。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { CLIENT_VERSION } from "../core/version.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = parse(readFileSync(join(ROOT, "client.config.yaml"), "utf8"));
const HDRS = { authorization: `Bearer ${cfg.token}`, "x-client-version": CLIENT_VERSION };

async function api(path, params) {
  const u = new URL(cfg.server_url + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: HDRS });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const INSTRUCTIONS = `团队大脑（team-brain）：全队 Claude Code/Codex 的 session 汇成一个 git 真相库（每条 session 一份【脱敏全文对话】），再叠 GitHub 代码现状 + 飞书文档镜像。
回答「X 做到哪了 / 当初怎么定的 / 谁在搞 Y / 最近有啥进展」这类跨人跨项目的问题时，先用这些工具查证，再据实答（带依据）。

== 心智模型：把真相库当一个只读文件夹来逛 ==
结构：spaces/<space_key>/sessions/<branch>/<producer-id>-<session-id>.md（全文可读对话）+ 同名 .jsonl（原始结构）；
　　　feishu/<知识库>/<标题>--<token>.md（飞书文档镜像：战略/PRD/客户笔记等人写文档，单向同步、grep 可中）。
所有工具用统一坐标【真相库相对 path】串起来：grep/find/ls 给你 path，read 拿 path 深挖——就像在本地翻一个项目目录。

== 6 个只读原语 + 1 个出网 ==
· grep … 搜内容（正则全文，默认搜 .md 全文对话）。有具体词/标识符/要"或(融资|finance)"时首选，可按 space 收窄。
· find … 按文件名/路径找文件（*.jsonl、hank-*）。grep 搜内容、find 搜文件名，互补。
· read … 按 path 读文件全文（深挖 session 选 .md；大文件用 offset/limit 翻页）。
· ls  … 摸结构：有哪些 space、某 space 有哪些分支/几条 session。
· sessions … 按【人 + 工作时间】检索 session（author 给 tqt/taoqitian 等价；since/until 是真实干活时间）。问「某人某段时间干了什么」首选这个。
· log … 全队【入库】时间线（git 历史，时间=commit 时间≠干活时间）——「最近真相库收进了啥/谁在持续提交」用它。
· read_github … 出网看代码现状 / 现拉文件（代码本体不入库、grep 搜不到）。

== 两种时间，别搞混（这是「按人按时间」最容易漏检的坑）==
· 工作时间 = session 真实干活时间（首条消息~末次输入）→ 只有 sessions 按它过滤排序。
· 入库时间 = 真相库 commit 时间（log 的时间列、log 的 since）→ 批量回填会让一批旧 session 全压在同一刻，按它查"上周"会漏掉真正上周干的、混进上周才入库的旧活。
· 问"某人上周/某段时间做了什么" → 一律用 sessions(author=…, since=…, until=…)，别用 log+since。

== 三种料源（合着用才答得全）==
· session(.md) = 进展前沿：最新、含思考过程、可能还没 push →（grep/find 找，read 深挖）
· GitHub = 代码现状：分支/PR/commit →（read_github）。看具体文件得 read_github 给路径现拉。
· 飞书文档镜像(feishu/) = 目标·决策（人写的战略/PRD/笔记）：grep 全文可中、read 读全文；正本在飞书（frontmatter 带 url），要改/评论引导去飞书。

== 套路：先低成本定位，再深挖 1-2 条 ==
· "X 做到哪了 / 怎么定的" → grep 定位 → read 看细节 →（涉代码再 read_github）
· "谁在搞 Y"             → grep 看命中里的人，或 sessions(author=) → read
· "某人某段时间做了什么"  → sessions(author=…, since=…, until=…)（按工作时间，别用 log）→ read 深挖
· "最近真相库收进了啥"    → log（入库时间线，可加 since/space）→ read 深挖
· "项目里有什么 / 哪些分支 / 哪条 session" → ls 摸结构，或 find 按名找
· "目标是什么 / 文档里怎么写的"          → grep 定位（命中 feishu/ 的就是人写文档）→ read；ls feishu 看有哪些知识库/文档

== space 模型 ==
github__owner__repo = 团队登记的 GitHub 仓（跨人合并）；local__<人> = 某人本地草稿桶，frontmatter 带 📂folder 标签区分本地项目。

== 答题纪律 ==
给依据（哪条 session / 谁 / 何时 / 哪个 space，最好附 path）；搜不到先【换关键词或换工具(grep↔find↔log)再试一两轮】，真没有才说没查到，别编。`;

const server = new McpServer({ name: "team-brain", version: "0.6.0" }, { instructions: INSTRUCTIONS });

server.registerTool(
  "grep",
  {
    title: "正则全文搜（精确定位首选）",
    description:
      "用 git grep 在真相库做正则全文搜（带上下文行）：支持【或 融资|finance】、标识符、代码符号、词边界。" +
      "默认搜全部 .md——session 全文对话 + feishu/ 飞书文档镜像（人写的战略/PRD/笔记）都在内；raw=true 才连 .jsonl 原始结构一起搜（更全更吵）。可按 space 收窄。" +
      "返回 path:line: 形式——把 path 抄给 read 即可深挖。有具体词就先用它定位，是第一选择。",
    inputSchema: {
      q: z.string().describe("正则/关键词；善用『或』a|b 一次搜多个同义词、用词边界提精度，如 ontology、融资|finance"),
      space: z.string().optional().describe("收窄到某 space_key（如 github__owner__repo）；会【自动并入】该项目加 GitHub 前的旧 local 空间"),
      context: z.number().int().min(0).max(3).optional().describe("上下文行数，默认 1"),
      raw: z.boolean().optional().describe("true=连 .jsonl 原始结构一起搜，默认只搜 .md 全文对话"),
    },
  },
  async ({ q, space, context, raw }) => {
    const r = await api("/grep", { q, space, context, raw: raw ? 1 : undefined });
    const text = (r.matches || "（无命中）") + (r.truncated ? "\n…（结果已截断，请缩小范围或加 space）" : "");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "find",
  {
    title: "按文件名/路径找文件",
    description:
      "在真相库里按文件名 glob 找文件（像 find / ls -R）：grep 搜内容、find 搜文件名，互补。" +
      "name 支持 * ?（如 *.jsonl、hank-*、*.md）；path 限定某 space/子目录。返回相对 path 列表，可直接喂给 read。",
    inputSchema: {
      name: z.string().optional().describe("文件名 glob，如 *.jsonl、hank-*、*.md；默认 *（不含路径分隔，子目录用 path 参数）"),
      path: z.string().optional().describe("限定子目录前缀，如 spaces/github__owner__repo"),
      limit: z.number().int().min(1).max(1000).optional().describe("条数上限，默认 200"),
    },
  },
  async ({ name, path, limit }) => {
    const r = await api("/find", { name, path, limit });
    const files = r.files || [];
    const text = files.length
      ? files.join("\n") + (r.truncated ? "\n…（已截断，缩小范围或加 path）" : "")
      : "（无匹配文件）";
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "read",
  {
    title: "按 path 读文件全文（深挖 session）",
    description:
      "读真相库里某个文件——把 grep / find / ls 命中的 path 直接抄进来，别手编。" +
      ".md = 这条 session 的【全文可读对话】（深挖首选）；.jsonl = 原始结构（一般不需要）。" +
      "大文件用 offset/limit 翻页，别一次硬读超长文件。",
    inputSchema: {
      path: z.string().describe("真相库相对 path，如 spaces/<key>/sessions/<branch>/<file>.md（从 grep/find/ls 结果抄）"),
      offset: z.number().int().min(0).optional().describe("起始行（0 基），翻页用；不给从头读"),
      limit: z.number().int().min(1).optional().describe("读多少行；不给则读到末尾"),
    },
  },
  async ({ path, offset, limit }) => {
    const r = await api("/read", { path, offset, limit });
    return { content: [{ type: "text", text: r.text || "（空）" }] };
  }
);

server.registerTool(
  "ls",
  {
    title: "摸真相库结构",
    description:
      "列结构，用于先搞清「有哪些 space / 这个项目对应哪个 space / 某 space 有哪些分支、几条 session」。" +
      "不给 path → 列所有 space（github__owner__repo 团队仓 / local__<人> 个人桶）；" +
      "给 path（如 spaces/<key>/sessions）→ 往里看；path=feishu → 看有哪些飞书知识库/文档（人写的战略/PRD/笔记镜像）。" +
      "目录附子项计数。不确定项目对应哪个 space 时，先 ls 再 grep/find 收窄。",
    inputSchema: {
      path: z.string().optional().describe("相对真相库根的路径；不给则列 spaces 顶层"),
    },
  },
  async ({ path }) => {
    const r = await api("/ls", { path: path || "spaces" });
    if (r.type === "file") return { content: [{ type: "text", text: `${r.path}（文件，${r.size} 字节）` }] };
    const text = (r.entries || []).map((e) => {
      if (e.type !== "dir") return `   ${e.name}`;
      const note = e.active === false ? "  ·仅登记(无session)" : "";   // org 预登记但没人动过的空 space
      return `📁 ${e.name}/  (${e.children ?? 0})${note}`;
    }).join("\n") || "（空）";
    return { content: [{ type: "text", text: `${r.path || "/"}:\n${text}` }] };
  }
);

server.registerTool(
  "log",
  {
    title: "全队入库时间线（git 历史）",
    description:
      "看真相库 git 历史 = 全队入库活动流（每条 session 入库一条 commit）。" +
      "⚠️ 这里的时间是【入库/commit 时间】，不是干活时间——批量回填会把一批旧 session 全压在同一入库时刻，" +
      "`since` 过滤的也是入库时间。问『某人某段时间【干了什么】』要用 `sessions`（按工作时间）；" +
      "log 适合『最近真相库【收进了什么】/ 谁在持续提交』。坐标已归一到现位置（owner 搬家也能直接 read）。可按 space / author / since / grep 收窄。" +
      "注：author 这里匹配 git 提交者名（如 taoqitian），与 producer-id（tqt）可能不同 → 按人查优先用 sessions。",
    inputSchema: {
      space: z.string().optional().describe("收窄到某 space_key（别名/历史 key 也接受，自动归一）"),
      author: z.string().optional().describe("只看某 git 提交者（如 taoqitian）；按 producer-id 查请用 sessions"),
      since: z.string().optional().describe("【入库时间】下限，如 '7 days ago'、'2026-06-01'"),
      grep: z.string().optional().describe("按 commit 信息过滤（commit 信息含 space/branch/文件名）"),
      limit: z.number().int().min(1).max(100).optional().describe("条数，默认 20"),
    },
  },
  async ({ space, author, since, grep, limit }) => {
    const { commits } = await api("/log", { space, author, since, grep, limit });
    const text = (commits || []).length
      ? commits.map((c) => `${c.sha}  ${(c.date || "").slice(0, 16)}  ${c.author}  ${c.subject}`).join("\n")
      : "（无活动）";
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "sessions",
  {
    title: "按【人 + 工作时间】检索 session（按人按时间首选）",
    description:
      "答『某人某段时间【干了什么】』的主原语。与 log 的根本区别：时间维度走每条 session 的【真实工作时间】" +
      "（卡片首条消息 work_start ~ 末次输入 work_end），不是入库/commit 时间 → 批量回填的旧 session 也按真实何时干活过滤排序。" +
      "身份做了归一：author 给 producer-id 或 git 名（如 tqt 与 taoqitian）结果一致。" +
      "返回每条带 work（工作时间）+ ingest（入库时间）两个时间、canonical 坐标（path/space_key/branch/file 可直接喂 read）。" +
      "用法：sessions(author='tqt', since='2026-06-01', until='2026-06-07') → 拿到 path 再 read 深挖。",
    inputSchema: {
      author: z.string().optional().describe("某人：producer-id 或 git 名均可（tqt / taoqitian 等价）"),
      space: z.string().optional().describe("收窄到某 space_key（别名/历史 key 也接受）"),
      since: z.string().optional().describe("【工作时间】下限（含），如 '2026-06-01'"),
      until: z.string().optional().describe("【工作时间】上限（含），如 '2026-06-07'"),
      limit: z.number().int().min(1).max(200).optional().describe("条数，默认 50"),
    },
  },
  async ({ author, space, since, until, limit }) => {
    const r = await api("/sessions", { author, space, since, until, limit });
    const rows = r.sessions || [];
    if (!rows.length) return { content: [{ type: "text", text: "（无匹配 session）" }] };
    const text = rows.map((s) =>
      `work ${(s.work_start || "").slice(0, 10)}~${(s.work_end || "").slice(0, 10)}  ` +
      `ingest ${(s.ingest_date || "").slice(0, 10)}  ${s.producer_id || s.author || "?"}  ${s.space_key}/${s.branch}\n` +
      `  ${s.path}\n  ${s.preview || ""}`
    ).join("\n") + (r.truncated ? `\n…（共 ${r.total} 条，已截断，缩小窗口或加 author/space）` : "");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "read_github",
  {
    title: "看代码现状 / 现拉文件",
    description:
      "对某 github space 看代码进展：不给 path → code-state（活跃分支 / 最新 commit / PR + 哪些分支有未推进度）；" +
      "给 path → 当场从 GitHub 拉该文件最新内容。答「X 做到哪了」时和 session 合用：session=进展前沿（最新、可能还没 push），github=固化副本。" +
      "⚠️ 真相库不存代码本体、也不能浏览目录：查代码实体只能给【具体文件路径】现拉单文件（路径从 session 讨论或已知结构推断），grep 搜不到代码。" +
      "注：若 code-state 显示『⚠️ 暂时读不到这个 GitHub 仓』，是服务器 GITHUB_TOKEN 对该仓无权限（需管理员处理），不是没进展——这时以 session 为准。",
    inputSchema: {
      space_key: z.string().describe("github__owner__repo（从 ls / 命中结果拿）"),
      path: z.string().optional().describe("文件路径；不给则返回分支/PR 概览"),
      ref: z.string().optional().describe("分支名，默认仓库默认分支"),
    },
  },
  async ({ space_key, path, ref }) => {
    const r = await api("/github", { space_key, path, ref });
    const text = r.content != null ? r.content : (r.code_state || JSON.stringify(r));
    return { content: [{ type: "text", text }] };
  }
);

await server.connect(new StdioServerTransport());
console.error("team-brain MCP (0.6) 已启动：grep + find + read + ls + sessions + log + read_github（含 feishu/ 文档镜像）→", cfg.server_url);
