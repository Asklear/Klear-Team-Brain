// 解析一条 session（jsonl）→ 抽 意图/结论/坐标。支持 Claude Code 与 Codex 两种格式。
// 不调 LLM：意图 = 第一句人类开场；结论 = 最后两段 assistant 文本。深挖靠原文。
import { readFileSync } from "node:fs";

// 从一条 entry 取 user/assistant 的纯文本
export function textOf(o) {
  const c = o?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

// token 用量统计：CC 逐条 assistant.message.usage 累加；Codex 取 token_count 的累计值（total_token_usage）。
// 口径统一成四元组（与卡片 frontmatter tokens_* 一一对应），tokens_total = in+out+cache_r+cache_w：
//   in = 新输入(非缓存) · out = 输出 · cache_r = 缓存命中读 · cache_w = 缓存写入(CC 才有，Codex 记 0)。
const emptyUsage = () => ({ in: 0, out: 0, cache_r: 0, cache_w: 0 });

// 按天累计（统计「哪天干的算哪天」用）：date('YYYY-MM-DD') → {turns, in, out, cache_r, cache_w}。
// 跨天 session 据此被各天各分各的，而不是整条压到开始日。
// 真相库「按天分桶」的时区：固定 UTC+8（北京日）。跨午夜按北京日归属、不按 UTC 日 —— 与「哪天干的算哪天」
// 的直觉一致（国内单一时区）。口径集中在此一处：parse 归天 与 query 分桶/since-until 共用，改时区只动这里。
export const DAY_TZ_OFFSET_MIN = 8 * 60;
// UTC ISO 时间戳 → 北京日历日 'YYYY-MM-DD'（null/空 → null）。
// 仅对【带时区】的串（结尾 Z 或 ±hh:mm，如 CC/Codex 的 UTC 时间）做 +8 偏移；其它格式
// （如 Trae 的本地 "YYYY-MM-DD HH:MM:SS"、纯日期）原样取前 10，避免被当本地时再偏移而误归日。
export function localDay(ts) {
  if (!ts) return null;
  const s = String(ts);
  if (/\dZ$/.test(s) || /[+-]\d\d:?\d\d$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t + DAY_TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}
const dayKey = localDay;
function dayBucket(map, day) {
  if (!day) return null;
  let d = map.get(day);
  if (!d) map.set(day, d = { turns: 0, in: 0, out: 0, cache_r: 0, cache_w: 0, hasU: false });
  return d;
}
// map → 按日期升序的数组。hasU 逐天判：该天有用量 → 6 字段；无 → 只留 {date,turns}（用量未知，区别于真 0）。
// 逐天而非整条判，避免「同一 session 里有用量的天把无用量的天也染成真 0」。
function daysOf(map) {
  if (!map.size) return null;
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, v]) => (v.hasU
      ? { date, turns: v.turns, in: v.in, out: v.out, cache_r: v.cache_r, cache_w: v.cache_w }
      : { date, turns: v.turns }));
}

// 嗅探格式：Codex 头一行是 session_meta；否则按 Claude Code。
export function detectTool(content) {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }  // 坏行跳过，别一行坏就误判
    return o.type === "session_meta" ? "codex" : "claude-code";
  }
  return "claude-code";
}

export function parseSession(file) {
  return parseSessionText(readFileSync(file, "utf8"));
}

// 直接吃 jsonl 文本（服务器收到上传的 raw 就用这个）；按 tool 分派，未给则自动嗅探。
export function parseSessionText(content, tool) {
  if (tool === "session-history-md") return parseSessionHistoryMdText(content);
  if (tool === "trae-session-memory") return parseTraeSessionMemoryText(content);
  if ((tool || detectTool(content)) === "codex") return parseCodexText(content);
  return parseClaudeText(content);
}

function parseClaudeText(content) {
  let intent = null, branch = null, cwd = null, ts = null, updated = null, turns = 0;
  const tail = [];
  const usage = emptyUsage(); let sawUsage = false;     // CC：每条 assistant 消息一份 usage，累加得 session 总量
  const dayMap = new Map();                             // 逐条 assistant 按其时间戳归天（turns + token）
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // 半截行/坏行跳过
    // 取第一个非空值（gitBranch 常是 ""，别被它锁死）
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!branch && o.gitBranch) branch = o.gitBranch;
    ts ??= o.timestamp;                 // 首条 = 创建时间
    if (o.timestamp) updated = o.timestamp;   // 末条 = 最后活跃时间（长 session 续写后比 ts 新很多）
    if (o.type === "assistant") {
      turns++; const t = textOf(o); if (t) tail.push(t);
      const d = dayBucket(dayMap, dayKey(o.timestamp) || dayKey(ts));   // 这条算到它发生的那天
      if (d) d.turns++;
      const u = o.message?.usage;
      if (u) {
        sawUsage = true;
        usage.in += u.input_tokens || 0;
        usage.out += u.output_tokens || 0;
        usage.cache_w += u.cache_creation_input_tokens || 0;
        usage.cache_r += u.cache_read_input_tokens || 0;
        if (d) {
          d.hasU = true;          // 这天确有用量数据（区别于无 usage 的真 0）
          d.in += u.input_tokens || 0;
          d.out += u.output_tokens || 0;
          d.cache_w += u.cache_creation_input_tokens || 0;
          d.cache_r += u.cache_read_input_tokens || 0;
        }
      }
    }
    if (o.type === "user" && intent === null) {
      const t = textOf(o);
      if (t && !t.startsWith("<")) intent = t.replace(/\s+/g, " ").trim().slice(0, 120);
    }
  }
  const conclusion = tail.slice(-2).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  // CC：每条 assistant 自带 usage → token 能精确摊到每天，tokensDaily="full"（无 usage 的天 days 里只带 turns）。
  return {
    intent, branch, cwd, ts, updated: updated || ts, turns, conclusion,
    usage: sawUsage ? usage : null, days: daysOf(dayMap), tokensDaily: sawUsage ? "full" : null,
  };
}

// Codex rollout：取 response_item/message 的纯文本（input_text/output_text/text）
export function codexText(payload) {
  const c = payload?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((b) => ["input_text", "output_text", "text"].includes(b?.type))
      .map((b) => b.text).join("\n");
  }
  return "";
}

// 解析 Codex rollout。意图优先取干净的 event_msg/user_message，回退 response_item 的 user。
// cwd/ts/git 来自头部 session_meta（payload.git 记了 session 时刻的真实 branch/repository_url，
// 比上传时现取可靠 —— 现取会把分支错标成上传那刻的当前分支）；旧 rollout 没 git 块 → branch=null 兜底。
// guardian/auto-review 子代理会标 subagent=true，客户端据此跳过（非人类干活、是噪声）。
function parseCodexText(content) {
  let cwd = null, ts = null, updated = null, turns = 0, subagent = false;
  let branch = null, repoUrl = null;          // session 时刻真实分支 / origin remote（原文 payload.git）
  let evUser = null, riUser = null;          // 第一句人类开场：事件级 / 原始级
  const agentTail = [], riTail = [];          // 结论：agent_message / 回退 assistant
  let usage = null;                           // token 用量：session 累计（末条 token_count 的 total_token_usage 为准）
  const agDays = new Map(), riDays = new Map();   // 按天 turns：优先 agent_message，回退 response_item assistant
  const cumByDay = new Map();                  // 北京日 → 当日末条【累计】快照{in,out,cache_r}（slim 每日留末条）→ 相邻日作差得每日量
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    ts ??= o.timestamp;                       // 首条 = 创建时间
    if (o.timestamp) updated = o.timestamp;   // 末条 = 最后活跃时间
    const p = o.payload;
    if (o.type === "session_meta" || o.type === "turn_context") {
      // git 记在 session_meta；部分版本记在 turn_context → 两处同样取首个非空
      cwd ??= p?.cwd;
      branch ??= p?.git?.branch || null;          // session 时刻所在分支
      repoUrl ??= p?.git?.repository_url || null;  // session 时刻 origin remote
      if (o.type === "session_meta" && (p?.thread_source === "subagent" || p?.source?.subagent)) subagent = true;
    } else if (o.type === "event_msg") {
      if (p?.type === "user_message" && evUser === null) {
        const t = p.message;
        if (t && !t.startsWith("<")) evUser = t;
      } else if (p?.type === "agent_message") {
        turns++;
        const d = dayBucket(agDays, dayKey(o.timestamp) || dayKey(ts));
        if (d) d.turns++;
        if (p.message) agentTail.push(p.message);
      } else if (p?.type === "token_count") {
        // total_token_usage 是 session 累计；input_tokens 含 cached → 拆出新输入。Codex 无 cache 写入概念，cache_w=0。
        const tot = p.info?.total_token_usage || p.info?.last_token_usage || p.info;
        if (tot && (tot.input_tokens != null || tot.output_tokens != null)) {
          const cr = tot.cached_input_tokens || 0;
          const cum = { in: Math.max(0, (tot.input_tokens || 0) - cr), out: tot.output_tokens || 0, cache_r: cr };
          usage = { ...cum, cache_w: 0 };       // session 累计：末条覆盖为准
          const day = dayKey(o.timestamp) || dayKey(ts);
          if (day) cumByDay.set(day, cum);      // 当日末条累计快照（按天作差用）
        }
      }
    } else if (o.type === "response_item" && p?.type === "message") {
      const t = codexText(p);
      if (!t) continue;
      // 回退取人类开场时，跳过 Codex 注入的系统块：<environment_context>、# AGENTS.md 指令前言
      if (p.role === "user" && riUser === null && !t.startsWith("<") && !t.startsWith("# AGENTS.md")) riUser = t;
      else if (p.role === "assistant") {
        riTail.push(t);
        const d = dayBucket(riDays, dayKey(o.timestamp) || dayKey(ts));
        if (d) d.turns++;
      }
    }
  }
  const intent = (evUser || riUser || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const tail = agentTail.length ? agentTail : riTail;
  const conclusion = tail.slice(-2).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  // 按天 turns 走 agent_message（无则回退 assistant）。选哪个 Map 必须看 turns 实际累计在哪
  // （agDays.size），不能看结论文本数（agentTail）——agent_message 文本为空时 turns 仍计入 agDays，
  // 若按 agentTail 选会落到空的 riDays、令 turns 归错天。
  const dayMap = agDays.size ? agDays : riDays;
  // token 按天：相邻北京日的【累计快照】作差 = 当日消耗（slim 每日留末条快照 → 这里 cumByDay 有逐日累计）。
  // tokensDaily="full"（按天精确）；拿不到逐日快照的老数据（如无时间戳）→ 整条记开始日、标 "start"（近似）。
  let tokensDaily = null;
  if (cumByDay.size) {
    const sortedDays = [...cumByDay.keys()].sort();
    let prev = { in: 0, out: 0, cache_r: 0 };
    for (const day of sortedDays) {
      const cum = cumByDay.get(day);
      const d = dayBucket(dayMap, day);
      if (d) {
        d.hasU = true;
        d.in += Math.max(0, cum.in - prev.in);
        d.out += Math.max(0, cum.out - prev.out);
        d.cache_r += Math.max(0, cum.cache_r - prev.cache_r);
        // cache_w 恒 0（Codex 无缓存写）
      }
      prev = cum;
    }
    tokensDaily = "full";
  } else if (usage) {
    const d = dayBucket(dayMap, dayKey(ts));
    if (d) { d.hasU = true; d.in += usage.in; d.out += usage.out; d.cache_r += usage.cache_r; d.cache_w += usage.cache_w; }
    tokensDaily = "start";
  }
  return {
    intent, branch, repoUrl, cwd, ts, updated: updated || ts, turns: turns || riTail.length, conclusion, subagent, usage,
    days: daysOf(dayMap), tokensDaily,
  };
}

function parseSessionHistoryMdText(content) {
  let meta = {}, body = content;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session_history_meta") meta = o;
    if (o.type === "session_history_markdown") body = o.content || o.markdown || textOf(o);
  }
  const lines = String(body || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const heading = lines.find((s) => /^#{1,6}\s+\S/.test(s));
  const first = heading ? heading.replace(/^#{1,6}\s+/, "") : lines[0];
  const last = lines.slice(-12).join(" ");
  return {
    intent: first ? first.replace(/\s+/g, " ").slice(0, 120) : null,
    branch: meta.branch || null,
    cwd: meta.cwd || null,
    ts: meta.timestamp || null,
    updated: meta.updated || meta.timestamp || null,
    turns: lines.length ? 1 : 0,
    conclusion: last.replace(/\s+/g, " ").trim().slice(0, 1500),
  };
}

function parseTraeSessionMemoryText(content) {
  let first = null, last = null, turns = 0;
  const tail = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    turns++;
    first ??= o;
    last = o;
    const parts = [];
    if (o.outcome) parts.push(o.outcome);
    if (Array.isArray(o.actions) && o.actions.length) parts.push(`动作：${o.actions.join("；")}`);
    if (Array.isArray(o.learned) && o.learned.length) parts.push(`经验：${o.learned.join("；")}`);
    const s = parts.join(" ");
    if (s) tail.push(s);
  }
  const intent = String(first?.intent || first?.summary || first?.message || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const ts = first?.message_summary_time || first?.timestamp || first?.created_at || null;
  const updated = last?.message_summary_time || last?.timestamp || last?.updated_at || ts;
  const conclusion = tail.slice(-3).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  return { intent, branch: null, cwd: null, ts, updated, turns, conclusion };
}
