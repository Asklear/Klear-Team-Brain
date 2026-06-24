import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { findTruth } from "../server/query.mjs";

// 起一个临时 git 仓，铺几个文件并 git add（git ls-files 列已暂存的即可，不必 commit）
function gitTruth(files) {
  const dir = mkdtempSync(join(tmpdir(), "tb-find-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  for (const rel of files) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x");
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

const TRUTH = gitTruth([
  "spaces/github__o__r/sessions/main/user2-s1.md",
  "spaces/github__o__r/sessions/main/user2-s1.jsonl",
  "spaces/local__user2/sessions/no-branch/user2-s2.md",
  "spaces/local__user2/sessions/no-branch/lin-s3.md",
]);

test("findTruth: 按扩展名 glob", async () => {
  const r = await findTruth(TRUTH, { name: "*.jsonl" });
  assert.deepEqual(r.files, ["spaces/github__o__r/sessions/main/user2-s1.jsonl"]);
  const md = await findTruth(TRUTH, { name: "*.md" });
  assert.equal(md.files.length, 3);
});

test("findTruth: 按文件名前缀 glob", async () => {
  const r = await findTruth(TRUTH, { name: "user2-s2*" });
  assert.deepEqual(r.files, ["spaces/local__user2/sessions/no-branch/user2-s2.md"]);
});

test("findTruth: path 限定子目录", async () => {
  const r = await findTruth(TRUTH, { path: "spaces/local__user2", name: "*.md" });
  assert.equal(r.files.length, 2);
  assert.ok(r.files.every((f) => f.startsWith("spaces/local__user2/")));
});

test("findTruth: name 含路径分隔符被拒（防穿越/越权）", async () => {
  await assert.rejects(() => findTruth(TRUTH, { name: "../etc/passwd" }), /bad name/);
});

test("findTruth: path 越出 TRUTH 被拒", async () => {
  await assert.rejects(() => findTruth(TRUTH, { path: "../.." }), /unsafe/);
});

test("findTruth: limit 截断标记", async () => {
  const r = await findTruth(TRUTH, { name: "*.md", limit: 2 });
  assert.equal(r.files.length, 2);
  assert.equal(r.truncated, true);
});
