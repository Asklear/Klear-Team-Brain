import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { slimExisting } from "../scripts/slim-existing.mjs";

function put(spacesDir, space, branch, base, jsonl) {
  const d = join(spacesDir, space, "sessions", branch);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${base}.jsonl`), jsonl);
  writeFileSync(join(d, `${base}.md`), `---\nid: ${base}\nbranch: ${branch}\n---\n# x\n`);
}

function build() {
  const truth = mkdtempSync(join(tmpdir(), "tb-slimx-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 肥文件：含内联图片 base64
  const img = "data:image/png;base64," + "A".repeat(400000);
  put(s, "github__Asklear__bossa", "main", "tqt-fat",
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `图 ${img}` } }) + "\n");
  // 干净文件：无 bloat → 应字节不动
  put(s, "github__Asklear__bossa", "main", "hank-clean",
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "改个小 bug" } }) + "\n");
  return truth;
}

test("slim-existing: 只蒸馏肥文件，干净文件字节不动", () => {
  const truth = build();
  const s = join(truth, "spaces", "github__Asklear__bossa", "sessions", "main");
  const fatBefore = readFileSync(join(s, "tqt-fat.jsonl"), "utf8");
  const cleanBefore = readFileSync(join(s, "hank-clean.jsonl"), "utf8");

  const r = slimExisting(truth, { apply: true });

  assert.equal(r.changed.length, 1, "只动 1 个肥文件");
  const fatAfter = readFileSync(join(s, "tqt-fat.jsonl"), "utf8");
  assert.ok(fatAfter.length < fatBefore.length / 100, "肥文件被大幅压缩");
  assert.match(fatAfter, /image \d+KB omitted/);
  // 干净文件字节完全不变
  assert.equal(readFileSync(join(s, "hank-clean.jsonl"), "utf8"), cleanBefore, "干净文件字节不动");
  // 卡片不动
  assert.ok(existsSync(join(s, "tqt-fat.md")));
});

test("slim-existing: 幂等 —— 二次跑无改动", () => {
  const truth = build();
  slimExisting(truth, { apply: true });
  const r2 = slimExisting(truth, { apply: true });
  assert.equal(r2.changed.length, 0, "已蒸馏过 → 二次跑不再触发");
});

test("slim-existing: dry-run 不写盘", () => {
  const truth = build();
  const s = join(truth, "spaces", "github__Asklear__bossa", "sessions", "main");
  const before = readFileSync(join(s, "tqt-fat.jsonl"), "utf8");
  const r = slimExisting(truth, { apply: false });
  assert.equal(r.changed.length, 1, "报告将动 1 个");
  assert.equal(readFileSync(join(s, "tqt-fat.jsonl"), "utf8"), before, "dry-run 不改盘");
});
