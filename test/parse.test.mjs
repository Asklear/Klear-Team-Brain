import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionText } from "../core/parse.mjs";

// Codex rollout 头部 session_meta.payload.git 记了 session 时刻的真实 branch/repository_url。
// 解析必须从这里取，而不是靠上传时现取（现取会把分支错标成上传那刻的当前分支）。
const codexWithGit = [
  JSON.stringify({
    timestamp: "2026-05-17T09:34:51.000Z", type: "session_meta",
    payload: {
      id: "019e3549", cwd: "/Users/gaorongvc/work/other/bossa",
      git: {
        commit_hash: "deadbeef",
        branch: "etl/node-first-on-spec022",
        repository_url: "git@github.com:coldestlin/bossa.git",
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
  assert.equal(s.repoUrl, "git@github.com:coldestlin/bossa.git");
  assert.equal(s.cwd, "/Users/gaorongvc/work/other/bossa");
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
