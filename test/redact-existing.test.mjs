import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { redactExisting } from "../scripts/redact-existing.mjs";

function put(spacesDir, space, branch, base, jsonl) {
  const d = join(spacesDir, space, "sessions", branch);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${base}.jsonl`), jsonl);
}

function build() {
  const truth = mkdtempSync(join(tmpdir(), "tb-redactx-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 含密钥的文件
  put(s, "github__Asklear__bossa", "main", "hank-secret",
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }) + "\n" +
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text",
      text: "key 是 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789，OPENAI_API_KEY=plainsecretvalue123" }] } }) + "\n");
  // 干净文件 → 应字节不动
  put(s, "github__Asklear__bossa", "main", "hank-clean",
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "改个小 bug" }] } }) + "\n");
  return truth;
}

test("redact-existing: 抹掉密钥、且每行仍是合法 JSON", () => {
  const truth = build();
  const s = join(truth, "spaces", "github__Asklear__bossa", "sessions", "main");
  const cleanBefore = readFileSync(join(s, "hank-clean.jsonl"), "utf8");

  const r = redactExisting(truth, { apply: true });

  assert.equal(r.changed.length, 1, "只动含密钥的 1 个文件");
  const after = readFileSync(join(s, "hank-secret.jsonl"), "utf8");
  assert.doesNotMatch(after, /ghp_ABCDEF/, "GitHub PAT 抹掉");
  assert.doesNotMatch(after, /plainsecretvalue123/, "赋值式值抹掉");
  assert.match(after, /REDACTED/, "出现占位符");
  for (const line of after.split("\n")) if (line.trim()) JSON.parse(line);   // 结构未破坏
  // 干净文件字节完全不变
  assert.equal(readFileSync(join(s, "hank-clean.jsonl"), "utf8"), cleanBefore, "干净文件字节不动");
});

test("redact-existing: 幂等 —— 二次跑无改动", () => {
  const truth = build();
  redactExisting(truth, { apply: true });
  const r2 = redactExisting(truth, { apply: true });
  assert.equal(r2.changed.length, 0, "已脱敏过 → 二次跑不再触发");
});

test("redact-existing: dry-run 不写盘", () => {
  const truth = build();
  const s = join(truth, "spaces", "github__Asklear__bossa", "sessions", "main");
  const before = readFileSync(join(s, "hank-secret.jsonl"), "utf8");
  const r = redactExisting(truth, { apply: false });
  assert.equal(r.changed.length, 1, "报告将动 1 个");
  assert.equal(readFileSync(join(s, "hank-secret.jsonl"), "utf8"), before, "dry-run 不改盘");
});
