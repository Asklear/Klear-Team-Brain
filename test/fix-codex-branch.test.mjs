import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { fixCodexBranch } from "../scripts/fix-codex-branch.mjs";

// 造一条 codex session：原文 session_meta.git.branch = 真实分支，但落在错误的分支目录里。
function putCodex(spacesDir, space, wrongBranch, pid, id, realBranch) {
  const d = join(spacesDir, space, "sessions", wrongBranch);
  mkdirSync(d, { recursive: true });
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { cwd: "/w/repo", git: { branch: realBranch, repository_url: "git@github.com:o/r.git" } },
  });
  const msg = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "干活" } });
  writeFileSync(join(d, `${pid}-${id}.jsonl`), `${meta}\n${msg}\n`);
  writeFileSync(join(d, `${pid}-${id}.md`),
    `---\nid: ${id}\ntool: codex\nproducer_id: ${pid}\nspace_key: ${space}\nbranch: ${wrongBranch}\n---\n# 干活\n`);
}

function buildTruth() {
  const truth = mkdtempSync(join(tmpdir(), "tb-fcb-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 错标在 main，真实分支 etl/node-first-on-spec022（带斜杠 → 目录用连字符）
  putCodex(s, "github__Asklear__repo1", "main", "user1", "rollout-1", "etl/node-first-on-spec022");
  // 已在正确分支目录 → 不应动
  putCodex(s, "github__Asklear__repo1", "feat-x", "user1", "rollout-2", "feat-x");
  // 旧 rollout 无 git 块 → 分支不可恢复，保持原样
  const d = join(s, "github__Asklear__repo1", "sessions", "main");
  writeFileSync(join(d, "user1-rollout-old.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: "/w/repo" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } })}\n`);
  writeFileSync(join(d, "user1-rollout-old.md"), `---\nid: old\ntool: codex\nbranch: main\n---\n# x\n`);
  // CC session（每行记分支）在 main → 不是 codex，跳过不动
  writeFileSync(join(d, "user2-cc1.jsonl"), `${JSON.stringify({ type: "user", cwd: "/w", gitBranch: "main", message: { content: "hi" } })}\n`);
  writeFileSync(join(d, "user2-cc1.md"), `---\nid: cc1\ntool: claude-code\nbranch: main\n---\n# x\n`);
  return truth;
}

test("fix-codex-branch: 按原文真实分支重分桶 + 重写卡片", () => {
  const truth = buildTruth();
  const s = join(truth, "spaces", "github__Asklear__repo1", "sessions");
  const r = fixCodexBranch(truth, { apply: true });

  // rollout-1 从 main 挪到 etl-node-first-on-spec022
  const dst = join(s, "etl-node-first-on-spec022");
  assert.ok(existsSync(join(dst, "user1-rollout-1.jsonl")), "原文应移到正确分支目录");
  assert.ok(existsSync(join(dst, "user1-rollout-1.md")));
  assert.ok(!existsSync(join(s, "main", "user1-rollout-1.jsonl")), "源应被移走");
  // 卡片 branch 字段重写成真实分支（保留斜杠原值）
  const card = readFileSync(join(dst, "user1-rollout-1.md"), "utf8");
  assert.match(card, /^branch: etl\/node-first-on-spec022$/m);

  // rollout-2 已在正确目录 → 不动
  assert.ok(existsSync(join(s, "feat-x", "user1-rollout-2.jsonl")));
  // 旧无 git 块的、CC 的 → 留在 main
  assert.ok(existsSync(join(s, "main", "user1-rollout-old.jsonl")), "无 git 块的旧 rollout 保持原样");
  assert.ok(existsSync(join(s, "main", "user2-cc1.jsonl")), "CC session 不受影响");

  assert.equal(r.moved, 1);
  assert.equal(r.skipped.length, 1);
});

test("fix-codex-branch: dry-run 不动盘", () => {
  const truth = buildTruth();
  const s = join(truth, "spaces", "github__Asklear__repo1", "sessions");
  const r = fixCodexBranch(truth, { apply: false });
  assert.ok(existsSync(join(s, "main", "user1-rollout-1.jsonl")), "dry-run 不应移动");
  assert.ok(!existsSync(join(s, "etl-node-first-on-spec022")), "dry-run 不应建目录");
  assert.equal(r.moved, 1, "仍报告将移动 1 条");
});
