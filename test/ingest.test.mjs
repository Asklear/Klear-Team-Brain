import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { ingest } from "../server/ingest.mjs";

const REG = { github: { orgs: [{ org: "olduser1" }], repos: [] } };
const SUBMITTER = { id: "user2", name: "username2" };
// 最小可解析的 Claude Code session：第一句人类开场 = intent
const RAW = JSON.stringify({ type: "user", message: { role: "user", content: "帮我加个功能" } }) + "\n" +
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的，做完了" }] } }) + "\n";

function freshTruth() {
  const dir = mkdtempSync(join(tmpdir(), "tb-ingest-"));
  initTruth(dir);
  return dir;
}
const cardOf = (truth, spaceKey) => {
  const sd = join(truth, "spaces", spaceKey, "sessions");
  const branch = readdirSync(sd)[0];
  const md = readdirSync(join(sd, branch)).find((f) => f.endsWith(".md"));
  return readFileSync(join(sd, branch, md), "utf8");
};

test("ingest: 已登记 github remote → 落 github space + space.yaml 新 schema", async () => {
  const truth = freshTruth();
  const r = await ingest(truth, {
    id: "s1", raw: RAW, tool: "claude-code", branch: "main",
    remote: { host: "github.com", owner: "olduser1", repo: "repo1" },
    folder: "ignored-for-github", producer: SUBMITTER,
  }, SUBMITTER, REG);
  assert.equal(r.space_key, "github__olduser1__repo1");
  const yaml = readFileSync(join(truth, "spaces", "github__olduser1__repo1", "space.yaml"), "utf8");
  assert.match(yaml, /type: github/);
  assert.match(yaml, /ref: github\/olduser1\/repo1/);
  assert.match(yaml, /via: org/);
  const card = cardOf(truth, "github__olduser1__repo1");
  assert.match(card, /space_key: github__olduser1__repo1/);
  assert.doesNotMatch(card, /^folder:/m);   // github session 不带 folder
  assert.match(card, /\*\*用户\*\*：\s*帮我加个功能/);   // 正文 = 全文 transcript（label 后换行，保 markdown 结构）
  assert.match(card, /\*\*助手\*\*：\s*好的，做完了/);
});

test("ingest: 未登记 remote → 落 local__<person> + folder 标签", async () => {
  const truth = freshTruth();
  const r = await ingest(truth, {
    id: "s2", raw: RAW, tool: "claude-code", branch: "main",
    remote: { host: "github.com", owner: "random", repo: "x" },
    folder: "repo1-test/cao", producer: SUBMITTER,
  }, SUBMITTER, REG);
  assert.equal(r.space_key, "local__user2");
  const card = cardOf(truth, "local__user2");
  assert.match(card, /^folder: repo1-test\/cao$/m);
  const yaml = readFileSync(join(truth, "spaces", "local__user2", "space.yaml"), "utf8");
  assert.match(yaml, /type: local/);
  assert.match(yaml, /person: user2/);
});

test("ingest: 无 remote（纯本地）→ local__<person>", async () => {
  const truth = freshTruth();
  const r = await ingest(truth, {
    id: "s3", raw: RAW, tool: "claude-code", branch: "no-branch",
    remote: null, folder: "scratch/notes", producer: SUBMITTER,
  }, SUBMITTER, REG);
  assert.equal(r.space_key, "local__user2");
  assert.match(cardOf(truth, "local__user2"), /^folder: scratch\/notes$/m);
});

test("ingest: session-history-md → 保留 md 正文派生卡片", async () => {
  const truth = freshTruth();
  const raw = [
    JSON.stringify({
      type: "session_history_meta",
      timestamp: "2026-06-13T10:00:00.000Z",
      updated: "2026-06-13T10:02:00.000Z",
      cwd: "/work/repo",
      branch: "main",
      filename: "daily.md",
    }),
    JSON.stringify({
      type: "session_history_markdown",
      timestamp: "2026-06-13T10:02:00.000Z",
      content: "# Daily\n\n- 完成 md session_history 采集\n- 继续验证上传",
    }),
  ].join("\n");
  const r = await ingest(truth, {
    id: "md1", raw, tool: "session-history-md", branch: "main",
    remote: null, folder: "repo/session_history", producer: SUBMITTER,
  }, SUBMITTER, REG);
  assert.equal(r.space_key, "local__user2");
  const card = cardOf(truth, "local__user2");
  assert.match(card, /tool: session-history-md/);
  assert.match(card, /# Daily/);
  assert.match(card, /完成 md session_history 采集/);
});

test("ingest: 同 session 换分支 → 删旧坐标副本（孤儿清理，不留双份）", async () => {
  const truth = freshTruth();
  const common = {
    id: "smv", raw: RAW, tool: "claude-code",
    remote: { host: "github.com", owner: "olduser1", repo: "repo1" }, producer: SUBMITTER,
  };
  await ingest(truth, { ...common, branch: "feat/a" }, SUBMITTER, REG);
  const r2 = await ingest(truth, { ...common, branch: "feat/b" }, SUBMITTER, REG);
  assert.equal(r2.pruned, 2);   // 旧分支的 .jsonl + .md 被删
  const sd = join(truth, "spaces", "github__olduser1__repo1", "sessions");
  assert.equal(readdirSync(join(sd, "feat-a")).length, 0);   // 旧坐标已清空（无双份）
  assert.deepEqual(readdirSync(join(sd, "feat-b")).sort(), ["user2-smv.jsonl", "user2-smv.md"]);
});
