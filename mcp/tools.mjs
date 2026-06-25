// 团队大脑 MCP 工具定义【唯一真相源】：8 个只读原语的 schema + 描述 + 结果格式化 + INSTRUCTIONS。
// 两个传输共用同一份，杜绝漂移（CLAUDE.md 反复警惕的事）：
//   · stdio（用户机器，mcp/server.mjs）注入 remoteExec —— 走 api() fetch 打后端 REST（含跨境重试）。
//   · HTTP（服务器进程内，server/mcphttp.mjs）注入 localExec —— 直接调 query.mjs，零自打 HTTP。
// exec.X(input) 返回与对应 REST 端点【同形】的结构化数据；格式化在这里统一做 → 两端输出逐字一致。
// 只依赖 zod（已在客户端精简依赖内），不碰任何 server-only 模块（lark/query 等），保证装机包能带上这份。
import { z } from "zod";

// 两个传输都用同一份 name/version → MCP 客户端看到的服务器身份一致。
export const SERVER_INFO = { name: "team-brain", version: "0.6.0" };

export const INSTRUCTIONS = `团队大脑（team-brain）：全队 Claude Code/Codex 的 session 汇成一个 git 真相库（每条 session 一份【脱敏全文对话】），再叠 GitHub/GitLab/Gitea 代码现状 + 人写文档镜像（飞书 wiki / Notion / Google Docs）。
回答「X 做到哪了 / 当初怎么定的 / 谁在搞 Y / 最近有啥进展」这类跨人跨项目的问题时，先用这些工具查证，再据实答（带依据）。

== 心智模型：把真相库当一个只读文件夹来逛 ==
结构：spaces/<space_key>/sessions/<branch>/<producer-id>-<session-id>.md（全文可读对话）+ 同名 .jsonl（原始结构）；
　　　feishu/·notion/·google/<库>/<标题>--<id>.md（人写文档镜像：飞书 wiki / Notion / Google Docs，战略/PRD/客户笔记等，单向同步、grep 可中）。
所有工具用统一坐标【真相库相对 path】串起来：grep/find/ls 给你 path，read 拿 path 深挖——就像在本地翻一个项目目录。

== 6 个只读原语 + 1 个出网 ==
· grep … 搜内容（正则全文，默认搜 .md 全文对话）。有具体词/标识符/要"或(融资|finance)"时首选，可按 space 收窄。
· find … 按文件名/路径找文件（*.jsonl、user2-*）。grep 搜内容、find 搜文件名，互补。
· read … 按 path 读文件全文（深挖 session 选 .md；大文件用 offset/limit 翻页）。
· ls  … 摸结构：有哪些 space、某 space 有哪些分支/几条 session。
· sessions … 按【人 + 工作时间】检索 session（author 给 user1/username1 等价；since/until 是真实干活时间）。问「某人某段时间干了什么」首选这个。
· stats … 全队【聚合统计】：按 day/person/space/tool 维度汇总 token 用量 / session 数 / 对话轮次（按工作时间）。问「每天每人多少 token / 哪个项目活跃 / 谁用得多」用它。
· log … 全队【入库】时间线（git 历史，时间=commit 时间≠干活时间）——「最近真相库收进了啥/谁在持续提交」用它。
· read_github … 出网看代码现状 / 现拉文件（代码本体不入库、grep 搜不到）。

== 两种时间，别搞混（这是「按人按时间」最容易漏检的坑）==
· 工作时间 = session 真实干活时间（首条消息~末次输入）→ 只有 sessions 按它过滤排序。
· 入库时间 = 真相库 commit 时间（log 的时间列、log 的 since）→ 批量回填会让一批旧 session 全压在同一刻，按它查"上周"会漏掉真正上周干的、混进上周才入库的旧活。
· 问"某人上周/某段时间做了什么" → 一律用 sessions(author=…, since=…, until=…)，别用 log+since。

== 三种料源（合着用才答得全）==
· session(.md) = 进展前沿：最新、含思考过程、可能还没 push →（grep/find 找，read 深挖）
· GitHub/GitLab/Gitea = 代码现状：分支/PR·MR/commit →（read_github）。看具体文件得 read_github 给路径现拉。
· 人写文档镜像(feishu/·notion/·google/) = 目标·决策（战略/PRD/笔记，来自飞书 wiki / Notion / Google Docs）：grep 全文可中、read 读全文；正本在源平台（frontmatter 带 url），要改/评论引导去源平台。

== 套路：先低成本定位，再深挖 1-2 条 ==
· "X 做到哪了 / 怎么定的" → grep 定位 → read 看细节 →（涉代码再 read_github）
· "谁在搞 Y"             → grep 看命中里的人，或 sessions(author=) → read
· "某人某段时间做了什么"  → sessions(author=…, since=…, until=…)（按工作时间，别用 log）→ read 深挖
· "最近真相库收进了啥"    → log（入库时间线，可加 since/space）→ read 深挖
· "项目里有什么 / 哪些分支 / 哪条 session" → ls 摸结构，或 find 按名找
· "目标是什么 / 文档里怎么写的"          → grep 定位（命中 feishu/·notion/·google/ 的就是人写文档）→ read；ls feishu|notion|google 看有哪些库/文档

== space 模型 ==
团队登记的代码仓（跨人合并）：github__owner__repo / gitlab__host__owner__repo / gitea__host__owner__repo（gitlab/gitea 带 host 区分自建实例）；
local__<人> = 某人本地草稿桶，frontmatter 带 📂folder 标签区分本地项目。

== 答题纪律 ==
给依据（哪条 session / 谁 / 何时 / 哪个 space，最好附 path）；搜不到先【换关键词或换工具(grep↔find↔log)再试一两轮】，真没有才说没查到，别编。`;

// 大数压缩：1234→1.2k、3450000→3.5M（统计读数用，原值看 web/接口）
const hn = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
};
const METRIC_LABEL = { tokens: "tokens", tokens_io: "in+out", tokens_in: "in", tokens_out: "out", cache: "cache", sessions: "session", turns: "轮次" };
function renderStats(r) {
  const rows = r.rows || [];
  if (!rows.length) return "（无数据：该窗口内没有匹配的 session）";
  const m = r.metric || "tokens";
  const mv = (a) => m === "sessions" ? a.sessions : m === "turns" ? a.turns
    : m === "cache" ? (a.tokens_cache_r + a.tokens_cache_w)
    : m === "tokens_io" ? (a.tokens_in + a.tokens_out) : a[m] ?? a.tokens_total;
  const head = `by=${r.by}${r.split ? ` ×${r.split}` : ""}  metric=${m}  ` +
    `窗口=${r.since || "起"}~${r.until || "今"}  ` +
    `（共 ${r.coverage?.sessions ?? 0} session，其中 ${r.coverage?.with_usage ?? 0} 条有 token 数据）`;
  const fmtAgg = (a) => `${hn(mv(a))} ${METRIC_LABEL[m] || m}` +
    `  ·  ${hn(a.tokens_total)} tok (in ${hn(a.tokens_in)}/out ${hn(a.tokens_out)}/cache ${hn(a.tokens_cache_r + a.tokens_cache_w)})  ${a.sessions} session  ${a.turns} 轮`;
  const lines = rows.map((row) => {
    let s = `${row.key.padEnd(22)} ${fmtAgg(row)}`;
    if (Array.isArray(row.cells)) {
      s += "\n" + row.cells.map((c) => `    ${c.key.padEnd(18)} ${hn(mv(c))} ${METRIC_LABEL[m] || m}  (${hn(c.tokens_total)} tok, ${c.sessions} session)`).join("\n");
    }
    return s;
  });
  const T = r.totals || {};
  const total = `合计  ${hn(T.tokens_total)} tok (in ${hn(T.tokens_in)}/out ${hn(T.tokens_out)}/cache ${hn((T.tokens_cache_r || 0) + (T.tokens_cache_w || 0))})  ${T.sessions || 0} session  ${T.turns || 0} 轮`;
  const off = r.offset || 0, shown = rows.length, tot = r.total ?? shown;
  const pageline = tot > shown || off > 0
    ? `\n第 ${off + 1}-${off + shown} 组 / 共 ${tot}` + (r.truncated ? `（下一页：offset=${off + shown}）` : "（末页）")
    : "";
  return `${head}\n${"─".repeat(40)}\n${lines.join("\n")}\n${"─".repeat(40)}\n${total}${pageline}`;
}

// 注册全部 8 个工具到一个 McpServer。exec 是注入的执行器（remoteExec / localExec），
// 它的每个方法返回与 REST 同形的结构化数据；这里只负责 schema + 把数据格式化成 MCP text。
export function registerTools(server, exec) {
  server.registerTool(
    "grep",
    {
      title: "正则全文搜（精确定位首选）",
      description:
        "用 git grep 在真相库做正则全文搜（带上下文行）：支持【或 融资|finance】、标识符、代码符号、词边界。" +
        "默认搜全部 .md——session 全文对话 + feishu/·notion/·google/ 人写文档镜像（飞书/Notion/Google Docs：战略/PRD/笔记）都在内；raw=true 才连 .jsonl 原始结构一起搜（更全更吵）。可按 space 收窄。" +
        "返回 path:line: 形式——把 path 抄给 read 即可深挖。有具体词就先用它定位，是第一选择。",
      inputSchema: {
        q: z.string().describe("正则/关键词；善用『或』a|b 一次搜多个同义词、用词边界提精度，如 ontology、融资|finance"),
        space: z.string().optional().describe("收窄到某 space_key（如 github__owner__repo）；会【自动并入】该项目加 GitHub 前的旧 local 空间"),
        context: z.number().int().min(0).max(3).optional().describe("上下文行数，默认 1"),
        raw: z.boolean().optional().describe("true=连 .jsonl 原始结构一起搜，默认只搜 .md 全文对话"),
      },
    },
    async ({ q, space, context, raw }) => {
      const r = await exec.grep({ q, space, context, raw });
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
        "name 支持 * ?（如 *.jsonl、user2-*、*.md）；path 限定某 space/子目录。返回相对 path 列表，可直接喂给 read。",
      inputSchema: {
        name: z.string().optional().describe("文件名 glob，如 *.jsonl、user2-*、*.md；默认 *（不含路径分隔，子目录用 path 参数）"),
        path: z.string().optional().describe("限定子目录前缀，如 spaces/github__owner__repo"),
        limit: z.number().int().min(1).max(1000).optional().describe("条数上限，默认 200"),
      },
    },
    async ({ name, path, limit }) => {
      const r = await exec.find({ name, path, limit });
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
      const r = await exec.read({ path, offset, limit });
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
        "给 path（如 spaces/<key>/sessions）→ 往里看；path=feishu|notion|google → 看有哪些人写文档库/文档（飞书 wiki / Notion / Google Docs 镜像）。" +
        "目录附子项计数。不确定项目对应哪个 space 时，先 ls 再 grep/find 收窄。",
      inputSchema: {
        path: z.string().optional().describe("相对真相库根的路径；不给则列 spaces 顶层"),
      },
    },
    async ({ path }) => {
      const r = await exec.ls({ path: path || "spaces" });   // 工具语义：不给 path → 列 spaces 顶层（默认只在此一处）
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
        "注：author 这里匹配 git 提交者名（如 username1），与 producer-id（user1）可能不同 → 按人查优先用 sessions。",
      inputSchema: {
        space: z.string().optional().describe("收窄到某 space_key（别名/历史 key 也接受，自动归一）"),
        author: z.string().optional().describe("只看某 git 提交者（如 username1）；按 producer-id 查请用 sessions"),
        since: z.string().optional().describe("【入库时间】下限，如 '7 days ago'、'2026-06-01'"),
        grep: z.string().optional().describe("按 commit 信息过滤（commit 信息含 space/branch/文件名）"),
        limit: z.number().int().min(1).max(100).optional().describe("条数，默认 20"),
      },
    },
    async ({ space, author, since, grep, limit }) => {
      const { commits } = await exec.log({ space, author, since, grep, limit });
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
        "身份做了归一：author 给 producer-id 或 git 名（如 user1 与 username1）结果一致。" +
        "返回每条带 work（工作时间）+ ingest（入库时间）两个时间、canonical 坐标（path/space_key/branch/file 可直接喂 read）。" +
        "用法：sessions(author='user1', since='2026-06-01', until='2026-06-07') → 拿到 path 再 read 深挖。",
      inputSchema: {
        author: z.string().optional().describe("某人：producer-id 或 git 名均可（user1 / username1 等价）"),
        space: z.string().optional().describe("收窄到某 space_key（别名/历史 key 也接受）"),
        since: z.string().optional().describe("【工作时间】下限（含），如 '2026-06-01'"),
        until: z.string().optional().describe("【工作时间】上限（含），如 '2026-06-07'"),
        limit: z.number().int().min(1).max(200).optional().describe("条数，默认 50"),
      },
    },
    async ({ author, space, since, until, limit }) => {
      const r = await exec.sessions({ author, space, since, until, limit });
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
    "stats",
    {
      title: "全队聚合统计（token / session / 轮次）",
      description:
        "把全队 session 按维度汇总求和——答『大家每天用多少 token / 各项目多活跃 / 谁用得最多』这类量化问题。" +
        "维度 by ∈ day|week|person|space|tool，可【多选】逗号串组合（如 by='day,person' = 每天每人一行）；另给 split 还能再正交拆分。" +
        "指标 metric ∈ tokens(默认,=in+out+缓存) | tokens_io(不含缓存,=in+out,实际消耗) | tokens_in | tokens_out | cache | sessions | turns —— 决定排序/看哪个数。" +
        "⚠️ 时间走【工作时间】（session 真实干活时间），与 sessions 一致、与 log（入库时间）相反；可加 since/until/space/author/tool 收窄。" +
        "注：token 数据 CC 全有；Codex 仅客户端升级后的新 session 有（老的算不进，看返回的 coverage）。",
      inputSchema: {
        by: z.string().optional().describe("分组维度，默认 day；可多选逗号串组合，如 'day,person'（维度 ∈ day|week|person|space|tool）"),
        split: z.enum(["day", "week", "person", "space", "tool"]).optional().describe("二维拆分维度（可选），如 by=day split=person"),
        metric: z.enum(["tokens", "tokens_io", "tokens_in", "tokens_out", "cache", "sessions", "turns"]).optional().describe("指标，默认 tokens（含缓存）；tokens_io=不含缓存"),
        since: z.string().optional().describe("【工作时间】下限（含），如 '2026-06-01'"),
        until: z.string().optional().describe("【工作时间】上限（含），如 '2026-06-07'"),
        space: z.string().optional().describe("收窄到某 space_key（别名/历史 key 也接受）"),
        author: z.string().optional().describe("收窄到某人（producer-id 或 git 名，user1/username1 等价）"),
        tool: z.string().optional().describe("收窄到某工具（claude-code / codex）"),
        limit: z.number().int().min(1).max(1000).optional().describe("每页组数上限，默认 200"),
        offset: z.number().int().min(0).optional().describe("翻页偏移（跳过前 N 组）；day/week 是新→旧倒序，配 limit 翻页"),
      },
    },
    async ({ by, split, metric, since, until, space, author, tool, limit, offset }) => {
      const r = await exec.stats({ by, split, metric, since, until, space, author, tool, limit, offset });
      return { content: [{ type: "text", text: renderStats(r) }] };
    }
  );

  server.registerTool(
    "read_github",
    {
      title: "看代码现状 / 现拉文件",
      description:
        "对某团队仓 space（github/gitlab/gitea）看代码进展：不给 path → code-state（活跃分支 / 最新 commit / PR·MR + 哪些分支有未推进度）；" +
        "给 path → 当场从对应托管平台拉该文件最新内容。答「X 做到哪了」时和 session 合用：session=进展前沿（最新、可能还没 push），托管平台=固化副本。" +
        "⚠️ 真相库不存代码本体、也不能浏览目录：查代码实体只能给【具体文件路径】现拉单文件（路径从 session 讨论或已知结构推断），grep 搜不到代码。" +
        "注：若 code-state 显示『⚠️ 暂时读不到这个仓』，是服务器对该仓的 token 无权限（需管理员处理），不是没进展——这时以 session 为准。",
      inputSchema: {
        space_key: z.string().describe("团队仓 space_key（github__owner__repo / gitlab__host__owner__repo / gitea__host__owner__repo，从 ls / 命中结果拿）"),
        path: z.string().optional().describe("文件路径；不给则返回分支/PR 概览"),
        ref: z.string().optional().describe("分支名，默认仓库默认分支"),
      },
    },
    async ({ space_key, path, ref }) => {
      const r = await exec.github({ space_key, path, ref });
      const text = r.content != null ? r.content : (r.code_state || JSON.stringify(r));
      return { content: [{ type: "text", text }] };
    }
  );
}
