import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceKey, canonicalSpaceKey, canonicalizePath, canonicalizeSubject,
  resolveAuthorQuery, authorMatches,
} from "../core/identity.mjs";

const REG = {
  github: { orgs: [], repos: [] },
  moved: [
    { from: "haurhi/finance_qa", to: "Asklear/finance_qa" },
    { from: "coldestlin/bossa", to: "Asklear/bossa" },
  ],
};
const ROSTER = { members: [{ id: "tqt", name: "taoqitian", git_names: ["taoqitian", "tqt"] }] };

test("parseSpaceKey: 含下划线的 repo 不被切坏", () => {
  assert.deepEqual(parseSpaceKey("github__Asklear__finance_qa"), { owner: "Asklear", repo: "finance_qa" });
  assert.equal(parseSpaceKey("local__hank"), null);          // 非 github 无 owner/repo
});

test("canonicalSpaceKey: 历史/别名 owner 映射到现位置", () => {
  assert.equal(canonicalSpaceKey(REG, "github__haurhi__finance_qa"), "github__Asklear__finance_qa");
  assert.equal(canonicalSpaceKey(REG, "github__coldestlin__bossa"), "github__Asklear__bossa");
  // 已是 canonical / 无映射 / 非 github → 原样
  assert.equal(canonicalSpaceKey(REG, "github__Asklear__finance_qa"), "github__Asklear__finance_qa");
  assert.equal(canonicalSpaceKey(REG, "local__tqt"), "local__tqt");
});

test("canonicalizePath: 只改 space 段，其余原样", () => {
  assert.equal(
    canonicalizePath(REG, "spaces/github__haurhi__finance_qa/sessions/main/tqt-x.md"),
    "spaces/github__Asklear__finance_qa/sessions/main/tqt-x.md"
  );
  assert.equal(canonicalizePath(REG, "spaces"), "spaces");     // 顶层不崩
});

test("canonicalizeSubject: log 坐标里的 space_key 就地归一", () => {
  assert.equal(
    canonicalizeSubject(REG, "ingest github__haurhi__finance_qa/main/tqt-rollout-2026-06-01"),
    "ingest github__Asklear__finance_qa/main/tqt-rollout-2026-06-01"
  );
});

test("resolveAuthorQuery + authorMatches: tqt 与 taoqitian 等价、命中同一条", () => {
  const byPid = resolveAuthorQuery(ROSTER, "tqt");
  const byGit = resolveAuthorQuery(ROSTER, "taoqitian");
  // 两个查询解析到同一 accept 集（同一身份）
  assert.deepEqual([...byPid.accept].sort(), [...byGit.accept].sort());
  const rec = { producerId: "tqt", author: "taoqitian" };
  assert.equal(authorMatches(byPid, rec), true);
  assert.equal(authorMatches(byGit, rec), true);
  // 别人不命中
  assert.equal(authorMatches(byPid, { producerId: "hank", author: "hankyuan" }), false);
});

test("authorMatches: 不在花名册的名字走子串兜底", () => {
  const r = resolveAuthorQuery(ROSTER, "rongvc");
  assert.equal(r.fallback, true);
  assert.equal(authorMatches(r, { producerId: "rongvc", author: "gaorongvc" }), true);
});
