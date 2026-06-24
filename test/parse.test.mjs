import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionText, localDay } from "../core/parse.mjs";
import { projectSession } from "../core/project.mjs";

// Codex rollout 头部 session_meta.payload.git 记了 session 时刻的真实 branch/repository_url。
// 解析必须从这里取，而不是靠上传时现取（现取会把分支错标成上传那刻的当前分支）。
const codexWithGit = [
  JSON.stringify({
    timestamp: "2026-05-17T09:34:51.000Z", type: "session_meta",
    payload: {
      id: "019e3549", cwd: "/Users/gaorongvc/work/other/repo1",
      git: {
        commit_hash: "deadbeef",
        branch: "etl/node-first-on-spec022",
        repository_url: "git@github.com:olduser1/repo1.git",
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-05-17T09:35:00.000Z", type: "event_msg",
    payload: { type: "user_message", message: "把 node-first 的 etl 跑通" },
  }),
  JSON.stringify({
    timestamp: "2026-05-17T09:40:00.000Z", type: "event_msg",
    payload: { type: "agent_message", message: "已完成 etl 改造" },
  }),
].join("\n");

test("codex: 从 session_meta.git 抽真实 branch / repoUrl", () => {
  const s = parseSessionText(codexWithGit, "codex");
  assert.equal(s.branch, "etl/node-first-on-spec022");
  assert.equal(s.repoUrl, "git@github.com:olduser1/repo1.git");
  assert.equal(s.cwd, "/Users/gaorongvc/work/other/repo1");
  assert.equal(s.intent, "把 node-first 的 etl 跑通");
});

test("codex: git 记在 turn_context 里也能抽到", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w/repo" } }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/w/repo", git: { branch: "feat-x", repository_url: "git@github.com:o/r.git" } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
  ].join("\n");
  const s = parseSessionText(raw, "codex");
  assert.equal(s.branch, "feat-x");
  assert.equal(s.repoUrl, "git@github.com:o/r.git");
});

test("codex: 旧 rollout 无 git 块 → branch/repoUrl 兜底为 null", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w/repo" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
  ].join("\n");
  const s = parseSessionText(raw, "codex");
  assert.equal(s.branch, null);
  assert.equal(s.repoUrl, null);
});

// ---------- 按天明细 days[]（跨天 session 统计「哪天干的算哪天」）----------

test("CC: 跨天 session 逐条 assistant 按时间戳归天，token 精确分天（tokensDaily=full）", () => {
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-06-20T12:00:00Z", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T12:01:00Z", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-21T12:05:00Z", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 } } }),
  ].join("\n");
  const s = parseSessionText(raw, "claude-code");
  assert.equal(s.tokensDaily, "full");
  assert.deepEqual(s.days, [
    { date: "2026-06-20", turns: 1, in: 100, out: 10, cache_r: 0, cache_w: 5 },
    { date: "2026-06-21", turns: 1, in: 50, out: 20, cache_r: 300, cache_w: 0 },
  ]);
});

test("CC: 无 usage → days 只带 turns（区别真 0），tokensDaily=null", () => {
  const raw = JSON.stringify({ type: "assistant", timestamp: "2026-06-20T01:00:00Z", message: { content: [{ type: "text", text: "a" }] } });
  const s = parseSessionText(raw, "claude-code");
  assert.equal(s.tokensDaily, null);
  assert.deepEqual(s.days, [{ date: "2026-06-20", turns: 1 }]);
});

test("Codex: token 按天精确（每日末条累计快照作差 → tokensDaily=full）", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-20T02:00:00Z", payload: { cwd: "/w" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-20T02:05:00Z", payload: { type: "agent_message", message: "day1" } }),
    // 06-20 当日末条累计：in = 5000-1000 = 4000, out 100, cache_r 1000
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-20T02:06:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 100 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-21T09:00:00Z", payload: { type: "agent_message", message: "day2" } }),
    // 06-21 当日末条累计：in = 14670-3456 = 11214, out 280, cache_r 3456
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-21T09:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 14670, cached_input_tokens: 3456, output_tokens: 280 } } } }),
  ].join("\n");
  const s = parseSessionText(raw, "codex");
  assert.equal(s.tokensDaily, "full");
  assert.deepEqual(s.usage, { in: 11214, out: 280, cache_r: 3456, cache_w: 0 });   // session 总 = 末日累计
  assert.deepEqual(s.days, [
    { date: "2026-06-20", turns: 1, in: 4000, out: 100, cache_r: 1000, cache_w: 0 },   // 首日 = 当日累计
    { date: "2026-06-21", turns: 1, in: 7214, out: 180, cache_r: 2456, cache_w: 0 },   // 次日 = 累计作差
  ]);
});

test("Codex: agent_message 文本为空也按天计 turns（dayMap 选 agDays 非 agentTail）", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-20T02:00:00Z", payload: { cwd: "/w" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-20T02:05:00Z", payload: { type: "agent_message", message: "" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-21T09:00:00Z", payload: { type: "agent_message", message: "" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-21T09:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 5 } } } }),
  ].join("\n");
  const s = parseSessionText(raw, "codex");
  assert.equal(s.turns, 2);                                  // 两条 agent_message 都计 turns
  assert.equal(s.days.reduce((n, d) => n + d.turns, 0), 2);  // days 里 turns 之和 == 顶层 turns（不丢天）
  assert.deepEqual(s.days.map((d) => d.date), ["2026-06-20", "2026-06-21"]);
});

test("CC: 同一 session 有用量的天精确、无用量的天判未知（不染成真 0）", () => {
  const raw = [
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T12:00:00Z", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-21T12:00:00Z", message: { content: [{ type: "text", text: "b" }] } }),  // 无 usage
  ].join("\n");
  const s = parseSessionText(raw, "claude-code");
  assert.deepEqual(s.days, [
    { date: "2026-06-20", turns: 1, in: 100, out: 50, cache_r: 0, cache_w: 0 },
    { date: "2026-06-21", turns: 1 },                        // 该天用量未知 → 只带 turns，而非 in:0/out:0
  ]);
});

test("localDay: 带时区 UTC 串按北京日偏移；本地/纯日期串原样取日期、不误偏", () => {
  assert.equal(localDay("2026-06-20T17:00:00Z"), "2026-06-21");      // UTC+8 跨午夜 → 次日
  assert.equal(localDay("2026-06-20T10:00:00+00:00"), "2026-06-20"); // 显式 +00:00 也偏移
  assert.equal(localDay("2026-06-23 10:53:22"), "2026-06-23");       // Trae 本地格式（无时区）→ 不偏移
  assert.equal(localDay("2026-06-23"), "2026-06-23");                // 纯日期
  assert.equal(localDay(null), null);
});

test("CC: 按天分桶走北京日（UTC+8）— 跨 UTC 午夜但同北京日不拆", () => {
  const raw = [
    // 两条都在 UTC 6-20 晚，但北京时间已是 6-21 凌晨 → 应同归 6-21（不按 UTC 日劈成两天）
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T17:00:00Z", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T18:00:00Z", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join("\n");
  const s = parseSessionText(raw, "claude-code");
  assert.deepEqual(s.days.map((d) => d.date), ["2026-06-21"]);   // 北京日 6-21，单桶
  assert.equal(s.days[0].turns, 2);
});

test("session-history-md: 从 JSONL 包装中解析 md 元数据和正文", () => {
  const raw = [
    JSON.stringify({
      type: "session_history_meta",
      timestamp: "2026-06-13T10:00:00.000Z",
      updated: "2026-06-13T10:02:00.000Z",
      cwd: "/work/repo1",
      branch: "main",
      filename: "daily.md",
    }),
    JSON.stringify({
      type: "session_history_markdown",
      timestamp: "2026-06-13T10:02:00.000Z",
      content: "# 今天进展\n\n完成 session_history 接入。\n\n后续补测试。",
    }),
  ].join("\n");
  const s = parseSessionText(raw, "session-history-md");
  assert.equal(s.cwd, "/work/repo1");
  assert.equal(s.branch, "main");
  assert.equal(s.intent, "今天进展");
  assert.equal(s.updated, "2026-06-13T10:02:00.000Z");
  assert.match(s.conclusion, /完成 session_history 接入/);
  assert.match(projectSession(raw, "session-history-md"), /# 今天进展/);
  assert.match(projectSession(raw, "session-history-md"), /后续补测试/);
});

test("trae-session-memory: 解析 Trae 原生 session_memory JSONL", () => {
  const raw = [
    JSON.stringify({
      intent: "部署 uhub 并修复问题",
      actions: ["修复 JSON 解析", "验证 MCP 服务"],
      outcome: "CLI 和 MCP 均验证通过",
      learned: ["Kimi 输出 JSON 不稳定"],
      message_summary_time: "2026-06-23 10:53:22",
    }),
    JSON.stringify({
      intent: "评估跑批成本",
      actions: ["统计记录数", "估算 token"],
      outcome: "全量跑批成本可接受",
      message_summary_time: "2026-06-23 11:43:17",
    }),
  ].join("\n");
  const s = parseSessionText(raw, "trae-session-memory");
  assert.equal(s.intent, "部署 uhub 并修复问题");
  assert.equal(s.ts, "2026-06-23 10:53:22");
  assert.equal(s.updated, "2026-06-23 11:43:17");
  assert.equal(s.turns, 2);
  assert.match(s.conclusion, /全量跑批成本可接受/);
  assert.match(projectSession(raw, "trae-session-memory"), /Kimi 输出 JSON 不稳定/);
});
