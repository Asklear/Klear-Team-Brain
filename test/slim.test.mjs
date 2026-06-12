import test from "node:test";
import assert from "node:assert/strict";
import { slimRaw } from "../core/slim.mjs";
import { parseSessionText } from "../core/parse.mjs";

const big = (n) => "x ".repeat(n);   // 含空格 → 不是 base64 大块，走字段截断

// ---------- Codex ----------
const codexRaw = [
  JSON.stringify({ type: "session_meta", payload: { cwd: "/w/repo", git: { branch: "etl/x", repository_url: "git@github.com:o/r.git" } } }),
  JSON.stringify({ type: "turn_context", payload: { cwd: "/w/repo", git: { branch: "etl/x" }, model: "gpt-5.3-codex", collaboration_mode: { settings: { developer_instructions: big(20000) } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "把 etl 跑通" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 2 } } } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"pnpm test"}' } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "START " + big(100000) + " 47 passed END" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "exec_command_end", call_id: "c1", output: big(100000) } }),
  JSON.stringify({ type: "response_item", payload: { type: "reasoning", content: [{ type: "reasoning_text", text: big(50000) }] } }),
  JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "已完成 etl 改造，结论 X" } }),
].join("\n");

test("codex: 丢 token_count / 去重 exec_command_end", () => {
  const slim = slimRaw(codexRaw);
  assert.doesNotMatch(slim, /token_count/, "token_count 整条丢");
  assert.doesNotMatch(slim, /exec_command_end/, "exec_command_end 去重丢");
});

test("codex: 截 tool 输出但留头尾，留 function_call", () => {
  const slim = slimRaw(codexRaw);
  const out = slim.split("\n").find((l) => l.includes("function_call_output"));
  assert.ok(out.length < 5000, "function_call_output 被截到头尾上限内");
  assert.match(out, /START/); assert.match(out, /END/); assert.match(out, /略 \d+KB/);
  assert.match(slim, /"name":"exec_command"/, "function_call(调了啥)保留");
});

test("codex: 截 reasoning / 剥 turn_context 重复指令 / 留消息 + git", () => {
  const slim = slimRaw(codexRaw);
  assert.doesNotMatch(slim, /developer_instructions/, "turn_context 重复指令剥掉");
  assert.match(slim, /"model":"gpt-5.3-codex"/, "turn_context 其余保留");
  const reason = slim.split("\n").find((l) => l.includes("reasoning"));
  assert.ok(reason.length < 5000, "reasoning 被截");
  // 消息与坐标完好 → parse 仍工作
  const s = parseSessionText(slim, "codex");
  assert.equal(s.branch, "etl/x");
  assert.match(s.intent, /把 etl 跑通/);
  assert.match(s.conclusion, /已完成/);
});

test("codex: 内联图片 base64 剥成占位", () => {
  const raw = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(300000) }] } });
  const slim = slimRaw(raw);
  assert.ok(slim.length < 2000);
  assert.match(slim, /image \d+KB omitted/);
});

// ---------- Claude Code ----------
const ccRaw = [
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "改个 bug" }] }, gitBranch: "main", cwd: "/w" }),
  JSON.stringify({ type: "file-history-snapshot", snapshot: big(50000) }),
  JSON.stringify({ type: "mode", mode: "default" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
    { type: "thinking", thinking: big(40000) },
    { type: "text", text: "我来改" },
    { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
  ] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "OUTSTART " + big(80000) + " OUTEND" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "改好了，47 passed" }] } }),
].join("\n");

test("cc: 丢 file-history-snapshot / mode", () => {
  const slim = slimRaw(ccRaw);
  assert.doesNotMatch(slim, /file-history-snapshot/);
  assert.doesNotMatch(slim, /"type":"mode"/);
});

test("cc: 截 thinking / tool_result，留 text 与 tool_use 名", () => {
  const slim = slimRaw(ccRaw);
  const tr = slim.split("\n").find((l) => l.includes("tool_result"));
  assert.ok(tr.length < 5000, "tool_result 截到上限内");
  assert.match(tr, /OUTSTART/); assert.match(tr, /OUTEND/);
  const asst = slim.split("\n").find((l) => l.includes("thinking"));
  assert.ok(asst.length < 6000, "thinking 被截");
  assert.match(slim, /"name":"Bash"/, "tool_use 名保留");
  assert.match(slim, /改好了，47 passed/, "agent 回答保留");
  assert.match(slim, /改个 bug/, "用户消息保留");
});

test("cc: 结构保留 → parse 仍工作", () => {
  const s = parseSessionText(slimRaw(ccRaw), "claude-code");
  assert.match(s.intent, /改个 bug/);
  assert.equal(s.branch, "main");
});
