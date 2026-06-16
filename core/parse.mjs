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
  if ((tool || detectTool(content)) === "codex") return parseCodexText(content);
  return parseClaudeText(content);
}

function parseClaudeText(content) {
  let intent = null, branch = null, cwd = null, ts = null, updated = null, turns = 0;
  const tail = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // 半截行/坏行跳过
    // 取第一个非空值（gitBranch 常是 ""，别被它锁死）
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!branch && o.gitBranch) branch = o.gitBranch;
    ts ??= o.timestamp;                 // 首条 = 创建时间
    if (o.timestamp) updated = o.timestamp;   // 末条 = 最后活跃时间（长 session 续写后比 ts 新很多）
    if (o.type === "assistant") { turns++; const t = textOf(o); if (t) tail.push(t); }
    if (o.type === "user" && intent === null) {
      const t = textOf(o);
      if (t && !t.startsWith("<")) intent = t.replace(/\s+/g, " ").trim().slice(0, 120);
    }
  }
  const conclusion = tail.slice(-2).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  return { intent, branch, cwd, ts, updated: updated || ts, turns, conclusion };
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
        if (p.message) agentTail.push(p.message);
      }
    } else if (o.type === "response_item" && p?.type === "message") {
      const t = codexText(p);
      if (!t) continue;
      // 回退取人类开场时，跳过 Codex 注入的系统块：<environment_context>、# AGENTS.md 指令前言
      if (p.role === "user" && riUser === null && !t.startsWith("<") && !t.startsWith("# AGENTS.md")) riUser = t;
      else if (p.role === "assistant") riTail.push(t);
    }
  }
  const intent = (evUser || riUser || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const tail = agentTail.length ? agentTail : riTail;
  const conclusion = tail.slice(-2).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  return { intent, branch, repoUrl, cwd, ts, updated: updated || ts, turns: turns || riTail.length, conclusion, subagent };
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
